import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as v from "valibot";

import { parseContextInfo } from "../core.js";
import { toLharJson, toLharJsonl } from "../lhar.js";
import { IngestPayloadSchema } from "../schemas.js";
import type { AgentGroup, CapturedEntry, ConversationGroup, PrivacyLevel } from "../types.js";
import { projectEntry } from "./projection.js";
import type { Store } from "./store.js";

function projectEntryForApi(e: CapturedEntry) {
  return projectEntry(e, e.contextInfo);
}

function getExportEntries(
  store: Store,
  conversation?: string,
): CapturedEntry[] {
  if (!conversation) return store.getCapturedRequests();
  return store
    .getCapturedRequests()
    .filter((e) => e.conversationId === conversation);
}

function sanitizeFilenamePart(
  input: string | null | undefined,
  fallback: string,
): string {
  const sanitized = String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return sanitized || fallback;
}

function buildExportFilename(
  format: "lhar" | "lhar.json",
  conversation: string | null | undefined,
  privacy: PrivacyLevel,
): string {
  const sessionPart = `session-${sanitizeFilenamePart(conversation, "all")}`;
  const privacyPart = `privacy-${sanitizeFilenamePart(privacy, "standard")}`;
  const ext = format === "lhar" ? "lhar" : "lhar.json";
  return `context-lens-export-${sessionPart}-${privacyPart}.${ext}`;
}

/**
 * Group captured requests into conversations with agents.
 * Shared by both full and summary endpoints.
 */
function buildConversationGroups(store: Store): {
  grouped: Map<string, CapturedEntry[]>;
  ungrouped: CapturedEntry[];
} {
  const capturedRequests = store.getCapturedRequests();
  const grouped = new Map<string, CapturedEntry[]>();
  const ungrouped: CapturedEntry[] = [];
  for (const entry of capturedRequests) {
    if (entry.conversationId) {
      if (!grouped.has(entry.conversationId))
        grouped.set(entry.conversationId, []);
      grouped.get(entry.conversationId)?.push(entry);
    } else {
      ungrouped.push(entry);
    }
  }
  return { grouped, ungrouped };
}

function buildFullConversation(
  id: string,
  entries: CapturedEntry[],
  conversations: Map<string, any>,
): ConversationGroup {
  const meta = conversations.get(id) || {
    id,
    label: "Unknown",
    source: "unknown",
    workingDirectory: null,
    firstSeen: entries[entries.length - 1].timestamp,
  };
  const agentMap = new Map<string, CapturedEntry[]>();
  for (const e of entries) {
    const ak = e.agentKey || "_default";
    if (!agentMap.has(ak)) agentMap.set(ak, []);
    agentMap.get(ak)?.push(e);
  }
  const agents: AgentGroup[] = [];
  for (const [_ak, agentEntries] of agentMap) {
    agents.push({
      key: _ak,
      label: agentEntries[agentEntries.length - 1].agentLabel || "Unnamed",
      model: agentEntries[0].contextInfo.model,
      entries: agentEntries.map(projectEntryForApi),
    });
  }
  agents.sort(
    (a, b) =>
      new Date(b.entries[0].timestamp).getTime() -
      new Date(a.entries[0].timestamp).getTime(),
  );
  return {
    ...meta,
    agents,
    entries: entries.map(projectEntryForApi),
  };
}

/**
 * Create the Hono app with all API routes.
 */
