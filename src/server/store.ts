import fs from "node:fs";
import path from "node:path";
import {
  computeAgentKey,
  computeFingerprint,
  computeHealthScore,
  detectSource,
  estimateCost,
  estimateTokens,
  extractConversationLabel,
  extractSessionId,
  extractWorkingDirectory,
  getContextLimit,
  scanSecurity,
} from "../core.js";
import {
  analyzeComposition,
  buildLharRecord,
  buildSessionLine,
  parseResponseUsage,
} from "../lhar.js";
import { safeFilenamePart } from "../server-utils.js";
import type {
  CapturedEntry,
  ContentBlock,
  ContextInfo,
  Conversation,
  PrivacyLevel,
  RequestMeta,
  ResponseData,
} from "../types.js";
import { projectEntry } from "./projection.js";

export interface StoreChangeEvent {
  type: string;
  revision: number;
  conversationId?: string | null;
}

type StoreChangeListener = (event: StoreChangeEvent) => void;

export class Store {
  private readonly dataDir: string;
  private readonly stateFile: string;
  private readonly maxSessions: number;
  private readonly maxCompactMessages: number;
  private readonly privacy: PrivacyLevel;

  private capturedRequests: CapturedEntry[] = [];
  private conversations = new Map<string, Conversation>(); // fingerprint -> conversation
  private responseIdToConvo = new Map<string, string>(); // response_id -> conversationId
  private diskSessionsWritten = new Set<string>();

  private dataRevision = 0;
  private nextEntryId = 1;

  // SSE change listeners
  private changeListeners = new Set<StoreChangeListener>();

  constructor(opts: {
    dataDir: string;
    stateFile: string;
    maxSessions: number;
    maxCompactMessages: number;
    privacy?: PrivacyLevel;
  }) {
    this.dataDir = opts.dataDir;
    this.stateFile = opts.stateFile;
    this.maxSessions = opts.maxSessions;
    this.maxCompactMessages = opts.maxCompactMessages;
    this.privacy = opts.privacy ?? "standard";

    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch {
      /* Directory may already exist */
    }
  }

  getRevision(): number {
    return this.dataRevision;
  }

  getPrivacy(): PrivacyLevel {
    return this.privacy;
  }

  // --- SSE event emitter ---

  on(_event: "change", listener: StoreChangeListener): void {
    this.changeListeners.add(listener);
  }

  off(_event: "change", listener: StoreChangeListener): void {
    this.changeListeners.delete(listener);
  }

