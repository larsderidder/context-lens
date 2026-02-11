import type http from "node:http";
import url from "node:url";

import { parseContextInfo } from "../core.js";
import { toLharJson, toLharJsonl } from "../lhar.js";
import type { AgentGroup, CapturedEntry, ConversationGroup } from "../types.js";
import { projectEntry } from "./projection.js";
import type { Store } from "./store.js";

function projectEntryForApi(e: CapturedEntry) {
  return projectEntry(e, e.contextInfo);
}

function handleIngest(
  store: Store,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  const bodyChunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    bodyChunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const data = JSON.parse(Buffer.concat(bodyChunks).toString("utf8"));
      const provider = data.provider || "unknown";
      const apiFormat = data.apiFormat || "unknown";
      const source = data.source || "unknown";
      const contextInfo = parseContextInfo(
        provider,
        data.body || {},
        apiFormat,
      );
      store.storeRequest(
        contextInfo,
        data.response || {},
        source,
        data.body || {},
      );
      console.log(
        `  📥 Ingested: [${provider}] ${contextInfo.model} from ${source}`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("Ingest error:", message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  });
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

function handleRequests(
  store: Store,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: url.UrlWithParsedQuery,
): void {
  const isSummary = parsedUrl.query.summary === "true";
  const { grouped, ungrouped } = buildConversationGroups(store);
  const conversations = store.getConversations();

  if (isSummary) {
    // Lightweight: conversation metadata + summary stats, no entries
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
      const totalCost = entries.reduce(
        (sum, e) => sum + (e.costUsd ?? 0),
        0,
      );
      summaries.push({
        ...meta,
        entryCount: entries.length,
        latestTimestamp: latest.timestamp,
        latestModel: latest.contextInfo.model,
        latestTotalTokens: latest.contextInfo.totalTokens,
        contextLimit: latest.contextLimit,
        totalCost,
        healthScore: latest.healthScore,
      });
    }
    summaries.sort(
      (a, b) =>
        new Date(b.latestTimestamp).getTime() -
        new Date(a.latestTimestamp).getTime(),
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        revision: store.getRevision(),
        conversations: summaries,
        ungroupedCount: ungrouped.length,
      }),
    );
    return;
  }

  // Full response (backwards compatible)
  const convos: ConversationGroup[] = [];
  for (const [id, entries] of grouped) {
    convos.push(buildFullConversation(id, entries, conversations));
  }
  convos.sort(
    (a, b) =>
      new Date(b.entries[0].timestamp).getTime() -
      new Date(a.entries[0].timestamp).getTime(),
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      revision: store.getRevision(),
      conversations: convos,
      ungrouped: ungrouped.map(projectEntryForApi),
    }),
  );
}

function handleConversationDetail(
  store: Store,
  convoId: string,
  res: http.ServerResponse,
): void {
  const { grouped } = buildConversationGroups(store);
  const conversations = store.getConversations();
  const entries = grouped.get(convoId);

  if (!entries || entries.length === 0) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Conversation not found" }));
    return;
  }

  const convo = buildFullConversation(convoId, entries, conversations);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(convo));
}

function handleEvents(
  store: Store,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial revision so client knows current state
  const initial = JSON.stringify({
    revision: store.getRevision(),
    type: "connected",
  });
  res.write(`data: ${initial}\n\n`);

  const listener = (event: {
    type: string;
    revision: number;
    conversationId?: string | null;
  }) => {
    const data = JSON.stringify(event);
    res.write(`data: ${data}\n\n`);
  };

  store.on("change", listener);

  // Clean up when client disconnects
  _req.on("close", () => {
    store.off("change", listener);
  });
}

function handleExportLhar(
  store: Store,
  parsedUrl: url.UrlWithParsedQuery,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const convoFilter = parsedUrl.query.conversation as string | undefined;
  const entries = convoFilter
    ? store
        .getCapturedRequests()
        .filter((e) => e.conversationId === convoFilter)
    : store.getCapturedRequests();
  const jsonl = toLharJsonl(entries, store.getConversations());
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Content-Disposition": 'attachment; filename="context-lens-export.lhar"',
  });
  res.end(jsonl);
}

function handleExportLharJson(
  store: Store,
  parsedUrl: url.UrlWithParsedQuery,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const convoFilter = parsedUrl.query.conversation as string | undefined;
  const entries = convoFilter
    ? store
        .getCapturedRequests()
        .filter((e) => e.conversationId === convoFilter)
    : store.getCapturedRequests();
  const wrapped = toLharJson(entries, store.getConversations());
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Disposition":
      'attachment; filename="context-lens-export.lhar.json"',
  });
  res.end(JSON.stringify(wrapped, null, 2));
}

/**
 * Create an API-only request handler. Returns true if the request was handled,
 * false if it should fall through to static file serving.
 */
export function createApiHandler(
  store: Store,
): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  return function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): boolean {
    const parsedUrl = url.parse(req.url!, true);
    const pathname = parsedUrl.pathname;

    if (pathname === "/api/ingest" && req.method === "POST") {
      handleIngest(store, req, res);
      return true;
    }

    const convoMatch = pathname?.match(
      /^\/api\/conversations\/(.+)$/,
    );
    if (convoMatch && req.method === "DELETE") {
      const convoId = decodeURIComponent(convoMatch[1]);
      store.deleteConversation(convoId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    if (convoMatch && req.method === "GET") {
      const convoId = decodeURIComponent(convoMatch[1]);
      handleConversationDetail(store, convoId, res);
      return true;
    }

    if (pathname === "/api/reset" && req.method === "POST") {
      store.resetAll();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    if (pathname === "/api/requests") {
      handleRequests(store, req, res, parsedUrl);
      return true;
    }

    if (pathname === "/api/events") {
      handleEvents(store, req, res);
      return true;
    }

    if (pathname === "/api/export/lhar") {
      handleExportLhar(store, parsedUrl, req, res);
      return true;
    }

    if (pathname === "/api/export/lhar.json") {
      handleExportLharJson(store, parsedUrl, req, res);
      return true;
    }

    return false;
  };
}
