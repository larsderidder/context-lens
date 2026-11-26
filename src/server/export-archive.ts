import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import * as v from "valibot";

const JsonObject = v.record(v.string(), v.unknown());
const RetainedExportRecordSchema = v.object({
  type: v.literal("entry"),
  timestamp: v.string(),
  source: v.object({ tool: v.string() }),
  gen_ai: v.object({
    request: v.object({
      model: v.string(),
      max_tokens: v.nullable(v.number()),
      temperature: v.nullable(v.number()),
      top_p: v.nullable(v.number()),
      stop_sequences: v.array(v.string()),
    }),
  }),
  http: v.object({
    stream: v.boolean(),
    request_headers: v.record(v.string(), v.string()),
    response_headers: v.record(v.string(), v.string()),
  }),
  context_lens: v.object({
    tool_definitions: v.optional(
      v.array(
        v.object({ name: v.string(), description: v.nullable(v.string()) }),
      ),
    ),
    tool_calls: v.optional(
      v.array(
        v.object({
          name: v.string(),
          call_id: v.nullable(v.string()),
          arguments: v.nullable(v.union([JsonObject, v.string()])),
        }),
      ),
    ),
  }),
  raw: v.object({
    request_body: v.nullable(JsonObject),
    response_body: v.nullable(v.union([JsonObject, v.string()])),
  }),
});

export type RetainedExportRecord = v.InferOutput<
  typeof RetainedExportRecordSchema
>;

/** Validate only retained fields used by exports, never trust a disk type assertion. */
export function parseRetainedExportRecord(
  value: unknown,
): RetainedExportRecord | undefined {
  const result = v.safeParse(RetainedExportRecordSchema, value);
  if (result.success) {
    return result.output;
  }
  return undefined;
}

type Location = { start: number; length: number };

/** Export-scoped byte indexes retain locations, never archive payloads. */
export class ExportArchive {
  private readonly indexes = new Map<string, Map<string, Location>>();

  constructor(
    readonly signal?: AbortSignal,
    private readonly openStream = createReadStream,
  ) {}

  /** Read the last valid update of a uniquely identified legacy turn. */
  async read(
    file: string,
    timestamp: string,
    model: string,
    source: string,
  ): Promise<RetainedExportRecord | undefined> {
    this.signal?.throwIfAborted();
    let index = this.indexes.get(file);
    if (!index) {
      const builtIndex = new Map<string, Location>();
      index = builtIndex;
      let pending = Buffer.alloc(0);
      let start = 0;
      const indexLine = (line: Buffer, length: number) => {
        this.signal?.throwIfAborted();
        try {
          const record = parseRetainedExportRecord(
            JSON.parse(line.toString("utf8")),
          );
          if (record) {
            builtIndex.set(
              JSON.stringify([
                record.timestamp,
                record.gen_ai.request.model,
                record.source.tool,
              ]),
              { start, length },
            );
          }
        } catch {
          // Invalid tails must not replace a previous valid update.
        }
        start += length;
      };
      const input = this.openStream(file);
      const abort = () => {
        input.destroy();
      };
      this.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.signal?.throwIfAborted();
        for await (const chunk of input) {
          this.signal?.throwIfAborted();
          pending = Buffer.concat([pending, chunk]);
          let newline = pending.indexOf(10);
          while (newline !== -1) {
            const length = newline + 1;
            indexLine(pending.subarray(0, newline), length);
            pending = pending.subarray(length);
            newline = pending.indexOf(10);
          }
        }
        this.signal?.throwIfAborted();
        if (pending.length > 0) {
          indexLine(pending, pending.length);
        }
        // Never reuse a partial index after failure or cancellation.
        this.indexes.set(file, index);
      } catch (error) {
        this.signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        return undefined;
      } finally {
        this.signal?.removeEventListener("abort", abort);
        input.destroy();
      }
    }
    this.signal?.throwIfAborted();
    const location = index.get(JSON.stringify([timestamp, model, source]));
    if (!location) {
      return undefined;
    }
    const handle = await open(file, "r");
    try {
      this.signal?.throwIfAborted();
      const buffer = Buffer.alloc(location.length);
      let offset = 0;
      while (offset < buffer.length) {
        this.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          location.start + offset,
        );
        this.signal?.throwIfAborted();
        if (!bytesRead) {
          return undefined;
        }
        offset += bytesRead;
      }
      return parseRetainedExportRecord(JSON.parse(buffer.toString("utf8")));
    } finally {
      await handle.close();
    }
  }
}
