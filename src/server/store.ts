import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as v from "valibot";
import {
  computeAgentKey,
  computeFingerprint,
  computeHealthScore,
  detectSource,
  estimateCost,
  estimateTokens,
  extractConversationLabel,
  extractSessionId,
  extractToolsUsed,
  extractWorkingDirectory,
  getContextLimit,
  rescaleContextTokens,
  scanSecurity,
} from "../core.js";
import {
  analyzeComposition,
  buildLharRecord,
  buildSessionLine,
  extractResponseId,
  normalizeComposition,
  parseResponseUsage,
} from "../lhar.js";
import { ConversationLineSchema, EntryLineSchema } from "../schemas.js";
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
import { TagsStore } from "./tags-store.js";

export interface StoreChangeEvent {
  type: string;
  revision: number;
  conversationId?: string | null;
}

type StoreChangeListener = (event: StoreChangeEvent) => void;

const CODEX_SESSION_TTL_MS = 5 * 60 * 1000;
const GEMINI_SESSION_TTL_MS = 5 * 60 * 1000;

export class Store {
  private readonly dataDir: string;
  private readonly stateFile: string;
  private readonly detailDir: string;
  private readonly maxSessions: number;
  private readonly maxCompactMessages: number;
  private readonly privacy: PrivacyLevel;

  private capturedRequests: CapturedEntry[] = [];
  private conversations = new Map<string, Conversation>(); // fingerprint -> conversation
  private responseIdToConvo = new Map<string, string>(); // response_id -> conversationId
  private diskSessionsWritten = new Set<string>();
  private codexSessionTracker = new Map<
    string,
    { conversationId: string; lastSeen: number }
  >();
  private geminiSessionTracker = new Map<
    string,
    { conversationId: string; lastSeen: number }
  >();

  private dataRevision = 0;
  private nextEntryId = 1;

  // SSE change listeners
  private changeListeners = new Set<StoreChangeListener>();

  // Tags storage
  private tagsStore: TagsStore;

