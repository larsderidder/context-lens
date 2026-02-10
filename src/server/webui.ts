import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import url from 'node:url';

import { parseContextInfo } from '../core.js';
import { toLharJson, toLharJsonl } from '../lhar.js';
import type { CapturedEntry } from '../types.js';
import type { Store } from './store.js';

export function loadHtmlUI(baseDir: string): string {
  return fs.readFileSync(path.join(baseDir, '..', 'public', 'index.html'), 'utf-8');
}

export function createWebUIHandler(store: Store, htmlUI: string): (req: http.IncomingMessage, res: http.ServerResponse) => void {
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
        store.storeRequest(contextInfo, data.response || {}, source, data.body || {});
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

  // Lightweight projection for /api/requests
  function projectEntry(e: CapturedEntry) {
    // This mirrors the Store projection; entries already have compacted fields after storeRequest().
    const resp = e.response as Record<string, any> | undefined;
    const usage = resp?.usage;
    return {
      id: e.id,
      timestamp: e.timestamp,
      contextInfo: e.contextInfo,
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

  return function handleWebUI(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsedUrl = url.parse(req.url!, true);

    if (parsedUrl.pathname === '/api/ingest' && req.method === 'POST') {
      return handleIngest(req, res);
    }

    // DELETE /api/conversations/:id — delete one session
    const convoDeleteMatch = parsedUrl.pathname?.match(/^\/api\/conversations\/(.+)$/);
    if (convoDeleteMatch && req.method === 'DELETE') {
      const convoId = decodeURIComponent(convoDeleteMatch[1]);
      store.deleteConversation(convoId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/reset — reset all data
    if (parsedUrl.pathname === '/api/reset' && req.method === 'POST') {
      store.resetAll();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (parsedUrl.pathname === '/api/requests') {
      const capturedRequests = store.getCapturedRequests();
      const conversations = store.getConversations();

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
      res.end(JSON.stringify({ revision: store.getRevision(), conversations: convos, ungrouped: ungrouped.map(projectEntry) }));
    } else if (parsedUrl.pathname === '/api/export/lhar') {
      // Export as JSONL (.lhar)
      const convoFilter = parsedUrl.query.conversation as string | undefined;
      const entries = convoFilter
        ? store.getCapturedRequests().filter(e => e.conversationId === convoFilter)
        : store.getCapturedRequests();
      const jsonl = toLharJsonl(entries, store.getConversations());
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': 'attachment; filename=\"context-lens-export.lhar\"',
      });
      res.end(jsonl);
    } else if (parsedUrl.pathname === '/api/export/lhar.json') {
      // Export as wrapped JSON (.lhar.json)
      const convoFilter = parsedUrl.query.conversation as string | undefined;
      const entries = convoFilter
        ? store.getCapturedRequests().filter(e => e.conversationId === convoFilter)
        : store.getCapturedRequests();
      const wrapped = toLharJson(entries, store.getConversations());
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename=\"context-lens-export.lhar.json\"',
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
  };
}

