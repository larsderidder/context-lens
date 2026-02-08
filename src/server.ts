#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';
import url from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  estimateTokens, detectProvider, detectApiFormat,
  parseContextInfo, getContextLimit, extractSource, resolveTargetUrl,
  extractReadableText, extractWorkingDirectory, extractUserPrompt, extractSessionId,
  computeAgentKey, computeFingerprint, extractConversationLabel, detectSource,
  estimateCost,
} from './core.js';

import type {
  ContextInfo, Conversation, CapturedEntry, ResponseData, Upstreams, RequestMeta,
} from './types.js';

import { analyzeComposition, parseResponseUsage, buildLharRecord, buildSessionLine, toLharJsonl, toLharJson } from './lhar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Upstream targets — configurable via env vars
const UPSTREAM_OPENAI_URL = process.env.UPSTREAM_OPENAI_URL || 'https://api.openai.com/v1';
const UPSTREAM_ANTHROPIC_URL = process.env.UPSTREAM_ANTHROPIC_URL || 'https://api.anthropic.com';
const UPSTREAM_CHATGPT_URL = process.env.UPSTREAM_CHATGPT_URL || 'https://chatgpt.com';

// In-memory storage for captured requests (last 100)
const capturedRequests: CapturedEntry[] = [];
const MAX_STORED = 100;
let dataRevision = 0; // Monotonic counter, incremented on every store
let nextEntryId = 1; // Integer counter for entry IDs (fix float collision)

// Conversation threading — group requests by fingerprint
const conversations = new Map<string, Conversation>(); // fingerprint -> { id, label, source, firstSeen }
// Responses API chaining: response_id -> conversationId
const responseIdToConvo = new Map<string, string>();

