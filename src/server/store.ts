import fs from 'node:fs';
import path from 'node:path';

import type { CapturedEntry, ContextInfo, Conversation, ContentBlock, RequestMeta, ResponseData } from '../types.js';
import { getContextLimit, computeAgentKey, computeFingerprint, detectSource, extractConversationLabel, extractSessionId, extractWorkingDirectory, estimateCost } from '../core.js';
import { analyzeComposition, buildLharRecord, buildSessionLine, parseResponseUsage } from '../lhar.js';
import { safeFilenamePart } from '../server-utils.js';

export class Store {
  private readonly dataDir: string;
  private readonly stateFile: string;
  private readonly maxSessions: number;
  private readonly maxCompactMessages: number;

  private capturedRequests: CapturedEntry[] = [];
  private conversations = new Map<string, Conversation>(); // fingerprint -> conversation
  private responseIdToConvo = new Map<string, string>(); // response_id -> conversationId
  private diskSessionsWritten = new Set<string>();

  private dataRevision = 0;
  private nextEntryId = 1;

  constructor(opts: { dataDir: string; stateFile: string; maxSessions: number; maxCompactMessages: number }) {
    this.dataDir = opts.dataDir;
    this.stateFile = opts.stateFile;
    this.maxSessions = opts.maxSessions;
    this.maxCompactMessages = opts.maxCompactMessages;

    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch {}
  }

  getRevision(): number {
    return this.dataRevision;
  }

  getCapturedRequests(): CapturedEntry[] {
    return this.capturedRequests;
  }

  getConversations(): Map<string, Conversation> {
    return this.conversations;
  }

