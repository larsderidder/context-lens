#!/usr/bin/env node

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const {
  estimateTokens, detectProvider, detectApiFormat,
  parseContextInfo, getContextLimit, extractSource, resolveTargetUrl,
  extractReadableText, extractUserPrompt, extractSessionId,
  computeAgentKey, computeFingerprint, extractConversationLabel, detectSource,
} = require('./lib/core');

// Upstream targets — configurable via env vars
const UPSTREAM_OPENAI_URL = process.env.UPSTREAM_OPENAI_URL || 'https://api.openai.com/v1';
const UPSTREAM_ANTHROPIC_URL = process.env.UPSTREAM_ANTHROPIC_URL || 'https://api.anthropic.com';
const UPSTREAM_CHATGPT_URL = process.env.UPSTREAM_CHATGPT_URL || 'https://chatgpt.com';

// In-memory storage for captured requests (last 100)
const capturedRequests = [];
const MAX_STORED = 100;

// Conversation threading — group requests by fingerprint
const conversations = new Map(); // fingerprint -> { id, label, source, firstSeen }
// Responses API chaining: response_id -> conversationId
const responseIdToConvo = new Map();

// Disk logging — append JSONL to data/requests.jsonl
const DATA_DIR = path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const LOG_FILE = path.join(DATA_DIR, 'requests.jsonl');

function logToDisk(entry, rawBody) {
  const line = JSON.stringify({ ...entry, rawBody }) + '\n';
  fs.appendFile(LOG_FILE, line, err => { if (err) console.error('Log write error:', err.message); });
}


// Store captured request
function storeRequest(contextInfo, responseData, source, rawBody) {
  source = detectSource(contextInfo, source);
  const fingerprint = computeFingerprint(contextInfo, rawBody, responseIdToConvo);

  // Register or look up conversation
  let conversationId = null;
  if (fingerprint) {
    if (!conversations.has(fingerprint)) {
      conversations.set(fingerprint, {
        id: fingerprint,
        label: extractConversationLabel(contextInfo),
        source: source || 'unknown',
        firstSeen: new Date().toISOString(),
      });
    }
    conversationId = fingerprint;
  }

  // Agent key: distinguishes agents within a session (main vs subagents)
  const agentKey = computeAgentKey(contextInfo);
  const agentLabel = extractConversationLabel(contextInfo);

  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toISOString(),
    contextInfo,
    response: responseData,
    contextLimit: getContextLimit(contextInfo.model),
    source: source || 'unknown',
    conversationId,
    agentKey,
    agentLabel,
  };

  // Track response IDs for Responses API chaining
  const respId = responseData && (responseData.id || responseData.response_id);
  if (respId && conversationId) {
    responseIdToConvo.set(respId, conversationId);
  }

  capturedRequests.unshift(entry);
  if (capturedRequests.length > MAX_STORED) {
    const evicted = capturedRequests.pop();
    // Clean up orphaned conversation keys
    if (evicted.conversationId) {
      const stillReferenced = capturedRequests.some(r => r.conversationId === evicted.conversationId);
      if (!stillReferenced) {
        conversations.delete(evicted.conversationId);
      }
    }
  }

  logToDisk(entry, rawBody);
  return entry;
}

// Upstream config for resolveTargetUrl
const UPSTREAMS = {
  openai: UPSTREAM_OPENAI_URL,
  anthropic: UPSTREAM_ANTHROPIC_URL,
  chatgpt: UPSTREAM_CHATGPT_URL,
};