export function createApiApp(store: Store): Hono {
  const app = new Hono();

  // --- Ingest ---

  app.post("/api/ingest", async (c) => {
    const raw = await c.req.json();
    const result = v.safeParse(IngestPayloadSchema, raw);
    if (!result.success) {
      const message = v.summarize(result.issues);
      console.error("Ingest validation error:", message);
      return c.json({ error: message }, 400);
    }
    const data = result.output;
    const contextInfo = parseContextInfo(
      data.provider,
      data.body,
      data.apiFormat,
    );
    store.storeRequest(contextInfo, data.response, data.source, data.body);
    console.log(
      `  📥 Ingested: [${data.provider}] ${contextInfo.model} from ${data.source}`,
    );
    return c.json({ ok: true });
  });

  // --- Entry detail ---

  app.get("/api/entries/:id/detail", (c) => {
    const entryId = parseInt(c.req.param("id"), 10);
    const contextInfo = store.getEntryDetail(entryId);
    if (contextInfo) {
      return c.json({ contextInfo });
    }
    return c.json({ error: "Detail not found for this entry" }, 404);
  });

  // --- Conversations ---

  app.delete("/api/conversations/:id", (c) => {
    const convoId = decodeURIComponent(c.req.param("id"));
    store.deleteConversation(convoId);
    return c.json({ ok: true });
  });

  app.get("/api/conversations/:id", (c) => {
    const convoId = decodeURIComponent(c.req.param("id"));
    const { grouped } = buildConversationGroups(store);
    const conversations = store.getConversations();
    const entries = grouped.get(convoId);

    if (!entries || entries.length === 0) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return c.json(buildFullConversation(convoId, entries, conversations));
  });

  // --- Reset ---

  app.post("/api/reset", (c) => {
    store.resetAll();
    return c.json({ ok: true });
  });

  // --- Requests (summary + full) ---

  app.get("/api/requests", (c) => {
    const isSummary = c.req.query("summary") === "true";
    const { grouped, ungrouped } = buildConversationGroups(store);
    const conversations = store.getConversations();

    if (isSummary) {
      const summaries = [];
      for (const [id, entries] of grouped) {
        const meta = conversations.get(id) || {
          id,
          label: "Unknown",
          source: "unknown",
          workingDirectory: null,
          firstSeen: entries[entries.length - 1].timestamp,
        };
        const latest = entries[0];
        const totalCost = entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);

        const keyCounts = new Map<string, number>();
        for (const e of entries) {
          const k = e.agentKey || "_default";
          keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
        }
        let mainKey = "_default";
        let maxCount = 0;
        for (const [k, count] of keyCounts) {
          if (count > maxCount) {
            mainKey = k;
            maxCount = count;
          }
        }
        const tokenHistory: number[] = [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const k = entries[i].agentKey || "_default";
          if (k === mainKey) {
            tokenHistory.push(entries[i].contextInfo.totalTokens);
          }
        }

        summaries.push({
          ...meta,
          entryCount: entries.length,
          latestTimestamp: latest.timestamp,
          latestModel: latest.contextInfo.model,
          latestTotalTokens: latest.contextInfo.totalTokens,
          contextLimit: latest.contextLimit,
          totalCost,
          healthScore: latest.healthScore,
          tokenHistory,
        });
      }
      summaries.sort(
        (a, b) =>
          new Date(b.latestTimestamp).getTime() -
          new Date(a.latestTimestamp).getTime(),
      );
      return c.json({
        revision: store.getRevision(),
        conversations: summaries,
        ungroupedCount: ungrouped.length,
      });
    }

    // Full response
    const convos: ConversationGroup[] = [];
    for (const [id, entries] of grouped) {
      convos.push(buildFullConversation(id, entries, conversations));
    }
    convos.sort(
      (a, b) =>
        new Date(b.entries[0].timestamp).getTime() -
        new Date(a.entries[0].timestamp).getTime(),
    );
    return c.json({
      revision: store.getRevision(),
      conversations: convos,
      ungrouped: ungrouped.map(projectEntryForApi),
    });
  });

  // --- SSE events ---

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const initial = JSON.stringify({
        revision: store.getRevision(),
        type: "connected",
      });
      await stream.writeSSE({ data: initial });

      const listener = (event: {
        type: string;
        revision: number;
        conversationId?: string | null;
      }) => {
        const data = JSON.stringify(event);
        stream.writeSSE({ data }).catch(() => {
          // Client disconnected
        });
      };

      store.on("change", listener);
      stream.onAbort(() => {
        store.off("change", listener);
      });

      // Keep the stream open until the client disconnects
      await new Promise(() => {});
    });
  });

  // --- Export ---

  app.get("/api/export/lhar", (c) => {
    const conversation = c.req.query("conversation");
    const privacy = (c.req.query("privacy") || "standard") as PrivacyLevel;
    const entries = getExportEntries(store, conversation);
    const jsonl = toLharJsonl(entries, store.getConversations(), privacy);
    const filename = buildExportFilename("lhar", conversation, privacy);
    c.header(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    return c.text(jsonl, 200, {
      "Content-Type": "application/x-ndjson",
    });
  });

  app.get("/api/export/lhar.json", (c) => {
    const conversation = c.req.query("conversation");
    const privacy = (c.req.query("privacy") || "standard") as PrivacyLevel;
    const entries = getExportEntries(store, conversation);
    const wrapped = toLharJson(entries, store.getConversations(), privacy);
    const filename = buildExportFilename("lhar.json", conversation, privacy);
    c.header(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    return c.json(wrapped);
  });

  return app;
}
