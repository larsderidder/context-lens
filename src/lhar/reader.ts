/**
 * LHAR file reader: parses .lhar (JSONL) files into typed records.
 */

import fs from "node:fs";
import type { LharRecord, LharSessionLine } from "../lhar-types.generated.js";

export interface ParsedLhar {
  session: LharSessionLine | null;
  entries: LharRecord[];
}

/**
 * Parse an LHAR file (JSONL format) into a session header and entry records.
 *
 * Skips blank lines and lines that don't parse as valid JSON.
 * The first `{"type":"session",...}` line becomes the session header;
 * all `{"type":"entry",...}` lines become entries.
 */
export function readLharFile(filepath: string): ParsedLhar {
  const content = fs.readFileSync(filepath, "utf8");
  return parseLharContent(content);
}

/**
 * Parse LHAR content (JSONL string) without file I/O.
 * Useful for testing and for piped input.
 */
export function parseLharContent(content: string): ParsedLhar {
  let session: LharSessionLine | null = null;
  const entries: LharRecord[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (rec.type === "session") {
      session = rec as unknown as LharSessionLine;
    } else if (rec.type === "entry") {
      entries.push(rec as unknown as LharRecord);
    }
  }

  return { session, entries };
}