  private emitChange(
    type: string,
    conversationId?: string | null,
  ): void {
    const event: StoreChangeEvent = {
      type,
      revision: this.dataRevision,
      conversationId,
    };
    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch {
        // Don't let a broken SSE connection crash the store
      }
    }
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
      content = fs.readFileSync(this.stateFile, "utf8");
    } catch {
      return; // No state file, fresh start
    }
    const lines = content.split("\n").filter((l) => l.length > 0);
    let loadedEntries = 0;
    let maxId = 0;
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.type === "conversation") {
          const c = record.data as Conversation;
          this.conversations.set(c.id, c);
          this.diskSessionsWritten.add(c.id);
        } else if (record.type === "entry") {
          const projected = record.data;
          const entry: CapturedEntry = {
            ...projected,
            response: projected.response || { raw: true },
            requestHeaders: {},
            responseHeaders: {},
            rawBody: undefined,
            healthScore: projected.healthScore ?? null,
            securityAlerts: projected.securityAlerts || [],
          };
          this.capturedRequests.push(entry);
          if (entry.id > maxId) maxId = entry.id;
          loadedEntries++;
        }
      } catch (err: unknown) {
        console.error(
          "State parse error:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (loadedEntries > 0) {
      this.nextEntryId = maxId + 1;
      this.dataRevision = 1;
      // Loaded entries are already compact (projectEntry strips heavy data before saving).
      // Do NOT call compactEntry here. It would destroy the preserved response usage data.
      this.backfillHealthScores();
      const migrated = this.migrateImageTokenCounts();
      if (migrated > 0) {
        this.saveState();
      }
      console.log(
        `Restored ${loadedEntries} entries from ${this.conversations.size} conversations`,
      );
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
    const fingerprint = computeFingerprint(
      contextInfo,
      rawBody ?? null,
      this.responseIdToConvo,
    );
    const rawSessionId = extractSessionId(rawBody ?? null);

    // Register or look up conversation
    let conversationId: string | null = null;
    if (fingerprint) {
      if (!this.conversations.has(fingerprint)) {
        this.conversations.set(fingerprint, {
          id: fingerprint,
          label: extractConversationLabel(contextInfo),
          source: resolvedSource || "unknown",
          workingDirectory: extractWorkingDirectory(contextInfo),
          firstSeen: new Date().toISOString(),
          sessionId: rawSessionId,
        });
      } else {
        const convo = this.conversations.get(fingerprint)!;
        // Backfill source if first request couldn't detect it
        if (
          convo.source === "unknown" &&
          resolvedSource &&
          resolvedSource !== "unknown"
        ) {
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
      source: resolvedSource || "unknown",
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
      healthScore: null,
      securityAlerts: [],
    };

    // Compute health score
    const sameConvo = conversationId
      ? this.capturedRequests.filter(
          (e) => e.conversationId === conversationId,
        )
      : [];
    const prevMain = sameConvo
      .filter((e) => !e.agentKey)
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )[0];
    const sessionToolsUsed = new Set<string>();
    for (const e of sameConvo) {
      for (const msg of e.contextInfo.messages) {
        if (msg.contentBlocks) {
          for (const b of msg.contentBlocks) {
            if (b.type === "tool_use" && "name" in b && b.name)
              sessionToolsUsed.add(b.name);
          }
        }
      }
    }
    // Also scan current entry (not yet in capturedRequests)
    for (const msg of contextInfo.messages) {
      if (msg.contentBlocks) {
        for (const b of msg.contentBlocks) {
          if (b.type === "tool_use" && "name" in b && b.name)
            sessionToolsUsed.add(b.name);
        }
      }
    }
    const turnCount = sameConvo.filter((e) => !e.agentKey).length + 1;
    entry.healthScore = computeHealthScore(
      entry,
      prevMain ? prevMain.contextInfo.totalTokens : null,
      sessionToolsUsed,
      turnCount,
    );

    // Security scanning — must happen before compaction strips message content
    const securityResult = scanSecurity(contextInfo);
    entry.securityAlerts = securityResult.alerts;

    // Track response IDs for Responses API chaining
    const respId =
      (responseData as Record<string, any>).id ||
      (responseData as Record<string, any>).response_id;
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
      const toEvict = sorted
        .slice(0, sorted.length - this.maxSessions)
        .map((s) => s[0]);
      const evictSet = new Set(toEvict);
      // Remove all entries belonging to evicted sessions
      for (let i = this.capturedRequests.length - 1; i >= 0; i--) {
        if (
          this.capturedRequests[i].conversationId &&
          evictSet.has(this.capturedRequests[i].conversationId!)
        ) {
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
    this.emitChange("entry-added", conversationId);
    this.logToDisk(entry);
    this.compactEntry(entry);
    this.saveState();
    return entry;
  }

  deleteConversation(convoId: string): void {
    this.conversations.delete(convoId);
    for (let i = this.capturedRequests.length - 1; i >= 0; i--) {
      if (this.capturedRequests[i].conversationId === convoId)
        this.capturedRequests.splice(i, 1);
    }
    this.diskSessionsWritten.delete(convoId);
    for (const [rid, cid] of this.responseIdToConvo) {
      if (cid === convoId) this.responseIdToConvo.delete(rid);
    }
    this.dataRevision++;
    this.emitChange("conversation-deleted", convoId);
    this.saveState();
  }

  resetAll(): void {
    this.capturedRequests.length = 0;
    this.conversations.clear();
    this.diskSessionsWritten.clear();
    this.responseIdToConvo.clear();
    this.nextEntryId = 1;
    this.dataRevision++;
    this.emitChange("reset");
    this.saveState();
  }

  // ----- Internals -----

  /** Backfill health scores for entries loaded from state that don't have one. */
  private backfillHealthScores(): void {
    // Process oldest-first so previousTokens lookups work correctly.
    const sorted = [...this.capturedRequests].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    for (const entry of sorted) {
      if (entry.healthScore) continue;

      const sameConvo = entry.conversationId
        ? sorted.filter(
            (e) =>
              e.conversationId === entry.conversationId &&
              new Date(e.timestamp).getTime() <
                new Date(entry.timestamp).getTime(),
          )
        : [];
      const prevMain = sameConvo
        .filter((e) => !e.agentKey)
        .sort(
          (a, b) =>
            new Date(b.timestamp).getTime() -
            new Date(a.timestamp).getTime(),
        )[0];

      const sessionToolsUsed = new Set<string>();
      for (const e of [...sameConvo, entry]) {
        for (const msg of e.contextInfo.messages) {
          if (msg.contentBlocks) {
            for (const b of msg.contentBlocks) {
              if (b.type === "tool_use" && "name" in b && b.name)
                sessionToolsUsed.add(b.name);
            }
          }
        }
      }
      const turnCount =
        sameConvo.filter((e) => !e.agentKey).length +
        (entry.agentKey ? 0 : 1);

      entry.healthScore = computeHealthScore(
        entry,
        prevMain ? prevMain.contextInfo.totalTokens : null,
        sessionToolsUsed,
        turnCount,
      );
    }
  }

  /**
   * Recalculate token counts for messages that contain image blocks.
   *
   * Before the image token fix, estimateTokens() would stringify base64 image
   * data, producing millions of phantom tokens. Persisted entries still have
   * those inflated counts. This migration recalculates from the compacted
   * contentBlocks (which have no base64 data) using the fixed estimateTokens().
   */
  private migrateImageTokenCounts(): number {
    let migrated = 0;
    for (const entry of this.capturedRequests) {
      const ci = entry.contextInfo;
      let messagesTokens = 0;
      let changed = false;
      for (const msg of ci.messages) {
        if (!msg.contentBlocks || msg.contentBlocks.length === 0) {
          messagesTokens += msg.tokens;
          continue;
        }
        // Check if any block (or nested content in tool_result) is an image
        const hasImage = msg.contentBlocks.some((b) => {
          if (b.type === "image") return true;
          if (b.type === "tool_result" && Array.isArray(b.content)) {
            return (b.content as any[]).some(
              (inner: any) => inner?.type === "image",
            );
          }
          return false;
        });
        if (!hasImage) {
          messagesTokens += msg.tokens;
          continue;
        }
        // Recalculate from compacted contentBlocks (no base64 data)
        const newTokens = estimateTokens(msg.contentBlocks);
        if (newTokens < msg.tokens) {
          msg.tokens = newTokens;
          changed = true;
        }
        messagesTokens += msg.tokens;
      }
      if (changed) {
        ci.messagesTokens = messagesTokens;
        ci.totalTokens = ci.systemTokens + ci.toolsTokens + ci.messagesTokens;
        migrated++;
      } else if (ci.messagesTokens !== messagesTokens) {
        // Messages with images may have been truncated during compaction,
        // leaving messagesTokens inflated even though no image blocks remain.
        // Fix by recalculating from the actual per-message token counts.
        ci.messagesTokens = messagesTokens;
        ci.totalTokens = ci.systemTokens + ci.toolsTokens + ci.messagesTokens;
        migrated++;
      }
    }
    if (migrated > 0) {
      console.log(`Migrated ${migrated} entries with inflated image token counts`);
    }
    return migrated;
  }

  private logToDisk(entry: CapturedEntry): void {
    const safeSource = safeFilenamePart(entry.source || "unknown");
    const safeConvo = entry.conversationId
      ? safeFilenamePart(entry.conversationId)
      : null;
    const filename = safeConvo
      ? `${safeSource}-${safeConvo}.lhar`
      : "ungrouped.lhar";
    const filePath = path.join(this.dataDir, filename);

    let output = "";

    // Write session preamble on first entry for this conversation
    if (
      entry.conversationId &&
      !this.diskSessionsWritten.has(entry.conversationId)
    ) {
      this.diskSessionsWritten.add(entry.conversationId);
      const convo = this.conversations.get(entry.conversationId);
      if (convo) {
        const sessionLine = buildSessionLine(
          entry.conversationId,
          convo,
          entry.contextInfo.model,
        );
        output += `${JSON.stringify(sessionLine)}\n`;
      }
    }

    const record = buildLharRecord(entry, this.capturedRequests, this.privacy);
    output += `${JSON.stringify(record)}\n`;

    try {
      fs.appendFileSync(filePath, output);
    } catch (err: unknown) {
      console.error(
        "Log write error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Compact a content block: keep tool metadata, truncate text
  private compactBlock(b: ContentBlock): ContentBlock {
    switch (b.type) {
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: {} };
      case "tool_result": {
        const rc =
          typeof b.content === "string"
            ? b.content.slice(0, 200)
            : Array.isArray(b.content)
              ? b.content.map((bb) => this.compactBlock(bb))
              : "";
        return { type: "tool_result", tool_use_id: b.tool_use_id, content: rc };
      }
      case "text":
        return { type: "text", text: (b.text || "").slice(0, 200) };
      case "input_text":
        return { type: "input_text", text: (b.text || "").slice(0, 200) };
      case "image":
        return { type: "image" };
      default: {
        // Handle thinking blocks and other unknown types; truncate text-like fields
        const any = b as any;
        if (any.thinking)
          return {
            ...any,
            thinking: any.thinking.slice(0, 200),
          } as ContentBlock;
        if (any.text)
          return { ...any, text: any.text.slice(0, 200) } as ContentBlock;
        return b;
      }
    }
  }

  private compactMessages(
    messages: ContextInfo["messages"],
  ): ContextInfo["messages"] {
    const msgs =
      messages.length > this.maxCompactMessages
        ? messages.slice(-this.maxCompactMessages)
        : messages;
    return msgs.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content.slice(0, 200) : "",
      tokens: m.tokens,
      contentBlocks: m.contentBlocks?.map((b) => this.compactBlock(b)) ?? null,
    }));
  }

  // Compact contextInfo: keep metadata and token counts, drop large text payloads
  private compactContextInfo(ci: ContextInfo) {
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
      messages: this.compactMessages(ci.messages),
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
    entry.contextInfo.messages = this.compactMessages(
      entry.contextInfo.messages,
    );
  }

  private saveState(): void {
    let lines = "";
    for (const [, convo] of this.conversations) {
      lines += `${JSON.stringify({ type: "conversation", data: convo })}\n`;
    }
    for (const entry of this.capturedRequests) {
      lines += `${JSON.stringify({
        type: "entry",
        data: projectEntry(entry, this.compactContextInfo(entry.contextInfo)),
      })}\n`;
    }
    try {
      fs.writeFileSync(this.stateFile, lines);
    } catch (err: unknown) {
      console.error(
        "State save error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