// Disk logging — one LHAR file per session/conversation
const DATA_DIR = path.join(__dirname, '..', 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// Track which conversations already have a session preamble on disk
const diskSessionsWritten = new Set<string>();

function logToDisk(entry: CapturedEntry): void {
  const filename = entry.conversationId
    ? `${entry.source}-${entry.conversationId}.lhar`
    : 'ungrouped.lhar';
  const filePath = path.join(DATA_DIR, filename);

  let output = '';

  // Write session preamble on first entry for this conversation
  if (entry.conversationId && !diskSessionsWritten.has(entry.conversationId)) {
    diskSessionsWritten.add(entry.conversationId);
    const convo = conversations.get(entry.conversationId);
    if (convo) {
      const sessionLine = buildSessionLine(entry.conversationId, convo, entry.contextInfo.model);
      output += JSON.stringify(sessionLine) + '\n';
    }
  }

  const record = buildLharRecord(entry, capturedRequests);
  output += JSON.stringify(record) + '\n';

  fs.appendFile(filePath, output, err => { if (err) console.error('Log write error:', err.message); });
}

// Store captured request
function storeRequest(
  contextInfo: ContextInfo,
  responseData: ResponseData,
  source: string | null,
  rawBody?: Record<string, any>,
  meta?: RequestMeta,
): CapturedEntry {
  const resolvedSource = detectSource(contextInfo, source);
  const fingerprint = computeFingerprint(contextInfo, rawBody ?? null, responseIdToConvo);

  // Register or look up conversation
  let conversationId: string | null = null;
  if (fingerprint) {
    if (!conversations.has(fingerprint)) {
      conversations.set(fingerprint, {
        id: fingerprint,
        label: extractConversationLabel(contextInfo),
        source: resolvedSource || 'unknown',
        workingDirectory: extractWorkingDirectory(contextInfo),
        firstSeen: new Date().toISOString(),
      });
    } else if (!conversations.get(fingerprint)!.workingDirectory) {
      // Backfill if first request didn't have it
      const wd = extractWorkingDirectory(contextInfo);
      if (wd) conversations.get(fingerprint)!.workingDirectory = wd;
    }
    conversationId = fingerprint;
  }

  // Agent key: distinguishes agents within a session (main vs subagents)
  const agentKey = computeAgentKey(contextInfo);
  const agentLabel = extractConversationLabel(contextInfo);

  // Compute composition and cost
  const composition = analyzeComposition(contextInfo, rawBody);
  const usage = parseResponseUsage(responseData);
  const inputTok = usage.inputTokens || contextInfo.totalTokens;
  const outputTok = usage.outputTokens;
  const costUsd = estimateCost(contextInfo.model, inputTok, outputTok);

  const entry: CapturedEntry = {
    id: nextEntryId++,
    timestamp: new Date().toISOString(),
    contextInfo,
    response: responseData,
    contextLimit: getContextLimit(contextInfo.model),
    source: resolvedSource || 'unknown',
    conversationId,
    agentKey,
    agentLabel,
    httpStatus: meta?.httpStatus ?? null,
    timings: meta?.timings ?? null,
    requestBytes: meta?.requestBytes ?? 0,
    responseBytes: meta?.responseBytes ?? 0,
    targetUrl: meta?.targetUrl ?? null,
    requestHeaders: meta?.requestHeaders ?? {},
    responseHeaders: meta?.responseHeaders ?? {},
    rawBody,
    composition,
    costUsd,
  };

  // Track response IDs for Responses API chaining
  const respId = (responseData as Record<string, any>).id || (responseData as Record<string, any>).response_id;
  if (respId && conversationId) {
    responseIdToConvo.set(respId, conversationId);
  }

  capturedRequests.unshift(entry);
  if (capturedRequests.length > MAX_STORED) {
    const evicted = capturedRequests.pop()!;
    // Clean up orphaned conversation keys
    if (evicted.conversationId) {
      const stillReferenced = capturedRequests.some(r => r.conversationId === evicted.conversationId);
      if (!stillReferenced) {
        conversations.delete(evicted.conversationId);
        diskSessionsWritten.delete(evicted.conversationId);
        // Clean up responseIdToConvo entries for this conversation
        for (const [rid, cid] of responseIdToConvo) {
          if (cid === evicted.conversationId) responseIdToConvo.delete(rid);
        }
      }
    }
  }

  dataRevision++;
  logToDisk(entry);
  return entry;
}

// Upstream config for resolveTargetUrl
const UPSTREAMS: Upstreams = {
  openai: UPSTREAM_OPENAI_URL,
  anthropic: UPSTREAM_ANTHROPIC_URL,
  chatgpt: UPSTREAM_CHATGPT_URL,
};

// Forward a request upstream (no body capture)
function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: url.UrlWithStringQuery,
  body: Buffer | null,
): void {
  const { targetUrl } = resolveTargetUrl(
    { pathname: parsedUrl.pathname!, search: parsedUrl.search },
    req.headers as Record<string, string | undefined>,
    UPSTREAMS,
  );
  const targetParsed = url.parse(targetUrl);

  const forwardHeaders = { ...req.headers } as Record<string, any>;
  delete forwardHeaders['x-target-url'];
  delete forwardHeaders['host'];
  forwardHeaders['host'] = targetParsed.host;
  // When we buffer the body, replace chunked encoding with exact content-length
  if (body) {
    delete forwardHeaders['transfer-encoding'];
    forwardHeaders['content-length'] = body.length;
  }

  const protocol = targetParsed.protocol === 'https:' ? https : http;
  const proxyReq = protocol.request({
    hostname: targetParsed.hostname,
    port: targetParsed.port,
    path: targetParsed.path,
    method: req.method,
    headers: forwardHeaders,
  }, (proxyRes) => {
    if (!res.headersSent) res.writeHead(proxyRes.statusCode!, proxyRes.headers);
    proxyRes.pipe(res);
    proxyRes.on('error', (err) => {
      console.error('Upstream response error (forward):', err.message);
      if (!res.destroyed) res.end();
    });
  });

  // Abort upstream request if client disconnects
  res.on('close', () => { if (!proxyReq.destroyed) proxyReq.destroy(); });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    if (!res.destroyed) {
      res.end(JSON.stringify({ error: 'Proxy error', details: err.message }));
    }
  });

  if (body) proxyReq.write(body);
  proxyReq.end();
}