// Forward a request upstream (no body capture)
function forwardRequest(req, res, parsedUrl, body) {
  const { targetUrl } = resolveTargetUrl(parsedUrl, req.headers, UPSTREAMS);
  const targetParsed = url.parse(targetUrl);

  const forwardHeaders = { ...req.headers };
  delete forwardHeaders['x-target-url'];
  delete forwardHeaders['host'];
  forwardHeaders['host'] = targetParsed.host;

  const protocol = targetParsed.protocol === 'https:' ? https : http;
  const proxyReq = protocol.request({
    hostname: targetParsed.hostname,
    port: targetParsed.port,
    path: targetParsed.path,
    method: req.method,
    headers: forwardHeaders,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy error', details: err.message }));
  });

  if (body) proxyReq.write(body);
  proxyReq.end();
}

// Proxy handler
function handleProxy(req, res) {
  const parsedUrl = url.parse(req.url);
  const { source, cleanPath } = extractSource(parsedUrl.pathname);
  
  // Use clean path (without source prefix) for routing
  const cleanUrl = { ...parsedUrl, pathname: cleanPath };
  const { targetUrl, provider } = resolveTargetUrl(cleanUrl, req.headers, UPSTREAMS);
  const hasAuth = !!req.headers['authorization'];
  const sourceTag = source ? `[${source}]` : '';
  console.log(`${req.method} ${req.url} → ${targetUrl} [${provider}] ${sourceTag} auth=${hasAuth}`);

  // For non-POST requests (GET /v1/models, OPTIONS, etc.), pass through directly
  if (req.method !== 'POST') {
    return forwardRequest(req, res, cleanUrl, null);
  }

  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });

  req.on('end', () => {
    let bodyData;
    try {
      bodyData = JSON.parse(body);
    } catch (e) {
      console.log(`  ⚠ Body is not JSON (${body.length} bytes), capturing raw`);
      // Still capture the raw request even if body isn't JSON
      const { provider } = resolveTargetUrl(cleanUrl, req.headers, UPSTREAMS);
      const rawInfo = {
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
      return forwardRequest(req, res, cleanUrl, body);
    }

    console.log(`  ✓ Parsed JSON body (${Object.keys(bodyData).join(', ')})`);
    const { targetUrl, provider } = resolveTargetUrl(cleanUrl, req.headers, UPSTREAMS);
    const apiFormat = detectApiFormat(cleanUrl.pathname);
    const contextInfo = parseContextInfo(provider, bodyData, apiFormat);

    const targetParsed = url.parse(targetUrl);

    // Forward headers (remove proxy-specific ones)
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders['x-target-url'];
    delete forwardHeaders['host'];
    forwardHeaders['host'] = targetParsed.host;

    // Make request to actual API
    const protocol = targetParsed.protocol === 'https:' ? https : http;
    const proxyReq = protocol.request({
      hostname: targetParsed.hostname,
      port: targetParsed.port,
      path: targetParsed.path,
      method: req.method,
      headers: forwardHeaders,
    }, (proxyRes) => {
      console.log(`  ← ${proxyRes.statusCode} ${proxyRes.statusMessage}`);
      // Forward response headers
      res.writeHead(proxyRes.statusCode, proxyRes.headers);

      // Handle streaming vs non-streaming
      const isStreaming = proxyRes.headers['content-type']?.includes('text/event-stream');

      if (isStreaming) {
        // For streaming, pass through and capture chunks
        let capturedChunks = '';
        proxyRes.on('data', (chunk) => {
          capturedChunks += chunk.toString();
          res.write(chunk);
        });

        proxyRes.on('end', () => {
          storeRequest(contextInfo, { streaming: true, chunks: capturedChunks }, source, bodyData);
          res.end();
        });
      } else {
        // For non-streaming, capture full response
        let responseBody = '';
        proxyRes.on('data', (chunk) => {
          responseBody += chunk.toString();
          res.write(chunk);
        });

        proxyRes.on('end', () => {
          try {
            const responseData = JSON.parse(responseBody);
            storeRequest(contextInfo, responseData, source, bodyData);
          } catch (e) {
            storeRequest(contextInfo, { raw: responseBody }, source, bodyData);
          }
          res.end();
        });
      }
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', details: err.message }));
    });

    proxyReq.write(body);
    proxyReq.end();
  });
}

