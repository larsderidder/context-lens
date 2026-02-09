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
  ContentBlock,
} from './types.js';

import { analyzeComposition, parseResponseUsage, buildLharRecord, buildSessionLine, toLharJsonl, toLharJson } from './lhar.js';
import { safeFilenamePart, headersForResolution, selectHeaders } from './server-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Upstream targets — configurable via env vars
const UPSTREAM_OPENAI_URL = process.env.UPSTREAM_OPENAI_URL || 'https://api.openai.com/v1';
const UPSTREAM_ANTHROPIC_URL = process.env.UPSTREAM_ANTHROPIC_URL || 'https://api.anthropic.com';
const UPSTREAM_CHATGPT_URL = process.env.UPSTREAM_CHATGPT_URL || 'https://chatgpt.com';

// Safety defaults:
// - Bind only to localhost unless explicitly overridden.
// - Do not honor `x-target-url` unless explicitly enabled (prevents accidental open-proxy/SSRF).
const BIND_HOST = process.env.CONTEXT_LENS_BIND_HOST || '127.0.0.1';
const ALLOW_TARGET_OVERRIDE = process.env.CONTEXT_LENS_ALLOW_TARGET_OVERRIDE === '1';

// In-memory storage for captured requests
const capturedRequests: CapturedEntry[] = [];
const MAX_SESSIONS = 10;
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
  const safeSource = safeFilenamePart(entry.source || 'unknown');
  const safeConvo = entry.conversationId ? safeFilenamePart(entry.conversationId) : null;
  const filename = safeConvo
    ? `${safeSource}-${safeConvo}.lhar`
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

// Compact a content block — keep tool metadata, truncate text
function compactBlock(b: ContentBlock): ContentBlock {
  switch (b.type) {
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: {} };
    case 'tool_result': {
      const rc = typeof b.content === 'string'
        ? b.content.slice(0, 200)
        : Array.isArray(b.content)
          ? b.content.map(compactBlock)
          : '';
      return { type: 'tool_result', tool_use_id: b.tool_use_id, content: rc };
    }
    case 'text':
      return { type: 'text', text: b.text.slice(0, 200) };
    case 'input_text':
      return { type: 'input_text', text: b.text.slice(0, 200) };
    case 'image':
      return { type: 'image' };
    default: {
      // Handle thinking blocks and other unknown types — truncate text-like fields
      const any = b as any;
      if (any.thinking) return { ...any, thinking: any.thinking.slice(0, 200) } as ContentBlock;
      if (any.text) return { ...any, text: any.text.slice(0, 200) } as ContentBlock;
      return b;
    }
  }
}

// Compact contextInfo — keep metadata and token counts, drop large text payloads
function compactContextInfo(ci: ContextInfo) {
  return {
    provider: ci.provider,
    apiFormat: ci.apiFormat,
    model: ci.model,
    systemTokens: ci.systemTokens,
    toolsTokens: ci.toolsTokens,
    messagesTokens: ci.messagesTokens,
    totalTokens: ci.totalTokens,
    systemPrompts: [],
    tools: [],
    messages: ci.messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.slice(0, 200) : '',
      tokens: m.tokens,
      contentBlocks: m.contentBlocks?.map(compactBlock) ?? null,
    })),
  };
}

// Release heavy data from an entry after it's been logged to disk
function compactEntry(entry: CapturedEntry): void {
  // Extract and preserve usage data from response before dropping it
  const usage = parseResponseUsage(entry.response);
  entry.response = {
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      cache_creation_input_tokens: usage.cacheWriteTokens,
    },
    model: usage.model,
    stop_reason: usage.finishReasons[0] || null,
  } as ResponseData;

  entry.rawBody = undefined;
  entry.requestHeaders = {};
  entry.responseHeaders = {};

  // Compact contextInfo in-place
  entry.contextInfo.systemPrompts = [];
  entry.contextInfo.tools = [];
  entry.contextInfo.messages = entry.contextInfo.messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content.slice(0, 200) : '',
    tokens: m.tokens,
    contentBlocks: m.contentBlocks?.map(compactBlock) ?? null,
  }));
}