  loadState(): void {
    let content: string;
    try {
      content = fs.readFileSync(this.stateFile, 'utf8');
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
          this.conversations.set(c.id, c);
          this.diskSessionsWritten.add(c.id);
        } else if (record.type === 'entry') {
          const projected = record.data;
          const entry: CapturedEntry = {
            ...projected,
            response: projected.response || { raw: true },
            requestHeaders: {},
            responseHeaders: {},
            rawBody: undefined,
          };
          this.capturedRequests.push(entry);
          if (entry.id > maxId) maxId = entry.id;
          loadedEntries++;
        }
      } catch (err: any) {
        console.error('State parse error:', err.message);
      }
    }
    if (loadedEntries > 0) {
      this.nextEntryId = maxId + 1;
      this.dataRevision = 1;
      // Loaded entries are already compact (projectEntry strips heavy data before saving).
      // Do NOT call compactEntry here — it would destroy the preserved response usage data.
      console.log(`Restored ${loadedEntries} entries from ${this.conversations.size} conversations`);
    }
  }

  // Store captured request
  storeRequest(
    contextInfo: ContextInfo,
    responseData: ResponseData,
    source: string | null,
    rawBody?: Record<string, any>,
    meta?: RequestMeta,
    requestHeaders?: Record<string, string>,
  ): CapturedEntry {
    const resolvedSource = detectSource(contextInfo, source, requestHeaders);
    const fingerprint = computeFingerprint(contextInfo, rawBody ?? null, this.responseIdToConvo);
    const rawSessionId = extractSessionId(rawBody ?? null);

    // Register or look up conversation
    let conversationId: string | null = null;
    if (fingerprint) {
      if (!this.conversations.has(fingerprint)) {
        this.conversations.set(fingerprint, {
          id: fingerprint,
          label: extractConversationLabel(contextInfo),
          source: resolvedSource || 'unknown',
          workingDirectory: extractWorkingDirectory(contextInfo),
          firstSeen: new Date().toISOString(),
          sessionId: rawSessionId,
        });
      } else {
        const convo = this.conversations.get(fingerprint)!;
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
      id: this.nextEntryId++,
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
      this.responseIdToConvo.set(respId, conversationId);
    }

    this.capturedRequests.unshift(entry);

    // Evict oldest sessions when we exceed the session limit
    if (this.conversations.size > this.maxSessions) {
      // Find the oldest session by its most recent entry timestamp
      const sessionLatest = new Map<string, number>();
      for (const r of this.capturedRequests) {
        if (r.conversationId) {
          const t = new Date(r.timestamp).getTime();
          const cur = sessionLatest.get(r.conversationId) || 0;
          if (t > cur) sessionLatest.set(r.conversationId, t);
        }
      }
      // Sort sessions oldest-first, evict until we're at the limit
      const sorted = [...sessionLatest.entries()].sort((a, b) => a[1] - b[1]);
      const toEvict = sorted.slice(0, sorted.length - this.maxSessions).map(s => s[0]);
      const evictSet = new Set(toEvict);
      // Remove all entries belonging to evicted sessions
      for (let i = this.capturedRequests.length - 1; i >= 0; i--) {
        if (this.capturedRequests[i].conversationId && evictSet.has(this.capturedRequests[i].conversationId!)) {
          this.capturedRequests.splice(i, 1);
        }
      }
      for (const cid of toEvict) {
        this.conversations.delete(cid);
        this.diskSessionsWritten.delete(cid);
        for (const [rid, rcid] of this.responseIdToConvo) {
          if (rcid === cid) this.responseIdToConvo.delete(rid);
        }
      }
    }

    this.dataRevision++;
    this.logToDisk(entry);
    this.compactEntry(entry);
    this.saveState();
    return entry;
  }

  deleteConversation(convoId: string): void {
    this.conversations.delete(convoId);
    for (let i = this.capturedRequests.length - 1; i >= 0; i--) {
      if (this.capturedRequests[i].conversationId === convoId) this.capturedRequests.splice(i, 1);
    }
    this.diskSessionsWritten.delete(convoId);
    for (const [rid, cid] of this.responseIdToConvo) {
      if (cid === convoId) this.responseIdToConvo.delete(rid);
    }
    this.dataRevision++;
    this.saveState();
  }

  resetAll(): void {
    this.capturedRequests.length = 0;
    this.conversations.clear();
    this.diskSessionsWritten.clear();
    this.responseIdToConvo.clear();
    this.nextEntryId = 1;
    this.dataRevision++;
    this.saveState();
  }

  // ----- Internals -----

  private logToDisk(entry: CapturedEntry): void {
    const safeSource = safeFilenamePart(entry.source || 'unknown');
    const safeConvo = entry.conversationId ? safeFilenamePart(entry.conversationId) : null;
    const filename = safeConvo
      ? `${safeSource}-${safeConvo}.lhar`
      : 'ungrouped.lhar';
    const filePath = path.join(this.dataDir, filename);

    let output = '';

    // Write session preamble on first entry for this conversation
    if (entry.conversationId && !this.diskSessionsWritten.has(entry.conversationId)) {
      this.diskSessionsWritten.add(entry.conversationId);
      const convo = this.conversations.get(entry.conversationId);
      if (convo) {
        const sessionLine = buildSessionLine(entry.conversationId, convo, entry.contextInfo.model);
        output += JSON.stringify(sessionLine) + '\n';
      }
    }

    const record = buildLharRecord(entry, this.capturedRequests);
    output += JSON.stringify(record) + '\n';

    fs.appendFile(filePath, output, err => { if (err) console.error('Log write error:', err.message); });
  }

  // Compact a content block — keep tool metadata, truncate text
  private compactBlock(b: ContentBlock): ContentBlock {
    switch (b.type) {
      case 'tool_use':
        return { type: 'tool_use', id: b.id, name: b.name, input: {} };
      case 'tool_result': {
        const rc = typeof b.content === 'string'
          ? b.content.slice(0, 200)
          : Array.isArray(b.content)
            ? b.content.map(bb => this.compactBlock(bb))
            : '';
        return { type: 'tool_result', tool_use_id: b.tool_use_id, content: rc };
      }
      case 'text':
        return { type: 'text', text: (b.text || '').slice(0, 200) };
      case 'input_text':
        return { type: 'input_text', text: (b.text || '').slice(0, 200) };
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
  private compactContextInfo(ci: ContextInfo) {
    const msgs = ci.messages.length > this.maxCompactMessages
      ? ci.messages.slice(-this.maxCompactMessages)
      : ci.messages;
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
      messages: msgs.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content.slice(0, 200) : '',
        tokens: m.tokens,
        contentBlocks: m.contentBlocks?.map(b => this.compactBlock(b)) ?? null,
      })),
    };
  }

  // Release heavy data from an entry after it's been logged to disk
  private compactEntry(entry: CapturedEntry): void {
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
    const msgs = entry.contextInfo.messages.length > this.maxCompactMessages
      ? entry.contextInfo.messages.slice(-this.maxCompactMessages)
      : entry.contextInfo.messages;
    entry.contextInfo.messages = msgs.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.slice(0, 200) : '',
      tokens: m.tokens,
      contentBlocks: m.contentBlocks?.map(b => this.compactBlock(b)) ?? null,
    }));
  }

  // Lightweight projection — strip rawBody, heavy headers; compact contextInfo
  private projectEntry(e: CapturedEntry) {
    const resp = e.response as Record<string, any> | undefined;
    const usage = resp?.usage;
    return {
      id: e.id,
      timestamp: e.timestamp,
      contextInfo: this.compactContextInfo(e.contextInfo),
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

  private saveState(): void {
    let lines = '';
    for (const [, convo] of this.conversations) {
      lines += JSON.stringify({ type: 'conversation', data: convo }) + '\n';
    }
    for (const entry of this.capturedRequests) {
      lines += JSON.stringify({ type: 'entry', data: this.projectEntry(entry) }) + '\n';
    }
    try {
      fs.writeFileSync(this.stateFile, lines);
    } catch (err: any) {
      console.error('State save error:', err.message);
    }
  }
}