// Headers to exclude from capture (auth/sensitive)
const REDACTED_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie', 'x-target-url']);

function selectHeaders(headers: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (REDACTED_HEADERS.has(key.toLowerCase())) continue;
    if (typeof val === 'string') result[key] = val;
  }
  return result;
}

// Proxy handler
function handleProxy(req: http.IncomingMessage, res: http.ServerResponse): void {
  const parsedUrl = url.parse(req.url!);
  const { source, cleanPath } = extractSource(parsedUrl.pathname!);

  // Use clean path (without source prefix) for routing
  const cleanUrl = { ...parsedUrl, pathname: cleanPath };
  const { targetUrl, provider } = resolveTargetUrl(
    { pathname: cleanPath, search: parsedUrl.search },
    req.headers as Record<string, string | undefined>,
    UPSTREAMS,
  );
  const hasAuth = !!req.headers['authorization'];
  const sourceTag = source ? `[${source}]` : '';
  console.log(`${req.method} ${req.url} → ${targetUrl} [${provider}] ${sourceTag} auth=${hasAuth}`);

  // For non-POST requests (GET /v1/models, OPTIONS, etc.), pass through directly
  if (req.method !== 'POST') {
    return forwardRequest(req, res, cleanUrl as url.UrlWithStringQuery, null);
  }

  // Collect body as raw Buffers to avoid corrupting multi-byte UTF-8 at chunk boundaries
  const chunks: Buffer[] = [];
  let clientAborted = false;
  req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  req.on('error', () => { clientAborted = true; });

  req.on('end', () => {
    if (clientAborted) return;

    const bodyBuffer = Buffer.concat(chunks);
    const body = bodyBuffer.toString('utf8');

    let bodyData: Record<string, any>;
    try {
      bodyData = JSON.parse(body);
    } catch (e) {
      console.log(`  ⚠ Body is not JSON (${bodyBuffer.length} bytes), capturing raw`);
      // Still capture the raw request even if body isn't JSON
      const rawInfo: ContextInfo = {
        provider,
        apiFormat: 'raw',
        model: 'unknown',
        systemTokens: 0, toolsTokens: 0,
        messagesTokens: estimateTokens(body),
        totalTokens: estimateTokens(body),
        systemPrompts: [],
        tools: [],
        messages: [{ role: 'raw', content: body.substring(0, 2000), tokens: estimateTokens(body) }],
      };
      storeRequest(rawInfo, { raw: true }, source);
      return forwardRequest(req, res, cleanUrl as url.UrlWithStringQuery, bodyBuffer);
    }

    console.log(`  ✓ Parsed JSON body (${Object.keys(bodyData).join(', ')})`);
    const apiFormat = detectApiFormat(cleanPath);
    const contextInfo = parseContextInfo(provider, bodyData, apiFormat);

    const targetParsed = url.parse(targetUrl);

    // Forward headers (remove proxy-specific ones)
    const forwardHeaders = { ...req.headers } as Record<string, any>;
    delete forwardHeaders['x-target-url'];
    delete forwardHeaders['host'];
    delete forwardHeaders['transfer-encoding'];
    forwardHeaders['host'] = targetParsed.host;
    // Ensure content-length matches the exact bytes we forward
    forwardHeaders['content-length'] = bodyBuffer.length;

    // Make request to actual API
    const protocol = targetParsed.protocol === 'https:' ? https : http;
    const startTime = performance.now();
    let firstByteTime = 0;
    const reqBytes = bodyBuffer.length;

    const proxyReq = protocol.request({
      hostname: targetParsed.hostname,
      port: targetParsed.port,
      path: targetParsed.path,
      method: req.method,
      headers: forwardHeaders,
    }, (proxyRes) => {
      console.log(`  ← ${proxyRes.statusCode} ${proxyRes.statusMessage}`);
      // Forward response headers
      res.writeHead(proxyRes.statusCode!, proxyRes.headers);
      const httpStatus = proxyRes.statusCode || 0;

      // Handle streaming vs non-streaming
      const isStreaming = proxyRes.headers['content-type']?.includes('text/event-stream');
      let respBytes = 0;

      const capturedReqHeaders = selectHeaders(req.headers);
      const capturedResHeaders = selectHeaders(proxyRes.headers as Record<string, any>);

      // Collect response as Buffer[] to avoid corrupting multi-byte UTF-8 at chunk boundaries
      const respChunks: Buffer[] = [];

      proxyRes.on('data', (chunk: Buffer) => {
        if (!firstByteTime) firstByteTime = performance.now();
        respBytes += chunk.length;
        respChunks.push(chunk);
        if (!res.destroyed) res.write(chunk);
      });

      proxyRes.on('end', () => {
        const endTime = performance.now();
        if (!firstByteTime) firstByteTime = endTime;
        const meta: RequestMeta = {
          httpStatus,
          timings: {
            send_ms: Math.round(firstByteTime - startTime),
            wait_ms: Math.round(firstByteTime - startTime),
            receive_ms: Math.round(endTime - firstByteTime),
            total_ms: Math.round(endTime - startTime),
            tokens_per_second: null,
          },
          requestBytes: reqBytes,
          responseBytes: respBytes,
          targetUrl,
          requestHeaders: capturedReqHeaders,
          responseHeaders: capturedResHeaders,
        };
        const respBody = Buffer.concat(respChunks).toString('utf8');
        if (isStreaming) {
          storeRequest(contextInfo, { streaming: true, chunks: respBody }, source, bodyData, meta);
        } else {
          try {
            const responseData = JSON.parse(respBody);
            storeRequest(contextInfo, responseData, source, bodyData, meta);
          } catch (e) {
            storeRequest(contextInfo, { raw: respBody }, source, bodyData, meta);
          }
        }
        if (!res.destroyed) res.end();
      });

      proxyRes.on('error', (err) => {
        console.error('Upstream response error:', err.message);
        if (!res.destroyed) res.end();
      });
    });

    // Abort upstream request if client disconnects
    res.on('close', () => { if (!proxyReq.destroyed) proxyReq.destroy(); });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      if (!res.destroyed) {
        res.end(JSON.stringify({ error: 'Proxy error', details: err.message }));
      }
    });

    proxyReq.write(bodyBuffer);
    proxyReq.end();
  });
}