// Lightweight projection — strip rawBody, heavy headers; compact contextInfo
// NOTE: response is included because compactEntry has already reduced it to just usage data
function projectEntry(e: CapturedEntry) {
  const resp = e.response as Record<string, any> | undefined;
  const usage = resp?.usage;
  return {
    id: e.id,
    timestamp: e.timestamp,
    contextInfo: compactContextInfo(e.contextInfo),
    response: e.response,
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
    usage: usage ? {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheWriteTokens: usage.cache_creation_input_tokens || 0,
    } : null,
    responseModel: resp?.model || null,
    stopReason: resp?.stop_reason || null,
  };
}

// State persistence — full rewrite to data/state.jsonl after every storeRequest()
const STATE_FILE = path.join(DATA_DIR, 'state.jsonl');

function saveState(): void {
  let lines = '';
  for (const [, convo] of conversations) {
    lines += JSON.stringify({ type: 'conversation', data: convo }) + '\n';
  }
  for (const entry of capturedRequests) {
    lines += JSON.stringify({ type: 'entry', data: projectEntry(entry) }) + '\n';
  }
  try {
    fs.writeFileSync(STATE_FILE, lines);
  } catch (err: any) {
    console.error('State save error:', err.message);
  }
}

function loadState(): void {
  let content: string;
  try {
    content = fs.readFileSync(STATE_FILE, 'utf8');
  } catch {
    return; // No state file — fresh start
  }
  const lines = content.split('\n').filter(l => l.length > 0);
  let loadedEntries = 0;
  let maxId = 0;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.type === 'conversation') {
        const c = record.data as Conversation;
        conversations.set(c.id, c);
        diskSessionsWritten.add(c.id);
      } else if (record.type === 'entry') {
        const projected = record.data;
        const entry: CapturedEntry = {
          ...projected,
          response: projected.response || { raw: true },
          requestHeaders: {},
          responseHeaders: {},
          rawBody: undefined,
        };
        capturedRequests.push(entry);
        if (entry.id > maxId) maxId = entry.id;
        loadedEntries++;
      }
    } catch (err: any) {
      console.error('State parse error:', err.message);
    }
  }
  if (loadedEntries > 0) {
    nextEntryId = maxId + 1;
    dataRevision = 1;
    // Loaded entries are already compact (projectEntry strips heavy data before saving).
    // Do NOT call compactEntry here — it would destroy the preserved response usage data.
    console.log(`Restored ${loadedEntries} entries from ${conversations.size} conversations`);
  }
}