  constructor(opts: {
    dataDir: string;
    stateFile: string;
    maxSessions: number;
    maxCompactMessages: number;
    privacy?: PrivacyLevel;
  }) {
    this.dataDir = opts.dataDir;
    this.stateFile = opts.stateFile;
    this.detailDir = path.join(opts.dataDir, "details");
    this.maxSessions = opts.maxSessions;
    this.maxCompactMessages = opts.maxCompactMessages;
    this.privacy = opts.privacy ?? "standard";

    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch {
      /* Directory may already exist */
    }
    try {
      fs.mkdirSync(this.detailDir, { recursive: true });
    } catch {
      /* Directory may already exist */
    }

    this.tagsStore = new TagsStore(this.dataDir);
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

  private emitChange(type: string, conversationId?: string | null): void {
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
    const loadedEntriesBuffer: CapturedEntry[] = [];
    for (const line of lines) {
      try {
        const raw = JSON.parse(line);

        if (raw.type === "conversation") {
          const result = v.safeParse(ConversationLineSchema, raw);
          if (!result.success) {
            console.warn(
              `State: skipping invalid conversation line: ${v.summarize(result.issues)}`,
            );
            continue;
          }
          const c = result.output.data as Conversation;
          this.conversations.set(c.id, c);
          this.diskSessionsWritten.add(c.id);
        } else if (raw.type === "entry") {
          const result = v.safeParse(EntryLineSchema, raw);
          if (!result.success) {
            console.warn(
              `State: skipping invalid entry line (id=${raw.data?.id}): ${v.summarize(result.issues)}`,
            );
            continue;
          }
          const projected = result.output.data;
          // The schema validates structure; cast to domain types for fields
          // where the schema is intentionally looser (tools as unknown[],
          // nested content blocks as loose objects).
          const entry: CapturedEntry = {
            ...projected,
            contextInfo: projected.contextInfo as ContextInfo,
            response: (projected.response || { raw: true }) as ResponseData,
            requestHeaders: {},
            responseHeaders: {},
            rawBody: undefined,
            healthScore: projected.healthScore ?? null,
            securityAlerts: projected.securityAlerts || [],
          };
          loadedEntriesBuffer.push(entry);
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
    // Reverse entries to match runtime order (newest first)
    this.capturedRequests = loadedEntriesBuffer.reverse();
    if (loadedEntries > 0) {
      this.nextEntryId = maxId + 1;
      this.dataRevision = 1;
      // Loaded entries are already compact (projectEntry strips heavy data before saving).
      // Do NOT call compactEntry here. It would destroy the preserved response usage data.
      // TODO: Consider introducing a formal versioned migration system (schema version
      // tracking, ordered migration list, "already applied" checks) if the number of
      // ad hoc migrations here keeps growing. For now each migration is idempotent and
      // detects whether it needs to run by inspecting the data.
      //
      // Order matters: image migration fixes inflated per-message tokens from base64 data
      // BEFORE the usage backfill rescales everything proportionally.
      const migrated = this.migrateImageTokenCounts();
      this.backfillTotalTokensFromUsage();
      const tokenFixups = this.restoreTokenCountsFromDetails();
      this.backfillHealthScores();
      if (migrated > 0 || tokenFixups > 0) {
        this.saveState();
      }
      console.log(
        `Restored ${loadedEntries} entries from ${this.conversations.size} conversations`,
      );
      // Sync tags: remove tags for conversations that no longer exist
      this.tagsStore.syncTags(new Set(this.conversations.keys()));
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
    sessionId?: string | null,
  ): CapturedEntry {
    const resolvedSource = detectSource(contextInfo, source, requestHeaders);
    const workingDirectory = extractWorkingDirectory(
      contextInfo,
      rawBody ?? null,
    );
    const responseId = extractResponseId(responseData);

    const fingerprint = computeFingerprint(
      contextInfo,
      rawBody ?? null,
      this.responseIdToConvo,
      resolvedSource,
      workingDirectory,
    );

    const rawSessionId = sessionId ?? extractSessionId(rawBody ?? null);

    // Register or look up conversation
    let conversationId: string | null = null;

    // Explicit session ID from the caller (e.g. mitmproxy addon) takes
    // precedence over all fingerprint-based grouping strategies.
    if (sessionId) {
      conversationId = createHash("sha256")
        .update(sessionId)
        .digest("hex")
        .slice(0, 16);
    } else if (fingerprint && resolvedSource === "codex") {
      // Codex has no built-in conversation IDs. Group by working directory
      // + system prompt fingerprint, with a TTL to split idle sessions.
      // Compute a base fingerprint without response-ID chaining so the
      // tracker key stays stable across turns.
      const baseKey = computeFingerprint(
        contextInfo,
        rawBody ?? null,
        new Map<string, string>(),
        resolvedSource,
        workingDirectory,
      );
      const now = Date.now();

      if (rawBody?.previous_response_id) {
        const chained = this.responseIdToConvo.get(
          rawBody.previous_response_id,
        );
        if (chained) {
          conversationId = chained;
          if (baseKey) {
            this.codexSessionTracker.set(baseKey, {
              conversationId,
              lastSeen: now,
            });
          }
        }
      }

      if (!conversationId && baseKey) {
        const tracked = this.codexSessionTracker.get(baseKey);
        if (tracked && now - tracked.lastSeen <= CODEX_SESSION_TTL_MS) {
          conversationId = tracked.conversationId;
          tracked.lastSeen = now;
        } else {
          conversationId = createHash("sha256")
            .update(`${baseKey}\0${now}`)
            .digest("hex")
            .slice(0, 16);
          this.codexSessionTracker.set(baseKey, {
            conversationId,
            lastSeen: now,
          });
        }
      }
    } else if (fingerprint && resolvedSource === "gemini") {
      // Gemini CLI resends the full message history each turn, like Codex.
      // Without a session_id, two sessions that start with the same prompt
      // produce the same content-hash fingerprint and collapse into one
      // conversation. Apply the same TTL-based splitting as Codex so that
      // sessions separated by more than GEMINI_SESSION_TTL_MS get distinct IDs.
      const now = Date.now();
      const tracked = this.geminiSessionTracker.get(fingerprint);
      if (tracked && now - tracked.lastSeen <= GEMINI_SESSION_TTL_MS) {
        conversationId = tracked.conversationId;
        tracked.lastSeen = now;
      } else {
        conversationId = createHash("sha256")
          .update(`${fingerprint}\0${now}`)
          .digest("hex")
          .slice(0, 16);
        this.geminiSessionTracker.set(fingerprint, {
          conversationId,
          lastSeen: now,
        });
      }
    } else if (fingerprint) {
      conversationId = fingerprint;
    }

    if (conversationId && !this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, {
        id: conversationId,
        label: extractConversationLabel(contextInfo),
        source: resolvedSource || "unknown",
        workingDirectory,
        firstSeen: new Date().toISOString(),
        sessionId: rawSessionId,
      });
    } else if (conversationId) {
      const convo = this.conversations.get(conversationId)!;
      // Backfill source if first request couldn't detect it
      if (
        convo.source === "unknown" &&
        resolvedSource &&
        resolvedSource !== "unknown"
      ) {
        convo.source = resolvedSource;
      }
      // Backfill working directory if first request didn't have it
      if (!convo.workingDirectory && workingDirectory) {
        convo.workingDirectory = workingDirectory;
      }
    }

    // Agent key: distinguishes agents within a session (main vs subagents)
    const agentKey = computeAgentKey(contextInfo);
    const agentLabel = extractConversationLabel(contextInfo);

    // Compute composition and cost
    const composition = analyzeComposition(contextInfo, rawBody);
    const usage = parseResponseUsage(responseData);

    // Validate estimation accuracy before overriding with actuals
    const actualInputTokens =
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    if (actualInputTokens > 0) {
      const estimated = contextInfo.totalTokens;
      const actual = actualInputTokens;
      const diff = Math.abs(actual - estimated);
      const pct = estimated > 0 ? (diff / estimated) * 100 : 0;

      // Log significant estimation errors (>20% off or >10K tokens off)
      if (pct > 20 || diff > 10_000) {
        console.warn(
          `Token estimation off by ${pct.toFixed(1)}% (estimated: ${estimated.toLocaleString()}, actual: ${actual.toLocaleString()}) for ${contextInfo.model}`,
        );
      }

      // Rescale all sub-totals and per-message tokens to match the
      // authoritative API usage. This preserves relative proportions while
      // ensuring totalTokens === systemTokens + toolsTokens + messagesTokens.
      rescaleContextTokens(contextInfo, actualInputTokens);
    }

    // Normalize composition so sum(composition[].tokens) === totalTokens.
    // This must happen after the totalTokens override so both systems agree.
    normalizeComposition(composition, contextInfo.totalTokens);

    // Calculate cost with proper cache token pricing
    const inputTok = usage.inputTokens || contextInfo.totalTokens;
    const outputTok = usage.outputTokens;
    const costUsd = estimateCost(
      contextInfo.model,
      inputTok,
      outputTok,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
    );

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
      ? this.capturedRequests.filter((e) => e.conversationId === conversationId)
      : [];
    const prevMain = sameConvo
      .filter((e) => !e.agentKey)
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )[0];

    // Collect all tools used across the conversation (including current entry)
    const sessionToolsUsed = new Set<string>();
    for (const e of sameConvo) {
      for (const tool of extractToolsUsed(e.contextInfo.messages)) {
        sessionToolsUsed.add(tool);
      }
    }
    // Also scan current entry (not yet in capturedRequests)
    for (const tool of extractToolsUsed(contextInfo.messages)) {
      sessionToolsUsed.add(tool);
    }

    const turnCount = sameConvo.filter((e) => !e.agentKey).length + 1;
    entry.healthScore = computeHealthScore(
      entry,
      prevMain ? prevMain.contextInfo.totalTokens : null,
      sessionToolsUsed,
      turnCount,
    );

    // Security scanning must happen before compaction strips message content
    const securityResult = scanSecurity(contextInfo);
    entry.securityAlerts = securityResult.alerts;

    // Track response IDs for Responses API chaining (works for both
    // non-streaming JSON and streaming SSE responses)
    if (responseId && conversationId) {
      this.responseIdToConvo.set(responseId, conversationId);
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
        const evictEntry = this.capturedRequests[i];
        if (
          evictEntry.conversationId &&
          evictSet.has(evictEntry.conversationId)
        ) {
          // Remove detail file
          const detailPath = path.join(this.detailDir, `${evictEntry.id}.json`);
          try {
            fs.unlinkSync(detailPath);
          } catch {
            /* may not exist */
          }
          this.capturedRequests.splice(i, 1);
        }
      }
      for (const cid of toEvict) {
        this.conversations.delete(cid);
        this.diskSessionsWritten.delete(cid);
        for (const [rid, rcid] of this.responseIdToConvo) {
          if (rcid === cid) this.responseIdToConvo.delete(rid);
        }
        for (const [key, tracked] of this.geminiSessionTracker) {
          if (tracked.conversationId === cid)
            this.geminiSessionTracker.delete(key);
        }
      }
    }

    this.dataRevision++;
    this.emitChange("entry-added", conversationId);
    this.logToDisk(entry);
    this.saveEntryDetail(entry);
    this.compactEntry(entry);
    this.appendToState(entry, conversationId);
    return entry;
  }

  deleteConversation(convoId: string): void {
    this.removeConversationDetails(convoId);
    this.conversations.delete(convoId);
    this.tagsStore.removeConversation(convoId);
    for (let i = this.capturedRequests.length - 1; i >= 0; i--) {
      if (this.capturedRequests[i].conversationId === convoId)
        this.capturedRequests.splice(i, 1);
    }
    this.diskSessionsWritten.delete(convoId);
    for (const [rid, cid] of this.responseIdToConvo) {
      if (cid === convoId) this.responseIdToConvo.delete(rid);
    }
    for (const [key, tracked] of this.geminiSessionTracker) {
      if (tracked.conversationId === convoId)
        this.geminiSessionTracker.delete(key);
    }
    this.dataRevision++;
    this.emitChange("conversation-deleted", convoId);
    this.saveState();
  }

  resetAll(): void {
    // Remove all detail files
    try {
      const files = fs.readdirSync(this.detailDir);
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(this.detailDir, f));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* directory may not exist */
    }

    this.capturedRequests.length = 0;
    this.conversations.clear();
    this.diskSessionsWritten.clear();
    this.responseIdToConvo.clear();
    this.geminiSessionTracker.clear();
    this.tagsStore.syncTags(new Set());
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
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        )[0];

      // Collect all tools used across the conversation (up to this entry)
      const sessionToolsUsed = new Set<string>();
      for (const e of [...sameConvo, entry]) {
        for (const tool of extractToolsUsed(e.contextInfo.messages)) {
          sessionToolsUsed.add(tool);
        }
      }

      const turnCount =
        sameConvo.filter((e) => !e.agentKey).length + (entry.agentKey ? 0 : 1);

      entry.healthScore = computeHealthScore(
        entry,
        prevMain ? prevMain.contextInfo.totalTokens : null,
        sessionToolsUsed,
        turnCount,
      );
    }
  }

  /**
   * Backfill totalTokens from API usage data for entries that only have estimates.
   * The estimate (chars/4) can be wildly inaccurate; the API's real token count
   * (input + cacheRead + cacheWrite) is authoritative.
   */
  private backfillTotalTokensFromUsage(): void {
    let fixed = 0;
    for (const entry of this.capturedRequests) {
      const usage = parseResponseUsage(entry.response);
      const actual =
        usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      if (actual > 0 && actual !== entry.contextInfo.totalTokens) {
        rescaleContextTokens(entry.contextInfo, actual);
        fixed++;
      }
    }
    if (fixed > 0) {
      console.log(`Fixed totalTokens from API usage for ${fixed} entries`);
    }
  }

  /**
   * Restore token counts for compacted entries whose totalTokens was incorrectly
   * recalculated from truncated messages. Uses the detail files (which contain
   * the full uncompacted contextInfo) as the source of truth.
   */
  private restoreTokenCountsFromDetails(): number {
    // Skip if this migration has already completed successfully.
    const markerPath = path.join(this.dataDir, ".token-restore-done");
    if (fs.existsSync(markerPath)) return 0;

    // First pass: identify candidates that might need fixing.
    // An entry is a candidate only when it was compacted (fewer messages
    // than maxCompactMessages) AND messagesTokens matches the truncated
    // sum. This avoids reading thousands of detail files on every startup.
    const candidates: CapturedEntry[] = [];
    for (const entry of this.capturedRequests) {
      const ci = entry.contextInfo;
      if (ci.messages.length >= this.maxCompactMessages) continue;
      const msgTokenSum = ci.messages.reduce((s, m) => s + m.tokens, 0);
      if (ci.messagesTokens === msgTokenSum) {
        candidates.push(entry);
      }
    }
    if (candidates.length === 0) {
      this.writeMarker(markerPath);
      return 0;
    }

    // Second pass: only read detail files for candidates.
    let fixed = 0;
    for (const entry of candidates) {
      const ci = entry.contextInfo;
      const detail = this.getEntryDetail(entry.id);
      if (!detail || detail.messages.length <= ci.messages.length) continue;
      if (
        detail.totalTokens !== ci.totalTokens &&
        detail.totalTokens > ci.totalTokens
      ) {
        ci.systemTokens = detail.systemTokens;
        ci.toolsTokens = detail.toolsTokens;
        ci.messagesTokens = detail.messagesTokens;
        ci.totalTokens = detail.totalTokens;
        fixed++;
      }
    }
    if (fixed > 0) {
      console.log(
        `Restored totalTokens from detail files for ${fixed} compacted entries`,
      );
    }
    this.writeMarker(markerPath);
    return fixed;
  }

  private writeMarker(markerPath: string): void {
    try {
      fs.writeFileSync(markerPath, "");
    } catch {
      /* non-critical */
    }
  }

  /**
   * Migrate image token counts: re-estimate token counts for messages containing
   * contentBlocks (which have no base64 data) using the fixed estimateTokens().
   */
  private migrateImageTokenCounts(): number {
    let migrated = 0;
    const updateTotals = (ci: ContextInfo, messagesTokens: number): void => {
      ci.messagesTokens = messagesTokens;
      ci.totalTokens = ci.systemTokens + ci.toolsTokens + ci.messagesTokens;
    };
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
        const newTokens = estimateTokens(msg.contentBlocks, ci.model);
        if (newTokens < msg.tokens) {
          msg.tokens = newTokens;
          changed = true;
        }
        messagesTokens += msg.tokens;
      }
      if (changed) {
        updateTotals(ci, messagesTokens);
        migrated++;
      }
    }
    if (migrated > 0) {
      console.log(
        `Migrated ${migrated} entries with inflated image token counts`,
      );
    }
    return migrated;
  }

  /**
   * Save full contextInfo for an entry to disk so the UI can retrieve
   * uncompacted message content on demand.
   */
  private saveEntryDetail(entry: CapturedEntry): void {
    const detailPath = path.join(this.detailDir, `${entry.id}.json`);
    try {
      fs.writeFileSync(
        detailPath,
        JSON.stringify({
          contextInfo: entry.contextInfo,
        }),
      );
    } catch (err: unknown) {
      console.error(
        "Detail save error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Load full contextInfo for an entry from disk.
   * Returns null if the detail file doesn't exist (old entries before this feature).
   */
  getEntryDetail(entryId: number): ContextInfo | null {
    const detailPath = path.join(this.detailDir, `${entryId}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(detailPath, "utf-8"));
      return data.contextInfo ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Remove detail files for entries belonging to a conversation.
   */
  private removeConversationDetails(convoId: string): void {
    for (const entry of this.capturedRequests) {
      if (entry.conversationId === convoId) {
        const detailPath = path.join(this.detailDir, `${entry.id}.json`);
        try {
          fs.unlinkSync(detailPath);
        } catch {
          /* file may not exist */
        }
      }
    }
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

  // Compact a content block: keep tool metadata, truncate text.
  // Full content is available via the detail API (per-entry files on disk).
  private compactBlock(b: ContentBlock): ContentBlock {
    const limit = 200;
    switch (b.type) {
      case "tool_use":
        return {
          type: "tool_use",
          id: b.id,
          name: b.name,
          // Preserve small path-like keys for file attribution; drop large values
          input: this.compactToolInput(b.input),
        };
      case "tool_result": {
        const rc =
          typeof b.content === "string"
            ? b.content.slice(0, limit)
            : Array.isArray(b.content)
              ? b.content.map((bb) => this.compactBlock(bb))
              : "";
        return { type: "tool_result", tool_use_id: b.tool_use_id, content: rc };
      }
      case "text":
        return { type: "text", text: (b.text || "").slice(0, limit) };
      case "input_text":
        return { type: "input_text", text: (b.text || "").slice(0, limit) };
      case "image":
        return { type: "image" };
      default: {
        // Handle thinking blocks and other unknown types; truncate text-like fields
        const any = b as any;
        if (any.thinking)
          return {
            ...any,
            thinking: any.thinking.slice(0, limit),
          } as ContentBlock;
        if (any.text)
          return { ...any, text: any.text.slice(0, limit) } as ContentBlock;
        return b;
      }
    }
  }

  /**
   * Compact tool_use input: preserve keys that contain file paths (small strings),
   * drop large values like file content, diffs, and command output.
   */
  private compactToolInput(
    input: Record<string, any> | undefined,
  ): Record<string, any> {
    if (!input || typeof input !== "object") return {};
    const PATH_KEYS = [
      "file_path",
      "path",
      "filePath",
      "file",
      "dir_path",
      "pattern",
      "glob",
    ];
    const result: Record<string, any> = {};
    for (const key of PATH_KEYS) {
      if (typeof input[key] === "string") {
        result[key] = input[key];
      }
    }
    return result;
  }

  private compactMessages(
    messages: ContextInfo["messages"],
  ): ContextInfo["messages"] {
    const limit = 200;
    const msgs =
      messages.length > this.maxCompactMessages
        ? messages.slice(-this.maxCompactMessages)
        : messages;
    return msgs.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content.slice(0, limit) : "",
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
        thinking_tokens: usage.thinkingTokens,
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

  /**
   * Append a single new entry (and its conversation) to the state file.
   * This is O(entry size) instead of O(total state size).
   *
   * The conversation line is always written so that backfilled fields
   * (source, workingDirectory) are captured. On loadState, later
   * conversation lines overwrite earlier ones, so duplicates are harmless.
   */
  private appendToState(
    entry: CapturedEntry,
    conversationId: string | null,
  ): void {
    let lines = "";

    if (conversationId) {
      const convo = this.conversations.get(conversationId);
      if (convo) {
        lines += `${JSON.stringify({ type: "conversation", data: convo })}\n`;
      }
    }

    lines += `${JSON.stringify({
      type: "entry",
      data: projectEntry(entry, this.compactContextInfo(entry.contextInfo)),
    })}\n`;

    try {
      fs.appendFileSync(this.stateFile, lines);
    } catch (err: unknown) {
      console.error(
        "State append error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Full rewrite of the state file. Used after structural changes
   * (eviction, deletion, reset, migrations) where append is not sufficient.
   *
   * Entries are written oldest-first (chronological) to match the append-only
   * convention used by appendToState(). loadState() reverses on read to
   * restore the in-memory newest-first order.
   */
  private saveState(): void {
    let lines = "";
    for (const [, convo] of this.conversations) {
      lines += `${JSON.stringify({ type: "conversation", data: convo })}\n`;
    }
    // Write oldest-first so loadState's reverse() produces newest-first
    for (let i = this.capturedRequests.length - 1; i >= 0; i--) {
      const entry = this.capturedRequests[i];
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

  // ----- Tags API -----

  getTags(conversationId: string): string[] {
    return this.tagsStore.getTags(conversationId);
  }

  setTags(conversationId: string, tags: string[]): void {
    if (!this.conversations.has(conversationId)) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    this.tagsStore.setTags(conversationId, tags);
    this.dataRevision++;
    this.emitChange("tags-updated", conversationId);
  }

  addTag(conversationId: string, tag: string): void {
    if (!this.conversations.has(conversationId)) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    this.tagsStore.addTag(conversationId, tag);
    this.dataRevision++;
    this.emitChange("tags-updated", conversationId);
  }

  removeTag(conversationId: string, tag: string): void {
    if (!this.conversations.has(conversationId)) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    this.tagsStore.removeTag(conversationId, tag);
    this.dataRevision++;
    this.emitChange("tags-updated", conversationId);
  }

  getAllTags(): Map<string, number> {
    return this.tagsStore.getAllTags();
  }
}
