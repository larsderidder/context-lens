/**
 * Context pruning proxy plugin.
 *
 * On each outgoing request, derives the conversation ID from the URL
 * session tag (ctx.sessionId), fetches the prune list from the analysis
 * server, and removes pruned messages before forwarding.
 *
 * Identity scheme (must match ui/src/utils/prune.ts):
 * - tool_result → "tool_result:{tool_use_id}"
 * - tool_use    → "tool_use:{id}"
 * - everything  → "{role}:{index}" (position in messages array)
 */

import { createHash } from "node:crypto";
import * as http from "node:http";
import type { ProxyPlugin, RequestContext } from "@contextio/core";

// Analysis traffic must not inherit the provider egress proxy.
const directAnalysisAgent = new http.Agent({ proxyEnv: {} });

// ---------------------------------------------------------------------------
// Message identity — index-based, no hashing
// ---------------------------------------------------------------------------

function messageIdAt(msg: unknown, index: number): string {
  if (!msg || typeof msg !== "object") return `unknown:${index}`;
  const m = msg as Record<string, unknown>;

  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        return `tool_result:${b.tool_use_id}`;
      }
      if (b.type === "tool_use" && typeof b.id === "string") {
        return `tool_use:${b.id}`;
      }
    }
  }

  const role = typeof m.role === "string" ? m.role : "unknown";
  return `${role}:${index}`;
}

// ---------------------------------------------------------------------------
// Prune fetch
// ---------------------------------------------------------------------------

async function fetchPrunedMessages(
  analysisUrl: string,
  conversationId: string,
): Promise<string[]> {
  return new Promise((resolve) => {
    const url = `${analysisUrl}/api/sessions/${encodeURIComponent(conversationId)}/prunes`;
    const parsed = new URL(url);
    const req = http.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || 4041,
        path: parsed.pathname + parsed.search,
        timeout: 500,
        agent: directAnalysisAgent,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          try {
            const json = JSON.parse(data) as { prunedMessages?: string[] };
            resolve(json.prunedMessages ?? []);
          } catch {
            resolve([]);
          }
        });
      },
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function createPrunePlugin(analysisUrl: string): ProxyPlugin {
  return {
    name: "context-lens-prune",

    async onRequest(ctx: RequestContext): Promise<RequestContext> {
      const body = ctx.body as Record<string, unknown> | null;
      if (!body || !Array.isArray(body.messages)) return ctx;
      if (body.messages.length === 0) return ctx;

      // Session tag from URL path (e.g. /pi/ab12cd34/v1/messages)
      if (!ctx.sessionId) return ctx;

      // Derive conversation ID: SHA256(sessionTag)[0:16]
      // Matches the store's derivation in Store.storeRequest()
      const conversationId = createHash("sha256")
        .update(ctx.sessionId)
        .digest("hex")
        .slice(0, 16);

      const pruned = await fetchPrunedMessages(analysisUrl, conversationId);
      if (pruned.length === 0) return ctx;

      const prunedSet = new Set(pruned);
      const originalCount = body.messages.length;

      const filtered = (body.messages as unknown[]).filter((msg, index) => {
        const id = messageIdAt(msg, index);
        return !prunedSet.has(id);
      });

      if (filtered.length === originalCount) return ctx;

      console.log(
        `[prune] Removed ${originalCount - filtered.length} pruned message(s) ` +
          `from conversation ${conversationId}`,
      );

      const newBody = {
        ...body,
        messages: filtered,
      } as import("@contextio/core").JsonValue;
      return { ...ctx, body: newBody };
    },
  };
}