// Store captured request
function storeRequest(
  contextInfo: ContextInfo,
  responseData: ResponseData,
  source: string | null,
  rawBody?: Record<string, any>,
  meta?: RequestMeta,
  requestHeaders?: Record<string, string>,
): CapturedEntry {
  const resolvedSource = detectSource(contextInfo, source, requestHeaders);
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
    } else {
      const convo = conversations.get(fingerprint)!;
      // Backfill source if first request couldn't detect it
      if (convo.source === 'unknown' && resolvedSource && resolvedSource !== 'unknown') {
        convo.source = resolvedSource;
      }
      // Backfill working directory if first request didn't have it
      if (!convo.workingDirectory) {
        const wd = extractWorkingDirectory(contextInfo);
        if (wd) convo.workingDirectory = wd;
      }
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

  // Evict oldest sessions when we exceed the session limit
  if (conversations.size > MAX_SESSIONS) {
    // Find the oldest session by its most recent entry timestamp
    const sessionLatest = new Map<string, number>();
    for (const r of capturedRequests) {
      if (r.conversationId) {
        const t = new Date(r.timestamp).getTime();
        const cur = sessionLatest.get(r.conversationId) || 0;
        if (t > cur) sessionLatest.set(r.conversationId, t);
      }
    }
    // Sort sessions oldest-first, evict until we're at the limit
    const sorted = [...sessionLatest.entries()].sort((a, b) => a[1] - b[1]);
    const toEvict = sorted.slice(0, sorted.length - MAX_SESSIONS).map(s => s[0]);
    const evictSet = new Set(toEvict);
    // Remove all entries belonging to evicted sessions
    for (let i = capturedRequests.length - 1; i >= 0; i--) {
      if (capturedRequests[i].conversationId && evictSet.has(capturedRequests[i].conversationId!)) {
        capturedRequests.splice(i, 1);
      }
    }
    for (const cid of toEvict) {
      conversations.delete(cid);
      diskSessionsWritten.delete(cid);
      for (const [rid, rcid] of responseIdToConvo) {
        if (rcid === cid) responseIdToConvo.delete(rid);
      }
    }
  }

  dataRevision++;
  logToDisk(entry);
  compactEntry(entry);
  saveState();
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
    headersForResolution(req.headers, req.socket.remoteAddress, ALLOW_TARGET_OVERRIDE),
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
    // Suppress errors from client-initiated disconnects
    if (res.destroyed) return;
    console.error('Proxy error:', err.message || (err as any).code || 'unknown');
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

// Proxy handler
function handleProxy(req: http.IncomingMessage, res: http.ServerResponse): void {
  const parsedUrl = url.parse(req.url!);
  const { source, cleanPath } = extractSource(parsedUrl.pathname!);

  // Use clean path (without source prefix) for routing
  const cleanUrl = { ...parsedUrl, pathname: cleanPath };
  const { targetUrl, provider } = resolveTargetUrl(
    { pathname: cleanPath, search: parsedUrl.search },
    headersForResolution(req.headers, req.socket.remoteAddress, ALLOW_TARGET_OVERRIDE),
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
      storeRequest(rawInfo, { raw: true }, source, undefined, undefined, selectHeaders(req.headers));
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
          storeRequest(contextInfo, { streaming: true, chunks: respBody }, source, bodyData, meta, capturedReqHeaders);
        } else {
          try {
            const responseData = JSON.parse(respBody);
            storeRequest(contextInfo, responseData, source, bodyData, meta, capturedReqHeaders);
          } catch (e) {
            storeRequest(contextInfo, { raw: respBody }, source, bodyData, meta, capturedReqHeaders);
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
      // Suppress errors from client-initiated disconnects
      if (res.destroyed) return;
      console.error('Proxy error:', err.message || (err as any).code || 'unknown');
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

  // DELETE /api/conversations/:id — delete one session
  const convoDeleteMatch = parsedUrl.pathname?.match(/^\/api\/conversations\/(.+)$/);
  if (convoDeleteMatch && req.method === 'DELETE') {
    const convoId = decodeURIComponent(convoDeleteMatch[1]);
    conversations.delete(convoId);
    // Remove entries belonging to this conversation
    for (let i = capturedRequests.length - 1; i >= 0; i--) {
      if (capturedRequests[i].conversationId === convoId) capturedRequests.splice(i, 1);
    }
    diskSessionsWritten.delete(convoId);
    for (const [rid, cid] of responseIdToConvo) {
      if (cid === convoId) responseIdToConvo.delete(rid);
    }
    dataRevision++;
    saveState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/reset — reset all data
  if (parsedUrl.pathname === '/api/reset' && req.method === 'POST') {
    capturedRequests.length = 0;
    conversations.clear();
    diskSessionsWritten.clear();
    responseIdToConvo.clear();
    nextEntryId = 1;
    dataRevision++;
    saveState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (parsedUrl.pathname === '/api/requests') {
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
loadState();
const proxyServer = http.createServer(handleProxy);
const webUIServer = http.createServer(handleWebUI);

proxyServer.listen(4040, BIND_HOST, () => {
  console.log(`🔍 Context Lens Proxy running on http://${BIND_HOST}:4040`);
});

webUIServer.listen(4041, BIND_HOST, () => {
  console.log(`🌐 Context Lens Web UI running on http://${BIND_HOST}:4041`);
  // Only show verbose help when running standalone (not spawned by cli.js)
  if (!process.env.CONTEXT_LENS_CLI) {
    console.log(`\nUpstream: OpenAI → ${UPSTREAM_OPENAI_URL}`);
    console.log(`         Anthropic → ${UPSTREAM_ANTHROPIC_URL}`);
    console.log('\nUsage:');
    console.log('  Codex (subscription): UPSTREAM_OPENAI_URL=https://chatgpt.com/backend-api/codex node server.js');
    console.log('  Codex (API key):      node server.js');
    console.log('  Then: OPENAI_BASE_URL=http://localhost:4040 codex "your prompt"');
    console.log('  Claude: ANTHROPIC_BASE_URL=http://localhost:4040/claude claude "your prompt"');
  }
});
