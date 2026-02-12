import type { LharJsonWrapper } from "../lhar-types.generated.js";
import type { CapturedEntry, Conversation, PrivacyLevel } from "../types.js";
import { VERSION } from "../version.generated.js";
import {
  buildLharRecord,
  buildSessionLine,
  traceIdFromConversation,
} from "./record.js";

const COLLECTOR_NAME = "context-lens";
const COLLECTOR_VERSION = VERSION;
const LHAR_VERSION = "0.1.0";

export function toLharJsonl(
  entries: CapturedEntry[],
  conversations: Map<string, Conversation>,
  privacy: PrivacyLevel = "standard",
): string {
  // Sort oldest-first for JSONL
  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const lines: string[] = [];
  const emittedSessions = new Set<string>();

  for (const entry of sorted) {
    const record = buildLharRecord(entry, entries, privacy);

    // Emit session preamble on first occurrence of each trace_id
    if (!emittedSessions.has(record.trace_id)) {
      emittedSessions.add(record.trace_id);
      const convo = entry.conversationId
        ? conversations.get(entry.conversationId)
        : undefined;
      if (convo) {
        lines.push(
          JSON.stringify(
            buildSessionLine(
              entry.conversationId!,
              convo,
              record.gen_ai.request.model,
            ),
          ),
        );
      }
    }

    lines.push(JSON.stringify(record));
  }

  return `${lines.join("\n")}\n`;
}

export function toLharJson(
  entries: CapturedEntry[],
  conversations: Map<string, Conversation>,
  privacy: PrivacyLevel = "standard",
): LharJsonWrapper {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const records = sorted.map((entry) =>
    buildLharRecord(entry, entries, privacy),
  );

  // Build sessions from conversations map
  const sessions: LharJsonWrapper["lhar"]["sessions"] = [];
  const seenTraces = new Set<string>();
  for (const record of records) {
    if (!seenTraces.has(record.trace_id)) {
      seenTraces.add(record.trace_id);
      const convo = record.trace_id
        ? Array.from(conversations.values()).find(
            (c) => traceIdFromConversation(c.id) === record.trace_id,
          )
        : undefined;
      sessions.push({
        trace_id: record.trace_id,
        started_at: convo?.firstSeen || record.timestamp,
        tool: record.source.tool,
        model: record.gen_ai.request.model,
      });
    }
  }

  return {
    lhar: {
      version: LHAR_VERSION,
      creator: {
        name: COLLECTOR_NAME,
        version: COLLECTOR_VERSION,
      },
      sessions,
      entries: records,
    },
  };
}
