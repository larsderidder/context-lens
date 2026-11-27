import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scanOutput } from "@contextio/core";
import * as v from "valibot";
import {
  computeAgentKey,
  computeFingerprint,
  computeHealthScore,
  detectSource,
  detectToolPatterns,
  estimateCost,
  estimateTokens,
  extractConversationLabel,
  extractSessionId,
  extractToolsUsed,
  extractWorkingDirectory,
  getContextLimit,
  PROVIDER_NAMES,
  rescaleContextTokens,
  scanSecurity,
} from "../core.js";
import { redactHeaders } from "../http/headers.js";
import {
  analyzeComposition,
  buildLharRecord,
  buildSessionLine,
  extractResponseId,
  normalizeComposition,
  parseResponseUsage,
} from "../lhar.js";
import type { LharRecord } from "../lhar-types.generated.js";
import { ConversationLineSchema, EntryLineSchema } from "../schemas.js";
import { safeFilenamePart } from "../server-utils.js";
import type {
  CapturedEntry,
  ContentBlock,
  ContextInfo,
  Conversation,
  OutputAlert,
  PrivacyLevel,
  RequestMeta,
  ResponseData,
} from "../types.js";
import {
  ExportArchive,
  parseRetainedExportRecord,
  type RetainedExportRecord,
} from "./export-archive.js";
import {
  estimatePpqCost,
  isPpqTarget,
  lookupPpqPricing,
  type PpqPricingLookup,
} from "./ppq-pricing.js";
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
  private readonly ppqPricingLookup: PpqPricingLookup;

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

  // Tracks CLI session IDs already imported to avoid duplicates across scans
  private importedSessionIds = new Set<string>();

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
    ppqPricingLookup?: PpqPricingLookup;
  }) {
    this.dataDir = opts.dataDir;
    this.stateFile = opts.stateFile;
    this.detailDir = path.join(opts.dataDir, "details");
    this.maxSessions = opts.maxSessions;
    this.maxCompactMessages = opts.maxCompactMessages;
    this.privacy = opts.privacy ?? "standard";
    this.ppqPricingLookup = opts.ppqPricingLookup ?? lookupPpqPricing;

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
            outputSecurityAlerts:
              ((projected as Record<string, unknown>).outputSecurityAlerts as
                | OutputAlert[]
                | undefined) || [],
          };
          const response = entry.response as Record<string, unknown>;
          const usage = response.usage as Record<string, unknown> | undefined;
          // Legacy compaction fabricated zero input when only output usage was known.
          // Without cache counts or a version marker, preserve the original estimate.
          if (
            response._contextLensUsageVersion !== 1 &&
            usage?.input_tokens === 0 &&
            usage.cache_read_input_tokens === 0 &&
            usage.cache_creation_input_tokens === 0
          ) {
            delete usage.input_tokens;
          }
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
      const tokenFixups = this.restoreTokenCountsFromDetails();
      const usageFixups = this.normalizeRetainedOpenaiUsage();
      const usageTokenFixups = this.backfillTotalTokensFromUsage();
      const contextLimitFixups = this.restoreContextLimits();
      this.backfillHealthScores();
      if (
        migrated > 0 ||
        tokenFixups > 0 ||
        contextLimitFixups > 0 ||
        usageFixups > 0 ||
        usageTokenFixups > 0
      ) {
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
      requestHeaders,
    );

    const rawSessionId =
      sessionId ?? extractSessionId(rawBody ?? null, requestHeaders);

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
      const convo = this.conversations.get(conversationId);
      if (convo) {
        // Backfill source if first request couldn't detect it, or if the
        // stored source is a bare provider name (e.g. "anthropic") that has
        // now been resolved to an actual tool name.
        const storedSourceIsWeak =
          convo.source === "unknown" || PROVIDER_NAMES.has(convo.source);
        if (
          storedSourceIsWeak &&
          resolvedSource &&
          resolvedSource !== "unknown" &&
          !PROVIDER_NAMES.has(resolvedSource)
        ) {
          convo.source = resolvedSource;
        }
        // Backfill working directory if first request didn't have it
        if (!convo.workingDirectory && workingDirectory) {
          convo.workingDirectory = workingDirectory;
        }
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
    if (usage.hasInputTokens || actualInputTokens > 0) {
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

    // Calculate cost with proper cache token pricing.
    // Skip cost estimation for error responses (429 rate limits, 5xx errors)
    // since those requests are not billed by the API.
    const httpStatus = meta?.httpStatus ?? null;
    const isSuccessResponse =
      httpStatus === null || (httpStatus >= 200 && httpStatus < 300);
    let inputTok = contextInfo.totalTokens;
    if (usage.hasInputTokens) {
      inputTok = usage.inputTokens;
    }
    const outputTok = usage.outputTokens;
    const needsPpqPricing = isSuccessResponse && isPpqTarget(meta?.targetUrl);
    let costUsd: number | null = 0;
    if (needsPpqPricing) {
      // Leave unknown until the lazy pricing lookup completes.
      costUsd = null;
    } else if (isSuccessResponse) {
      costUsd = estimateCost(
        contextInfo.model,
        inputTok,
        outputTok,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
      );
    }

    const entry: CapturedEntry = {
      id: this.nextEntryId++,
      timestamp: new Date().toISOString(),
      contextInfo,
      response: responseData,
      contextLimit: getContextLimit(contextInfo.model, contextInfo.provider),
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
      outputSecurityAlerts: [],
    };

    // Compute health score
    const sameConvo = conversationId
      ? this.capturedRequests.filter((e) => e.conversationId === conversationId)
      : [];
    const previousAgentTurn = sameConvo
      .filter((e) => e.agentKey === entry.agentKey)
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

    const turnCount =
      sameConvo.filter((e) => e.agentKey === entry.agentKey).length + 1;
    entry.healthScore = computeHealthScore(
      entry,
      previousAgentTurn?.contextInfo.totalTokens ?? null,
      sessionToolsUsed,
      turnCount,
    );

    // Tool pattern detection (redundant calls, re-fetches, stuck-on-error).
    // Find the most recent prior entry in this conversation that has accumulated
    // fetched paths, and use those for cross-turn re-fetch detection.
    const prevEntry = [...sameConvo]
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )
      .find((e) => e.toolPatternFetchedPaths);
    const previousContext = prevEntry?.toolPatternFetchedPaths
      ? { fetchedPaths: prevEntry.toolPatternFetchedPaths }
      : undefined;
    const { findings: toolPatternFindings, fetchedPaths } = detectToolPatterns(
      contextInfo.messages,
      previousContext,
    );
    entry.toolPatterns = toolPatternFindings;
    entry.toolPatternFetchedPaths = fetchedPaths;

    // Security scanning must happen before compaction strips message content
    const securityResult = scanSecurity(contextInfo);
    entry.securityAlerts = securityResult.alerts;

    // Output (response) scanning: check for jailbreak markers, dangerous code, suspicious URLs
    const responseText = extractResponseText(responseData);
    if (responseText) {
      const outputResult = scanOutput(responseText);
      entry.outputSecurityAlerts = outputResult.alerts.map((a) => ({
        severity: a.severity,
        pattern: a.pattern,
        match: a.match,
        offset: a.offset,
        length: a.length,
      }));
    }

    // Track response IDs for Responses API chaining (works for both
    // non-streaming JSON and streaming SSE responses)
    if (responseId && conversationId) {
      this.responseIdToConvo.set(responseId, conversationId);
    }

    this.capturedRequests.unshift(entry);

    // Evict oldest sessions when we exceed the session limit
    let evicted = false;
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
        for (const [key, tracked] of this.codexSessionTracker) {
          if (tracked.conversationId === cid)
            this.codexSessionTracker.delete(key);
        }
        for (const [key, tracked] of this.geminiSessionTracker) {
          if (tracked.conversationId === cid)
            this.geminiSessionTracker.delete(key);
        }
      }
      this.saveState();
      evicted = true;
    }

    this.dataRevision++;
    this.emitChange("entry-added", conversationId);
    if (!needsPpqPricing) {
      this.logToDisk(entry);
    }
    this.saveEntryDetail(entry);
    if (!needsPpqPricing) {
      this.compactEntry(entry);
    }
    // saveState() already wrote the full state including this entry,
    // so skip the append to avoid duplicating it in the file.
    if (!evicted) {
      this.appendToState(entry, conversationId);
    }
    if (needsPpqPricing) {
      // PPQ has one input rate; keep its OpenAI input count inclusive of cache.
      let ppqInputTok = inputTok;
      if (
        usage.hasInputTokens &&
        (contextInfo.provider === "openai" ||
          contextInfo.provider === "chatgpt")
      ) {
        ppqInputTok += usage.cacheReadTokens;
      }
      void this.resolvePpqCost(entry, ppqInputTok, outputTok).catch(() => {
        console.warn("PPQ cost update failed");
      });
    }
    return entry;
  }

  /** Resolve PPQ prices without blocking capture or leaving rejected promises. */
  private async resolvePpqCost(
    entry: CapturedEntry,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    try {
      const pricing = await this.ppqPricingLookup(entry.contextInfo.model);
      // A reset, deletion or eviction may have removed the entry while fetching.
      if (!this.capturedRequests.includes(entry)) {
        return;
      }
      entry.costUsd = estimatePpqCost(pricing, inputTokens, outputTokens);
    } catch {
      // Custom lookup failures also mean unknown, never generic or zero pricing.
    }
    if (!this.capturedRequests.includes(entry)) {
      return;
    }
    this.logToDisk(entry);
    this.compactEntry(entry);
    this.saveState();
    this.dataRevision++;
    this.emitChange("entry-updated", entry.conversationId);
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
    this.importedSessionIds.clear();
    this.tagsStore.syncTags(new Set());
    this.nextEntryId = 1;
    this.dataRevision++;
    this.emitChange("reset");
    this.saveState();
  }

  // ----- CLI session import tracking -----

  hasImportedSession(sessionId: string): boolean {
    return this.importedSessionIds.has(sessionId);
  }

  markSessionImported(sessionId: string): void {
    this.importedSessionIds.add(sessionId);
  }

  // ----- Internals -----

  /** Refresh model metadata without changing historical usage or costs. */
  private restoreContextLimits(): number {
    let fixed = 0;
    for (const entry of this.capturedRequests) {
      const contextLimit = getContextLimit(
        entry.contextInfo.model,
        entry.contextInfo.provider,
      );
      if (entry.contextLimit !== contextLimit) {
        entry.contextLimit = contextLimit;
        entry.healthScore = null;
        fixed++;
      }
    }
    return fixed;
  }

  /** Backfill health scores for entries loaded from state that don't have one. */
  private backfillHealthScores(): void {
    const affectedConversations = new Set(
      this.capturedRequests
        .filter((entry) => !entry.healthScore && entry.conversationId)
        .map((entry) => entry.conversationId),
    );
    const sorted = this.capturedRequests
      .filter(
        (entry) =>
          !entry.healthScore || affectedConversations.has(entry.conversationId),
      )
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
    type AgentHistory = { tokens: number; count: number };
    type History = {
      tools: Set<string>;
      agents: Map<string | null, AgentHistory>;
    };
    const histories = new Map<string, History>();
    let start = 0;
    while (start < sorted.length) {
      let end = start + 1;
      const timestamp = new Date(sorted[start].timestamp).getTime();
      while (
        end < sorted.length &&
        new Date(sorted[end].timestamp).getTime() === timestamp
      ) {
        end++;
      }
      // Equal timestamps are not earlier turns. Commit only small aggregates
      // after scoring the whole timestamp group, never retaining detail contexts.
      const pending = new Map<string, History>();
      for (let i = start; i < end; i++) {
        const entry = sorted[i];
        let history: History | undefined;
        if (entry.conversationId) {
          history = histories.get(entry.conversationId);
        }
        const previous = history?.agents.get(entry.agentKey);
        const detail = this.getEntryDetail(entry.id);
        const context = { ...entry.contextInfo };
        if (detail) {
          // Compacted state omits tool definitions and some message content.
          context.tools = detail.tools;
          context.messages = detail.messages;
        }
        const toolsUsed = extractToolsUsed(context.messages);
        if (!entry.healthScore) {
          const sessionToolsUsed = new Set(history?.tools);
          for (const tool of toolsUsed) {
            sessionToolsUsed.add(tool);
          }
          entry.healthScore = computeHealthScore(
            { ...entry, contextInfo: context },
            previous?.tokens ?? null,
            sessionToolsUsed,
            (previous?.count ?? 0) + 1,
          );
        }
        if (entry.conversationId) {
          let delta = pending.get(entry.conversationId);
          if (!delta) {
            delta = { tools: new Set(), agents: new Map() };
            pending.set(entry.conversationId, delta);
          }
          for (const tool of toolsUsed) {
            delta.tools.add(tool);
          }
          const agent = delta.agents.get(entry.agentKey);
          if (agent) {
            agent.count++;
          } else {
            // Preserve the first turn at a tied timestamp as previousTokens.
            delta.agents.set(entry.agentKey, {
              tokens: entry.contextInfo.totalTokens,
              count: 1,
            });
          }
        }
      }
      for (const [conversationId, delta] of pending) {
        const history = histories.get(conversationId);
        if (!history) {
          histories.set(conversationId, delta);
          continue;
        }
        for (const tool of delta.tools) {
          history.tools.add(tool);
        }
        for (const [agentKey, agent] of delta.agents) {
          agent.count += history.agents.get(agentKey)?.count ?? 0;
          history.agents.set(agentKey, agent);
        }
      }
      start = end;
    }
  }

  /** Repair legacy compact usage only when a retained response proves the counts. */
  private normalizeRetainedOpenaiUsage(): number {
    let fixed = 0;
    for (const entry of this.capturedRequests) {
      const response = entry.response as Record<string, unknown>;
      const cached = (response.usage as Record<string, unknown> | undefined)
        ?.cache_read_input_tokens;
      if (
        response._contextLensUsageVersion === 1 ||
        !["openai", "chatgpt"].includes(entry.contextInfo.provider) ||
        typeof cached !== "number" ||
        cached <= 0
      ) {
        continue;
      }
      const detailPath = path.join(this.detailDir, `${entry.id}.json`);
      try {
        // Read one existing privacy-filtered payload at a time, never raw archives.
        const detail = JSON.parse(fs.readFileSync(detailPath, "utf8"));
        const retained = parseRetainedExportRecord(detail.exportRecord);
        if (
          !retained ||
          retained.timestamp !== entry.timestamp ||
          retained.gen_ai.request.model !== entry.contextInfo.model ||
          retained.source.tool !== entry.source
        ) {
          continue;
        }
        const body = retained.raw.response_body;
        if (!body) {
          continue;
        }
        let original: ResponseData;
        if (typeof body === "string") {
          original = { streaming: true, chunks: body };
        } else {
          original = body;
        }
        const usage = parseResponseUsage(original);
        if (!usage.hasInputTokens || usage.cacheReadTokens === 0) {
          continue;
        }
        const total =
          usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        rescaleContextTokens(entry.contextInfo, total);
        normalizeComposition(entry.composition, total);
        entry.healthScore = null;
        // Preserve unknown and provider-specific pricing; errors remain unbilled.
        if (entry.costUsd !== null && !isPpqTarget(entry.targetUrl)) {
          if (
            entry.httpStatus !== null &&
            (entry.httpStatus < 200 || entry.httpStatus >= 300)
          ) {
            entry.costUsd = 0;
          } else {
            entry.costUsd = estimateCost(
              entry.contextInfo.model,
              usage.inputTokens,
              usage.outputTokens,
              usage.cacheReadTokens,
              usage.cacheWriteTokens,
            );
          }
        }
        entry.response = original;
        this.compactEntry(entry);
        fixed++;
        if (detail.contextInfo) {
          rescaleContextTokens(detail.contextInfo, total);
          fs.writeFileSync(detailPath, JSON.stringify(detail));
        }
      } catch {
        // Missing or unreadable evidence is never replaced with inferred counts.
      }
    }
    return fixed;
  }

  /**
   * Backfill totalTokens from API usage data for entries that only have estimates.
   * The estimate (chars/4) can be wildly inaccurate; the API's real token count
   * (input + cacheRead + cacheWrite) is authoritative.
   */
  private backfillTotalTokensFromUsage(): number {
    let fixed = 0;
    for (const entry of this.capturedRequests) {
      const usage = parseResponseUsage(entry.response);
      const actual =
        usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      if (
        (usage.hasInputTokens || actual > 0) &&
        actual !== entry.contextInfo.totalTokens
      ) {
        rescaleContextTokens(entry.contextInfo, actual);
        normalizeComposition(entry.composition, actual);
        entry.healthScore = null;
        fixed++;
      }
    }
    if (fixed > 0) {
      console.log(`Fixed totalTokens from API usage for ${fixed} entries`);
    }
    return fixed;
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
    // Skip if this migration has already completed successfully.
    const markerPath = path.join(this.dataDir, ".image-token-migrate-done");
    if (fs.existsSync(markerPath)) return 0;

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
    this.writeMarker(markerPath);
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
          exportRecord: buildLharRecord(
            entry,
            this.capturedRequests,
            this.privacy,
          ),
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

  /** Read one retained record without restoring full contexts to the store. */
  async getExportRecord(
    entry: CapturedEntry,
    privacy: PrivacyLevel,
    archive = new ExportArchive(),
  ): Promise<LharRecord> {
    archive.signal?.throwIfAborted();
    let retained: RetainedExportRecord | undefined;
    try {
      const detail = JSON.parse(
        fs.readFileSync(path.join(this.detailDir, `${entry.id}.json`), "utf8"),
      );
      retained = parseRetainedExportRecord(detail.exportRecord);
    } catch {
      // Legacy entries may only have the append-only LHAR archive.
    }
    if (!retained) {
      const sameTimestamp = this.capturedRequests.filter(
        (candidate) =>
          candidate.conversationId === entry.conversationId &&
          candidate.source === entry.source &&
          candidate.timestamp === entry.timestamp,
      );
      // Legacy archives have no local entry ID. Never guess between tied turns.
      if (sameTimestamp.length === 1) {
        const source = safeFilenamePart(entry.source || "unknown");
        let filename = "ungrouped.lhar";
        if (entry.conversationId) {
          filename = `${source}-${safeFilenamePart(entry.conversationId)}.lhar`;
        }
        try {
          retained = await archive.read(
            path.join(this.dataDir, filename),
            entry.timestamp,
            entry.contextInfo.model,
            entry.source || "unknown",
          );
        } catch {
          // Missing or concurrently removed payloads remain unavailable.
        }
      }
    }
    archive.signal?.throwIfAborted();
    const record = buildLharRecord(entry, this.capturedRequests, privacy);
    // Usage and costs come from current state, including asynchronous repricing.
    // Payloads and request parameters come only from the retained record.
    record.raw = { request_body: null, response_body: null };
    if (retained) {
      record.gen_ai.request = retained.gen_ai.request;
      record.http.request_headers = redactHeaders(
        retained.http.request_headers,
      );
      record.http.response_headers = redactHeaders(
        retained.http.response_headers,
      );
      record.http.stream = retained.http.stream;
      record.context_lens.tool_definitions =
        retained.context_lens.tool_definitions;
      record.context_lens.tool_calls = retained.context_lens.tool_calls;
      if (privacy === "full") {
        record.raw = retained.raw;
      }
    }
    if (privacy === "minimal") {
      record.http.request_headers = {};
      record.http.response_headers = {};
    }
    return record;
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
        // Handle thinking blocks and other unknown types; truncate text-like fields.
        // Use typed narrowing so this stays correct when new block types are added.
        const fallback = b as Record<string, unknown>;
        if (typeof fallback.thinking === "string")
          return {
            ...fallback,
            thinking: fallback.thinking.slice(0, limit),
          } as unknown as ContentBlock;
        if (typeof fallback.text === "string")
          return {
            ...fallback,
            text: fallback.text.slice(0, limit),
          } as unknown as ContentBlock;
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
    let inputTokens: number | undefined;
    if (usage.hasInputTokens) {
      inputTokens = usage.inputTokens;
    }
    entry.response = {
      usage: {
        input_tokens: inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cacheReadTokens,
        cache_creation_input_tokens: usage.cacheWriteTokens,
        thinking_tokens: usage.thinkingTokens,
      },
      model: usage.model,
      // Version 1 stores fresh input with additive cache counts.
      _contextLensUsageVersion: 1,
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

  // ---------------------------------------------------------------------------
  // Context pruning
  // ---------------------------------------------------------------------------

  getPrunedMessages(conversationId: string): string[] {
    return this.conversations.get(conversationId)?.prunedMessages ?? [];
  }

  addPrunedMessage(conversationId: string, messageId: string): void {
    const convo = this.conversations.get(conversationId);
    if (!convo) throw new Error(`Conversation not found: ${conversationId}`);
    const existing = convo.prunedMessages ?? [];
    if (existing.includes(messageId)) return; // already pruned
    convo.prunedMessages = [...existing, messageId];
    this.dataRevision++;
    // Persist the updated conversation row (prunedMessages is part of it)
    this.appendPruneEvent(conversationId);
    this.emitChange("session-updated", conversationId);
  }

  removePrunedMessage(conversationId: string, messageId: string): void {
    const convo = this.conversations.get(conversationId);
    if (!convo) throw new Error(`Conversation not found: ${conversationId}`);
    const existing = convo.prunedMessages ?? [];
    convo.prunedMessages = existing.filter((id) => id !== messageId);
    this.dataRevision++;
    this.appendPruneEvent(conversationId);
    this.emitChange("session-updated", conversationId);
  }

  private appendPruneEvent(conversationId: string): void {
    const convo = this.conversations.get(conversationId);
    if (!convo) return;
    try {
      fs.appendFileSync(
        this.stateFile,
        `${JSON.stringify({ type: "conversation", data: convo })}\n`,
      );
    } catch (err: unknown) {
      console.error(
        "Prune state append error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Extract plain text from a response for output security scanning.
 * Returns null if the response has no readable text content.
 */
function extractResponseText(response: ResponseData): string | null {
  if (!response) return null;

  // Streaming: raw SSE chunks
  if (
    "streaming" in response &&
    response.streaming &&
    typeof response.chunks === "string"
  ) {
    return response.chunks;
  }

  // Raw string body
  if ("raw" in response && typeof response.raw === "string") {
    return response.raw;
  }

  // Parsed JSON body — try common response shapes
  const r = response as Record<string, unknown>;

  // Anthropic: content blocks
  if (Array.isArray(r.content)) {
    return (r.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }

  // OpenAI: choices[].message.content
  if (Array.isArray(r.choices)) {
    return (r.choices as Array<Record<string, unknown>>)
      .map((c) => {
        const msg = c.message as Record<string, unknown> | undefined;
        return typeof msg?.content === "string" ? msg.content : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  // Gemini: candidates[].content.parts[].text
  if (Array.isArray(r.candidates)) {
    return (r.candidates as Array<Record<string, unknown>>)
      .flatMap((c) => {
        const content = c.content as Record<string, unknown> | undefined;
        const parts = content?.parts as
          | Array<Record<string, unknown>>
          | undefined;
        return (
          parts?.map((p) => (typeof p.text === "string" ? p.text : "")) ?? []
        );
      })
      .filter(Boolean)
      .join("\n");
  }

  return null;
}
