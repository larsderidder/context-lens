/**
 * CLI session importer — entry point.
 *
 * Discovers and imports sessions from all supported tools into
 * the context-lens store. Tracks which sessions have already been
 * imported via a Set of sessionIds stored on the Store itself to
 * avoid duplicating entries on repeated scans.
 */

import type { JsonValue } from "@contextio/core";
import { ingestCapture } from "../analysis/ingest.js";
import type { Store } from "../server/store.js";
import {
  discoverClaudeCodeSessions,
  parseClaudeCodeSession,
} from "./claude-code.js";
import { discoverCodexSessions, parseCodexSession } from "./codex.js";
import type { ImportedSession, ImportedTurn, ImportSummary } from "./types.js";

/**
 * Convert one ImportedTurn into a CaptureData-like object and ingest it.
 *
 * We reconstruct a synthetic Anthropic/OpenAI request body from the
 * messages accumulated up to that turn, then feed it through the
 * existing ingestCapture pipeline.
 */
function ingestTurn(
  store: Store,
  session: ImportedSession,
  turn: ImportedTurn,
): void {
  // Build a synthetic request body that parseContextInfo can handle.
  // For Anthropic format: { model, messages, system? }
  // For OpenAI Responses format: { model, input: [...] }
  let requestBody: Record<string, unknown>;

  if (session.apiFormat === "anthropic-messages") {
    const systemMessages = turn.messages.filter((m) => m.role === "system");
    const nonSystem = turn.messages.filter((m) => m.role !== "system");
    requestBody = {
      model: session.model,
      messages: nonSystem,
      ...(systemMessages.length > 0
        ? { system: systemMessages.map((m) => m.content).join("\n") }
        : {}),
    };
  } else {
    // Responses API format (codex)
    requestBody = {
      model: session.model,
      input: turn.messages.map((m) => ({
        type: "message",
        role: m.role,
        content: m.content,
      })),
    };
  }

  // Build a synthetic response body with token usage so the store
  // can record accurate cost without needing to re-estimate.
  const responseBody: Record<string, unknown> =
    session.provider === "anthropic"
      ? {
          type: "message",
          role: "assistant",
          model: session.model,
          usage: {
            input_tokens: turn.inputTokens ?? undefined,
            output_tokens: turn.outputTokens ?? 0,
            cache_read_input_tokens: turn.cacheReadTokens ?? 0,
            cache_creation_input_tokens: turn.cacheWriteTokens ?? 0,
          },
          content: [],
          stop_reason: "end_turn",
        }
      : {
          object: "response",
          model: session.model,
          usage: {
            input_tokens: turn.inputTokens ?? undefined,
            output_tokens: turn.outputTokens ?? 0,
            cache_read_input_tokens: turn.cacheReadTokens ?? 0,
            cache_creation_input_tokens: turn.cacheWriteTokens ?? 0,
            total_tokens: (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0),
          },
          output: [],
          status: "completed",
        };

  ingestCapture(store, {
    provider: session.provider,
    apiFormat: session.apiFormat,
    source: session.source,
    path:
      session.apiFormat === "anthropic-messages"
        ? "/v1/messages"
        : "/responses",
    method: "POST",
    timestamp: turn.timestamp,
    requestBody: requestBody as JsonValue,
    responseBody: JSON.stringify(responseBody),
    responseStatus: 200,
    responseIsStreaming: false,
    targetUrl: "",
    requestHeaders: {},
    responseHeaders: {},
    timings: { send_ms: 0, wait_ms: 0, receive_ms: 0, total_ms: 0 },
    requestBytes: 0,
    responseBytes: 0,
    sessionId: session.sessionId,
  });
}

export function importSessions(store: Store): ImportSummary[] {
  const summaries: ImportSummary[] = [];

  const importers: Array<{
    source: string;
    discover: () => string[];
    parse: (f: string) => ImportedSession | null;
  }> = [
    {
      source: "claude-code",
      discover: discoverClaudeCodeSessions,
      parse: parseClaudeCodeSession,
    },
    {
      source: "codex",
      discover: discoverCodexSessions,
      parse: parseCodexSession,
    },
  ];

  for (const importer of importers) {
    const summary: ImportSummary = {
      source: importer.source,
      found: 0,
      imported: 0,
      skipped: 0,
      errors: 0,
    };

    let files: string[];
    try {
      files = importer.discover();
    } catch {
      summaries.push(summary);
      continue;
    }

    summary.found = files.length;

    for (const file of files) {
      try {
        const session = importer.parse(file);
        if (!session || session.turns.length === 0) {
          summary.skipped++;
          continue;
        }

        if (store.hasImportedSession(session.sessionId)) {
          summary.skipped++;
          continue;
        }

        for (const turn of session.turns) {
          ingestTurn(store, session, turn);
        }

        store.markSessionImported(session.sessionId);
        summary.imported++;

        console.log(
          `  📂 Imported [${session.source}] ${session.sessionId.slice(0, 8)}… (${session.turns.length} turns) from ${session.cwd ?? "unknown"}`,
        );
      } catch (err) {
        summary.errors++;
        console.error(
          `  ⚠️  Import error [${importer.source}] ${file}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    summaries.push(summary);
  }

  return summaries;
}