// Ingest endpoint — accepts captured data from external tools (e.g. mitmproxy addon)
function handleIngest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  const bodyChunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => { bodyChunks.push(chunk); });
  req.on('end', () => {
    try {
      const data = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
      const provider = data.provider || 'unknown';
      const apiFormat = data.apiFormat || 'unknown';
      const source = data.source || 'unknown';
      const contextInfo = parseContextInfo(provider, data.body || {}, apiFormat);
      storeRequest(contextInfo, data.response || {}, source, data.body || {});
      console.log(`  📥 Ingested: [${provider}] ${contextInfo.model} from ${source}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: any) {
      console.error('Ingest error:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// Load HTML UI from file at startup
const htmlUI = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

// Web UI handler
function handleWebUI(req: http.IncomingMessage, res: http.ServerResponse): void {
  const parsedUrl = url.parse(req.url!, true);

  if (parsedUrl.pathname === '/api/ingest' && req.method === 'POST') {
    return handleIngest(req, res);
  }

  if (parsedUrl.pathname === '/api/requests') {
    // Lightweight projection — strip rawBody, response, and heavy headers from entries
    function projectEntry(e: CapturedEntry) {
      return {
        id: e.id,
        timestamp: e.timestamp,
        contextInfo: e.contextInfo,
        contextLimit: e.contextLimit,
        source: e.source,
        conversationId: e.conversationId,
        agentKey: e.agentKey,
        agentLabel: e.agentLabel,
        httpStatus: e.httpStatus,
        timings: e.timings,
        requestBytes: e.requestBytes,
        responseBytes: e.responseBytes,
        targetUrl: e.targetUrl,
        composition: e.composition,
        costUsd: e.costUsd,
      };
    }
    // API endpoint: group requests by conversation
    const grouped = new Map<string, CapturedEntry[]>(); // conversationId -> entries[]
    const ungrouped: CapturedEntry[] = [];
    for (const entry of capturedRequests) {
      if (entry.conversationId) {
        if (!grouped.has(entry.conversationId)) grouped.set(entry.conversationId, []);
        grouped.get(entry.conversationId)!.push(entry);
      } else {
        ungrouped.push(entry);
      }
    }
    const convos: any[] = [];
    for (const [id, entries] of grouped) {
      const meta = conversations.get(id) || { id, label: 'Unknown', source: 'unknown', firstSeen: entries[entries.length - 1].timestamp };
      // Sub-group entries by agentKey
      const agentMap = new Map<string, CapturedEntry[]>();
      for (const e of entries) {
        const ak = e.agentKey || '_default';
        if (!agentMap.has(ak)) agentMap.set(ak, []);
        agentMap.get(ak)!.push(e);
      }
      const agents: any[] = [];
      for (const [ak, agentEntries] of agentMap) {
        agents.push({
          key: ak,
          label: agentEntries[agentEntries.length - 1].agentLabel || 'Unnamed',
          model: agentEntries[0].contextInfo.model,
          entries: agentEntries.map(projectEntry), // newest-first (inherited from capturedRequests order)
        });
      }
      // Sort agents: most recent activity first
      agents.sort((a: any, b: any) => new Date(b.entries[0].timestamp).getTime() - new Date(a.entries[0].timestamp).getTime());
      convos.push({ ...meta, agents, entries: entries.map(projectEntry) });
    }
    // Sort conversations newest-first (by most recent entry)
    convos.sort((a, b) => new Date(b.entries[0].timestamp).getTime() - new Date(a.entries[0].timestamp).getTime());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revision: dataRevision, conversations: convos, ungrouped: ungrouped.map(projectEntry) }));
  } else if (parsedUrl.pathname === '/api/export/lhar') {
    // Export as JSONL (.lhar)
    const convoFilter = parsedUrl.query.conversation as string | undefined;
    const entries = convoFilter
      ? capturedRequests.filter(e => e.conversationId === convoFilter)
      : capturedRequests;
    const jsonl = toLharJsonl(entries, conversations);
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': 'attachment; filename="context-lens-export.lhar"',
    });
    res.end(jsonl);
  } else if (parsedUrl.pathname === '/api/export/lhar.json') {
    // Export as wrapped JSON (.lhar.json)
    const convoFilter = parsedUrl.query.conversation as string | undefined;
    const entries = convoFilter
      ? capturedRequests.filter(e => e.conversationId === convoFilter)
      : capturedRequests;
    const wrapped = toLharJson(entries, conversations);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="context-lens-export.lhar.json"',
    });
    res.end(JSON.stringify(wrapped, null, 2));
  } else if (parsedUrl.pathname === '/') {
    // Serve HTML UI
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(htmlUI);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

// Start servers
const proxyServer = http.createServer(handleProxy);
const webUIServer = http.createServer(handleWebUI);

proxyServer.listen(4040, () => {
  console.log('🔍 Context Lens Proxy running on http://localhost:4040');
});

webUIServer.listen(4041, () => {
  console.log('🌐 Context Lens Web UI running on http://localhost:4041');
  // Only show verbose help when running standalone (not spawned by cli.js)
  if (!process.env.CONTEXT_LENS_CLI) {
    console.log(`\nUpstream: OpenAI → ${UPSTREAM_OPENAI_URL}`);
    console.log(`         Anthropic → ${UPSTREAM_ANTHROPIC_URL}`);
    console.log('\nUsage:');
    console.log('  Codex (subscription): UPSTREAM_OPENAI_URL=https://chatgpt.com/backend-api/codex node server.js');
    console.log('  Codex (API key):      node server.js');
    console.log('  Then: OPENAI_BASE_URL=http://localhost:4040 codex "your prompt"');
    console.log('  Claude: ANTHROPIC_BASE_URL=http://localhost:4040 claude "your prompt"');
  }
});