// Ingest endpoint — accepts captured data from external tools (e.g. mitmproxy addon)
function handleIngest(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const provider = data.provider || 'unknown';
      const apiFormat = data.apiFormat || 'unknown';
      const source = data.source || 'unknown';
      const contextInfo = parseContextInfo(provider, data.body || {}, apiFormat);
      storeRequest(contextInfo, data.response || {}, source, data.body || {});
      console.log(`  📥 Ingested: [${provider}] ${contextInfo.model} from ${source}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('Ingest error:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// Web UI handler
function handleWebUI(req, res) {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/api/ingest' && req.method === 'POST') {
    return handleIngest(req, res);
  }

  if (parsedUrl.pathname === '/api/requests') {
    // API endpoint: group requests by conversation
    const grouped = new Map(); // conversationId -> entries[]
    const ungrouped = [];
    for (const req of capturedRequests) {
      if (req.conversationId) {
        if (!grouped.has(req.conversationId)) grouped.set(req.conversationId, []);
        grouped.get(req.conversationId).push(req);
      } else {
        ungrouped.push(req);
      }
    }
    const convos = [];
    for (const [id, entries] of grouped) {
      const meta = conversations.get(id) || { id, label: 'Unknown', source: 'unknown', firstSeen: entries[entries.length - 1].timestamp };
      // Sub-group entries by agentKey
      const agentMap = new Map();
      for (const e of entries) {
        const ak = e.agentKey || '_default';
        if (!agentMap.has(ak)) agentMap.set(ak, []);
        agentMap.get(ak).push(e);
      }
      const agents = [];
      for (const [ak, agentEntries] of agentMap) {
        agents.push({
          key: ak,
          label: agentEntries[agentEntries.length - 1].agentLabel || 'Unnamed',
          model: agentEntries[0].contextInfo.model,
          entries: agentEntries, // newest-first (inherited from capturedRequests order)
        });
      }
      // Sort agents: most recent activity first
      agents.sort((a, b) => new Date(b.entries[0].timestamp) - new Date(a.entries[0].timestamp));
      convos.push({ ...meta, agents, entries: entries.slice() });
    }
    // Sort conversations newest-first (by most recent entry)
    convos.sort((a, b) => new Date(b.entries[0].timestamp) - new Date(a.entries[0].timestamp));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ conversations: convos, ungrouped }));
  } else if (parsedUrl.pathname === '/') {
    // Serve HTML UI
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getHTMLUI());
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

// Generate HTML UI
function getHTMLUI() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Context Lens</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      padding: 20px;
    }
    h1 { font-size: 24px; margin-bottom: 20px; color: #fff; }

    /* Cards */
    .request-card {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      transition: border-color 0.2s;
    }
    .request-card:hover { border-color: #555; }
    .request-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .provider-badge {
      display: inline-block; padding: 4px 8px; border-radius: 4px;
      font-size: 12px; font-weight: 600; text-transform: uppercase;
    }
    .provider-anthropic { background: #d4a574; color: #000; }
    .provider-openai { background: #10a37f; color: #fff; }
    .provider-chatgpt { background: #10a37f; color: #fff; }
    .provider-unknown { background: #666; color: #fff; }
    .source-badge {
      display: inline-block; padding: 4px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 600;
      background: #2a2a2a; color: #4a90e2; border: 1px solid #4a90e2; margin-left: 8px;
    }
    .model-name { font-size: 14px; color: #999; }
    .timestamp { font-size: 12px; color: #666; }

    /* Context bar */
    .context-bar {
      height: 24px; display: flex; border-radius: 4px;
      overflow: hidden; margin-bottom: 8px; background: #252525;
    }
    .bar-segment { height: 100%; transition: width 0.3s; }
    .bar-system { background: #4a90e2; }
    .bar-tools { background: #e24a90; }
    .bar-messages { background: #90e24a; }
    .context-stats { display: flex; gap: 16px; font-size: 13px; margin-bottom: 8px; flex-wrap: wrap; }
    .stat { display: flex; align-items: center; gap: 6px; }
    .stat-dot { width: 8px; height: 8px; border-radius: 50%; }
    .usage-indicator { font-size: 14px; font-weight: 600; color: #4a90e2; }
    .usage-high { color: #e2a54a; }
    .usage-critical { color: #e24a4a; }

    /* Collapsible sections */
    .details {
      display: none; margin-top: 16px; padding-top: 16px; border-top: 1px solid #333;
    }
    .details.expanded { display: block; }
    .section-title {
      font-weight: 600; margin-top: 12px; margin-bottom: 8px; color: #fff; cursor: pointer;
      user-select: none;
    }
    .section-title:hover { color: #4a90e2; }
    .message-list { margin-top: 8px; }
    .message-item {
      background: #252525; padding: 8px 12px; border-radius: 4px;
      margin-bottom: 8px; font-size: 13px;
    }
    .message-role { font-weight: 600; color: #4a90e2; margin-bottom: 4px; }
    .message-content {
      color: #ccc; white-space: pre-wrap; word-break: break-word;
      max-height: 200px; overflow-y: auto;
    }
    .message-tokens { color: #666; font-size: 11px; margin-top: 4px; }

    /* System prompt collapsible */
    .system-prompt-content {
      font-family: "SF Mono", "Fira Code", "Consolas", monospace;
      font-size: 12px; color: #ccc; white-space: pre-wrap; word-break: break-word;
      max-height: 150px; overflow: hidden; position: relative;
      transition: max-height 0.3s;
    }
    .system-prompt-content.expanded { max-height: none; }
    .system-prompt-content:not(.expanded)::after {
      content: ''; position: absolute; bottom: 0; left: 0; right: 0;
      height: 40px; background: linear-gradient(transparent, #252525);
    }
    .toggle-btn {
      background: none; border: 1px solid #444; color: #4a90e2;
      padding: 2px 10px; border-radius: 4px; cursor: pointer;
      font-size: 11px; margin-top: 4px; display: inline-block;
    }
    .toggle-btn:hover { border-color: #4a90e2; }

    /* Content block labels */
    .block-label {
      display: inline-block; padding: 1px 6px; border-radius: 3px;
      font-size: 10px; font-weight: 600; text-transform: uppercase; margin-right: 6px;
    }
    .block-label-text { background: #1a3a1a; color: #90e24a; }
    .block-label-tool_use { background: #3a1a2a; color: #e24a90; }
    .block-label-tool_result { background: #1a2a3a; color: #4a90e2; }

    /* Tool items */
    .tool-item {
      background: #252525; border-radius: 4px; margin-bottom: 6px; overflow: hidden;
    }
    .tool-item-header {
      padding: 6px 12px; cursor: pointer; font-size: 13px; font-weight: 500;
      color: #e24a90; user-select: none;
    }
    .tool-item-header:hover { background: #2a2a2a; }
    .tool-item-body {
      display: none; padding: 8px 12px; border-top: 1px solid #333;
      font-family: "SF Mono", "Fira Code", "Consolas", monospace;
      font-size: 11px; color: #aaa; white-space: pre-wrap; word-break: break-word;
      max-height: 300px; overflow-y: auto;
    }
    .tool-item-body.expanded { display: block; }

    /* Conversation groups */
    .conversation-group {
      border: 1px solid #333; border-radius: 8px; margin-bottom: 16px;
      overflow: hidden;
    }
    .conversation-header {
      background: #1e1e1e; padding: 12px 16px; cursor: pointer;
      display: flex; justify-content: space-between; align-items: center;
      user-select: none;
    }
    .conversation-header:hover { background: #252525; }
    .conversation-label {
      font-size: 13px; color: #ccc; max-width: 500px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .turn-count {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 11px; font-weight: 600; background: #333; color: #aaa; margin-left: 8px;
    }
    .conversation-body { display: none; }
    .conversation-body.expanded { display: block; }
    .turn-label {
      font-size: 11px; font-weight: 600; color: #666;
      padding: 4px 16px; background: #151515; border-top: 1px solid #2a2a2a;
    }
    .turn-card {
      padding: 16px; border-top: 1px solid #2a2a2a;
    }
    .turn-card .request-header { margin-bottom: 8px; }

    .clickable { cursor: pointer; }

    /* Agent sub-groups within a session */
    .agent-group {
      border-top: 1px solid #2a2a2a;
    }
    .agent-header {
      padding: 8px 16px; cursor: pointer; user-select: none;
      display: flex; justify-content: space-between; align-items: center;
      background: #161616;
    }
    .agent-header:hover { background: #1e1e1e; }
    .agent-label {
      font-size: 12px; color: #aaa; max-width: 400px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .agent-model {
      font-size: 11px; color: #666; font-family: "SF Mono", "Fira Code", "Consolas", monospace;
    }
    .agent-body { display: none; }
    .agent-body.expanded { display: block; }

    .empty-state { text-align: center; padding: 60px 20px; color: #666; }
  </style>
</head>
<body>
  <h1>Context Lens</h1>
  <div id="requests-container"></div>
  <div id="empty-state" class="empty-state" style="display: none;">
    <p>No requests captured yet.</p>
    <p style="margin-top: 8px; font-size: 14px;">Point your LLM API calls to port 4040 to start capturing.</p>
  </div>

  <script>
    let currentData = null;
    const expandedState = new Set(); // track expanded IDs across re-renders

    function esc(str) {
      if (!str) return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function cap(text, limit) {
      limit = limit || 10000;
      if (!text) return '';
      if (text.length <= limit) return text;
      return text.slice(0, limit) + '\\n... [truncated at ' + limit.toLocaleString() + ' chars]';
    }

    function formatTimestamp(iso) {
      const d = new Date(iso);
      return d.toLocaleTimeString() + ' ' + d.toLocaleDateString();
    }

    function toggle(id) {
      const el = document.getElementById(id);
      if (!el) return;
      if (expandedState.has(id)) {
        expandedState.delete(id);
        el.classList.remove('expanded');
      } else {
        expandedState.add(id);
        el.classList.add('expanded');
      }
    }

    function renderContextBar(info, limit) {
      const total = info.totalTokens || 0;
      const usagePercent = limit ? Math.round((total / limit) * 100) : 0;
      let usageClass = 'usage-indicator';
      if (usagePercent > 80) usageClass += ' usage-critical';
      else if (usagePercent > 60) usageClass += ' usage-high';

      const systemPct = total ? (info.systemTokens / total) * 100 : 0;
      const toolsPct = total ? (info.toolsTokens / total) * 100 : 0;
      const msgsPct = total ? (info.messagesTokens / total) * 100 : 0;

      return '<div class="context-bar">'
        + '<div class="bar-segment bar-system" style="width:' + systemPct + '%"></div>'
        + '<div class="bar-segment bar-tools" style="width:' + toolsPct + '%"></div>'
        + '<div class="bar-segment bar-messages" style="width:' + msgsPct + '%"></div>'
        + '</div>'
        + '<div class="context-stats">'
        + '<div class="stat"><span class="stat-dot bar-system"></span><span>System: ' + info.systemTokens.toLocaleString() + ' tokens</span></div>'
        + '<div class="stat"><span class="stat-dot bar-tools"></span><span>Tools: ' + info.toolsTokens.toLocaleString() + ' tokens</span></div>'
        + '<div class="stat"><span class="stat-dot bar-messages"></span><span>Messages: ' + info.messagesTokens.toLocaleString() + ' tokens</span></div>'
        + '</div>'
        + '<div style="margin-top:8px;">'
        + '<span class="' + usageClass + '">' + usagePercent + '% of context used</span>'
        + '<span style="color:#666;margin-left:8px;">(' + total.toLocaleString() + ' / ' + limit.toLocaleString() + ' tokens)</span>'
        + '</div>';
    }

    function renderContentBlock(block, reqId, idx) {
      if (!block || typeof block !== 'object') return '<div class="message-item">' + esc(String(block)) + '</div>';
      const type = block.type || 'unknown';

      if (type === 'text') {
        return '<div class="message-item">'
          + '<span class="block-label block-label-text">text</span>'
          + '<div class="message-content">' + esc(cap(block.text || '')) + '</div>'
          + '</div>';
      }
      if (type === 'tool_use') {
        const inputJson = block.input ? JSON.stringify(block.input, null, 2) : '{}';
        const bodyId = 'cb-' + reqId + '-' + idx;
        return '<div class="message-item">'
          + '<span class="block-label block-label-tool_use">tool_use</span>'
          + '<strong style="color:#e24a90">' + esc(block.name || 'unnamed') + '</strong>'
          + '<div id="' + bodyId + '" class="tool-item-body' + (expandedState.has(bodyId) ? ' expanded' : '') + '">'
          + esc(cap(inputJson)) + '</div>'
          + '<button class="toggle-btn" onclick="event.stopPropagation();toggle(\\'' + bodyId + '\\')">toggle input</button>'
          + '</div>';
      }
      if (type === 'tool_result') {
        let resultText = '';
        if (typeof block.content === 'string') resultText = block.content;
        else if (Array.isArray(block.content)) {
          resultText = block.content.map(function(c) {
            if (c.type === 'image') return '[image content]';
            return c.text || JSON.stringify(c);
          }).join('\\n');
        } else if (block.content) resultText = JSON.stringify(block.content);
        return '<div class="message-item">'
          + '<span class="block-label block-label-tool_result">tool_result</span>'
          + '<div class="message-content">' + esc(cap(resultText)) + '</div>'
          + '</div>';
      }
      if (type === 'image') {
        return '<div class="message-item"><span class="block-label" style="background:#333;color:#aaa">image</span> [image content]</div>';
      }
      // Fallback
      return '<div class="message-item"><div class="message-content">' + esc(cap(JSON.stringify(block, null, 2))) + '</div></div>';
    }

    function renderMessage(msg, reqId, msgIdx) {
      const blocks = msg.contentBlocks;
      let contentHtml = '';
      if (blocks && Array.isArray(blocks) && blocks.length > 0) {
        contentHtml = blocks.map(function(b, i) { return renderContentBlock(b, reqId, msgIdx + '-' + i); }).join('');
      } else {
        // Check if stringified content might contain image base64
        let display = msg.content || '';
        if (display.length > 500 && /data:image|base64,/.test(display.slice(0, 200))) {
          display = '[contains image data - ' + display.length + ' chars]';
        }
        contentHtml = '<div class="message-content">' + esc(cap(display)) + '</div>';
      }
      return '<div class="message-item">'
        + '<div class="message-role">' + esc(msg.role) + '</div>'
        + contentHtml
        + '<div class="message-tokens">' + (msg.tokens || 0).toLocaleString() + ' tokens</div>'
        + '</div>';
    }

    function renderDetails(req, detailsId) {
      const info = req.contextInfo;
      const isExp = expandedState.has(detailsId);
      let html = '<div id="' + detailsId + '" class="details' + (isExp ? ' expanded' : '') + '">';

      // System prompts
      if (info.systemPrompts && info.systemPrompts.length > 0) {
        html += '<div class="section-title">System Prompts</div>';
        info.systemPrompts.forEach(function(sp, i) {
          const spId = detailsId + '-sp-' + i;
          const spExp = expandedState.has(spId);
          html += '<div class="message-item">'
            + '<div id="' + spId + '" class="system-prompt-content' + (spExp ? ' expanded' : '') + '">'
            + esc(cap(sp.content)) + '</div>'
            + '<button class="toggle-btn" onclick="event.stopPropagation();toggle(\\'' + spId + '\\')">'
            + (spExp ? 'Show less' : 'Show more') + '</button></div>';
        });
      }

      // Tools
      if (info.tools && info.tools.length > 0) {
        html += '<div class="section-title">Tools (' + info.tools.length + ')</div>';
        info.tools.forEach(function(t, i) {
          const name = t.name || (t.function && t.function.name) || 'unnamed';
          const desc = t.description || (t.function && t.function.description) || '';
          const schema = t.input_schema || (t.function && t.function.parameters) || null;
          const toolId = detailsId + '-tool-' + i;
          const tExp = expandedState.has(toolId);
          html += '<div class="tool-item">'
            + '<div class="tool-item-header" onclick="event.stopPropagation();toggle(\\'' + toolId + '\\')">'
            + esc(name) + '</div>'
            + '<div id="' + toolId + '" class="tool-item-body' + (tExp ? ' expanded' : '') + '">'
            + (desc ? esc(desc) + '\\n\\n' : '')
            + (schema ? esc(JSON.stringify(schema, null, 2)) : '')
            + '</div></div>';
        });
      }

      // Messages
      if (info.messages && info.messages.length > 0) {
        html += '<div class="section-title">Messages (' + info.messages.length + ')</div>';
        html += '<div class="message-list">';
        info.messages.forEach(function(msg, i) {
          html += renderMessage(msg, req.id, i);
        });
        html += '</div>';
      }

      html += '</div>';
      return html;
    }

    function renderSingleCard(req) {
      const info = req.contextInfo;
      const detailsId = 'details-' + req.id;
      return '<div class="request-card">'
        + '<div class="request-header clickable" onclick="toggle(\\'' + detailsId + '\\')"><div>'
        + '<span class="provider-badge provider-' + esc(info.provider) + '">' + esc(info.provider) + '</span>'
        + (req.source && req.source !== 'unknown' ? '<span class="source-badge">' + esc(req.source) + '</span>' : '')
        + ' <span class="model-name">' + esc(info.model) + '</span>'
        + '</div><span class="timestamp">' + esc(formatTimestamp(req.timestamp)) + '</span></div>'
        + '<div class="clickable" onclick="toggle(\\'' + detailsId + '\\')">'
        + renderContextBar(info, req.contextLimit)
        + '</div>'
        + renderDetails(req, detailsId)
        + '</div>';
    }

    function renderAgentTurns(agent, convoId) {
      const entries = agent.entries;
      let html = '';
      entries.forEach(function(entry, i) {
        const detailsId = 'details-' + entry.id;
        html += '<div class="turn-label">Turn ' + (entries.length - i) + ' / ' + entries.length
          + ' &mdash; ' + esc(formatTimestamp(entry.timestamp)) + '</div>';
        html += '<div class="turn-card">';
        html += '<div class="clickable" onclick="event.stopPropagation();toggle(\\'' + detailsId + '\\')">';
        html += renderContextBar(entry.contextInfo, entry.contextLimit);
        html += '</div>';
        html += renderDetails(entry, detailsId);
        html += '</div>';
      });
      return html;
    }

    function renderConversationGroup(convo) {
      const entries = convo.entries; // newest-first
      const agents = convo.agents || [];
      const latest = entries[0];
      const info = latest.contextInfo;
      const bodyId = 'convo-body-' + convo.id;
      const isExp = expandedState.has(bodyId);
      const hasAgents = agents.length > 1;

      let html = '<div class="conversation-group">';
      // Header
      html += '<div class="conversation-header" onclick="toggle(\\'' + bodyId + '\\')">';
      html += '<div>';
      html += '<span class="provider-badge provider-' + esc(info.provider) + '">' + esc(info.provider) + '</span>';
      if (convo.source && convo.source !== 'unknown') html += '<span class="source-badge">' + esc(convo.source) + '</span>';
      if (hasAgents) {
        html += '<span class="turn-count">' + agents.length + ' agents, ' + entries.length + ' calls</span>';
      } else {
        html += ' <span class="model-name">' + esc(info.model) + '</span>';
        html += '<span class="turn-count">' + entries.length + ' turns</span>';
      }
      html += '</div>';
      html += '<div>';
      html += '<span class="conversation-label">' + esc(convo.label) + '</span>';
      html += ' <span class="timestamp">' + esc(formatTimestamp(latest.timestamp)) + '</span>';
      html += '</div></div>';

      // Summary (always visible): latest request's context bar
      html += '<div style="padding:12px 16px;background:#1a1a1a;">'
        + renderContextBar(info, latest.contextLimit) + '</div>';

      // Expandable body
      html += '<div id="' + bodyId + '" class="conversation-body' + (isExp ? ' expanded' : '') + '">';

      if (hasAgents) {
        // Multi-agent: render each agent as a collapsible sub-group
        agents.forEach(function(agent) {
          const agentBodyId = 'agent-' + convo.id + '-' + agent.key;
          const aExp = expandedState.has(agentBodyId);
          const turnText = agent.entries.length === 1 ? '1 turn' : agent.entries.length + ' turns';
          html += '<div class="agent-group">';
          html += '<div class="agent-header" onclick="event.stopPropagation();toggle(\\'' + agentBodyId + '\\')">';
          html += '<div>';
          html += '<span class="agent-model">' + esc(agent.model) + '</span> ';
          html += '<span class="agent-label">' + esc(agent.label) + '</span>';
          html += '</div>';
          html += '<span class="turn-count">' + turnText + '</span>';
          html += '</div>';
          html += '<div id="' + agentBodyId + '" class="agent-body' + (aExp ? ' expanded' : '') + '">';
          html += renderAgentTurns(agent, convo.id);
          html += '</div></div>';
        });
      } else {
        // Single agent: render turns directly
        html += renderAgentTurns(agents[0] || { entries: entries }, convo.id);
      }

      html += '</div></div>';
      return html;
    }

    function renderConversations(data) {
      const container = document.getElementById('requests-container');
      const emptyState = document.getElementById('empty-state');
      const convos = data.conversations || [];
      const ungrouped = data.ungrouped || [];

      if (convos.length === 0 && ungrouped.length === 0) {
        container.innerHTML = '';
        emptyState.style.display = 'block';
        return;
      }
      emptyState.style.display = 'none';

      // Merge into a single timeline sorted by most recent entry
      const items = [];
      convos.forEach(function(c) {
        const latest = c.entries[0];
        items.push({ type: c.entries.length === 1 ? 'single' : 'group', ts: new Date(latest.timestamp), data: c });
      });
      ungrouped.forEach(function(r) {
        items.push({ type: 'ungrouped', ts: new Date(r.timestamp), data: r });
      });
      items.sort(function(a, b) { return b.ts - a.ts; });

      let html = '';
      items.forEach(function(item) {
        if (item.type === 'single') {
          html += renderSingleCard(item.data.entries[0]);
        } else if (item.type === 'group') {
          html += renderConversationGroup(item.data);
        } else {
          html += renderSingleCard(item.data);
        }
      });
      container.innerHTML = html;
    }

    async function fetchRequests() {
      try {
        const response = await fetch('/api/requests');
        const data = await response.json();
        if (JSON.stringify(data) !== JSON.stringify(currentData)) {
          currentData = data;
          renderConversations(data);
        }
      } catch (err) {
        console.error('Failed to fetch requests:', err);
      }
    }

    fetchRequests();
    setInterval(fetchRequests, 2000);
  </script>
</body>
</html>`;
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
