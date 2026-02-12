# LHAR Format

**LHAR** (LLM HTTP Archive) is to LLM API calls what HAR is for web traffic: a structured format for recording, analyzing, and sharing context window interactions.

Context Lens exports each session as an `.lhar` file. You can load these into other tools, build your own analyzers, or keep them as debugging artifacts.

## Structure

LHAR files use **JSON Lines** format (newline-delimited JSON):

```jsonl
{"type":"session","trace_id":"abc123",...}
{"type":"entry","trace_id":"abc123",...}
{"type":"entry","trace_id":"abc123",...}
```

Each line is a complete JSON object. The first line declares the session, subsequent lines are entries (API calls).

For tools that need wrapped JSON, there's also `.lhar.json`:

```json
{
  "lhar": {
    "version": "0.1.0",
    "creator": { "name": "context-lens", "version": "0.2.1" },
    "sessions": [...],
    "entries": [...]
  }
}
```

Same data, different packaging. Use `.lhar` for streaming/append workflows, `.lhar.json` for static analysis.

## Records

### Session Line

Identifies the trace and declares metadata:

```json
{
  "type": "session",
  "trace_id": "6590f363c1bc200989bd4ed1956b00bc",
  "started_at": "2026-02-10T12:00:00.000Z",
  "tool": "claude",
  "model": "claude-sonnet-4-20250514"
}
```

- `trace_id`: unique identifier for the entire conversation session (SHA-256 hash of the internal conversation ID, truncated to 32 hex chars)
- `started_at`: ISO 8601 timestamp of first API call
- `tool`: detected tool name (`claude`, `aider`, `codex`, `pi`, etc.)
- `model`: primary model used in session

### Entry Record

One API call. Top-level fields:

```json
{
  "type": "entry",
  "id": "4bac36b9-12b6-4abe-b503-510e09a32559",
  "trace_id": "6590f363c1bc200989bd4ed1956b00bc",
  "span_id": "4446237b013c705b",
  "parent_span_id": null,
  "timestamp": "2026-02-10T12:00:01.000Z",
  "sequence": 1,
  "source": {...},
  "gen_ai": {...},
  "usage_ext": {...},
  "http": {...},
  "timings": {...},
  "transfer": {...},
  "context_lens": {...},
  "raw": {...}
}
```

- `id`: UUID for this entry
- `trace_id`: links back to session
- `span_id` / `parent_span_id`: OpenTelemetry-style span hierarchy for subagents
- `timestamp`: when the request was captured
- `sequence`: turn number within the conversation (1-indexed)

## Namespaces

Entry data is grouped into seven namespaces.

### `source`

Where the request came from:

```json
{
  "tool": "claude",
  "tool_version": null,
  "agent_role": "main",
  "collector": "context-lens",
  "collector_version": "0.2.1"
}
```

- `tool`: detected tool name
- `tool_version`: tool version if detectable, otherwise `null`
- `agent_role`: `main` or `subagent` (the most frequent agent key in the conversation is considered "main")
- `collector`: always `context-lens`
- `collector_version`: Context Lens version that captured this entry

### `gen_ai`

LLM request/response metadata. Follows [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) where possible:

```json
{
  "system": "anthropic",
  "request": {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 8192,
    "temperature": 1.0,
    "top_p": null,
    "stop_sequences": []
  },
  "response": {
    "model": "claude-sonnet-4-20250514",
    "finish_reasons": ["end_turn"]
  },
  "usage": {
    "input_tokens": 12340,
    "output_tokens": 567,
    "total_tokens": 12907
  }
}
```

- `system`: provider identifier (`anthropic`, `openai`, `google`, etc.)
- `request.model`: model as requested
- `response.model`: model as reported by the API (may differ, `null` if unavailable)
- `usage`: standard token counts. `input_tokens` is the base input count (excluding cache tokens). `total_tokens` = `input_tokens` + `output_tokens`

### `usage_ext`

Provider-specific usage extensions that don't fit the standard GenAI conventions:

```json
{
  "cache_read_tokens": 11000,
  "cache_write_tokens": 1200,
  "cost_usd": 0.0234
}
```

- `cache_read_tokens`: tokens served from prompt cache
- `cache_write_tokens`: tokens written to prompt cache
- `cost_usd`: estimated total cost in USD based on published model pricing, or `null` if unknown

### `http`

HTTP transport metadata:

```json
{
  "method": "POST",
  "url": "https://api.anthropic.com/v1/messages",
  "status_code": 200,
  "api_format": "anthropic-messages",
  "stream": true,
  "request_headers": {
    "content-type": "application/json",
    "user-agent": "claude-cli/2.1.37 (external, cli)"
  },
  "response_headers": {
    "content-type": "text/event-stream",
    "request-id": "req_011CXxogyDdeg1CmKZhj3RnY"
  }
}
```

- `api_format`: detected API format (`anthropic-messages`, `openai-chat`, `openai-responses`, `google-gemini`, etc.)
- `stream`: whether the request used streaming (SSE)
- Headers are redacted: API keys and other sensitive headers are stripped. Controlled by the `CONTEXT_LENS_PRIVACY` setting.

### `timings`

Request timing breakdown (top-level, not nested inside `http`):

```json
{
  "send_ms": 12,
  "wait_ms": 1834,
  "receive_ms": 2450,
  "total_ms": 4296,
  "tokens_per_second": 17.2
}
```

- `send_ms`: time to send the request
- `wait_ms`: time waiting for first byte
- `receive_ms`: time receiving the response body
- `total_ms`: end-to-end duration
- `tokens_per_second`: output throughput (output tokens / receive time), `null` if not applicable

Can be `null` if timing data wasn't captured.

### `transfer`

Wire-level transfer sizes:

```json
{
  "request_bytes": 31456,
  "response_bytes": 12890,
  "compressed": false
}
```

### `context_lens`

Context Lens analysis. This namespace contains data specific to Context Lens and is not part of any standard:

```json
{
  "window_size": 200000,
  "utilization": 0.235,
  "system_tokens": 1157,
  "tools_tokens": 1252,
  "messages_tokens": 44591,
  "composition": [
    {"category": "tool_definitions", "tokens": 1263, "pct": 51.9, "count": 1},
    {"category": "system_prompt", "tokens": 1168, "pct": 48.0, "count": 2},
    {"category": "user_text", "tokens": 4, "pct": 0.2, "count": 1}
  ],
  "growth": {
    "tokens_added_this_turn": 3421,
    "cumulative_tokens": 47000,
    "compaction_detected": false
  },
  "security": {
    "alerts": [],
    "summary": { "high": 0, "medium": 0, "info": 0 }
  }
}
```

**Window metrics:**

- `window_size`: context window limit for the model (tokens)
- `utilization`: fraction of window used (0.0 to 1.0)
- `system_tokens`, `tools_tokens`, `messages_tokens`: token breakdown by section

**Composition:** breakdown of what fills the context window, sorted by token count descending:

- `category`: one of `system_prompt`, `tool_definitions`, `tool_results`, `tool_calls`, `assistant_text`, `user_text`, `thinking`, `system_injections`, `images`, `cache_markers`, `other`
- `tokens`: token count for this category
- `pct`: percentage of total tokens
- `count`: number of content blocks in this category

**Growth:** turn-over-turn context tracking:

- `tokens_added_this_turn`: delta from previous same-role entry, `null` for first turn
- `cumulative_tokens`: total tokens at this point
- `compaction_detected`: `true` if tokens decreased (the tool likely summarized/pruned context)

**Security:** prompt injection scanning results:

- `alerts[]`: detected patterns with `message_index`, `role`, `tool_name`, `severity` (`high`/`medium`/`info`), `pattern`, `match`, `offset`, `length`
- `summary`: count of alerts by severity

### `raw`

Raw request/response bodies. Only populated when `CONTEXT_LENS_PRIVACY=full`:

```json
{
  "request_body": { "model": "claude-sonnet-4-20250514", "messages": [...] },
  "response_body": { "id": "msg_...", "content": [...] }
}
```

Both fields are `null` under the default `standard` privacy level. `response_body` can be a string (raw SSE chunks) or an object (parsed JSON).

## OpenTelemetry Mapping

LHAR is designed to map onto OpenTelemetry traces:

| LHAR field | OpenTelemetry concept |
|---|---|
| `trace_id` | Trace ID |
| `span_id` | Span ID |
| `parent_span_id` | Parent Span ID |
| `timestamp` | Span start time |
| `timings.total_ms` | Span duration |
| `gen_ai.system` | `gen_ai.system` attribute |
| `gen_ai.request.model` | `gen_ai.request.model` attribute |
| `gen_ai.usage.*` | `gen_ai.usage.*` metrics |

The `gen_ai` namespace intentionally follows the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Provider-specific extensions (cache tokens, cost) live in `usage_ext` to keep the standard namespace clean.

## Use Cases

- **Debugging context bloat:** load an `.lhar` file to find what's eating tokens
- **Cost analysis:** aggregate costs across sessions, group by model/tool/agent
- **Sharing repros:** send an `.lhar` file instead of pasting logs
- **Building tools:** parse LHAR to feed data into your own visualizations or automation
- **Regression testing:** snapshot context structure before/after changes

## Canonical Schema

The machine-readable source of truth is `schema/lhar.schema.json` (JSON Schema draft-07). Generate types for your language:

```bash
# TypeScript
npx json-schema-to-typescript schema/lhar.schema.json -o lhar-types.ts

# Python
pip install datamodel-code-generator
datamodel-codegen --input schema/lhar.schema.json --output lhar_types.py
```

Context Lens uses the generated TypeScript types (`src/lhar-types.generated.ts`).

## File Locations

LHAR files are written to `data/` by default:

- `data/<source>-<trace>.lhar`: individual session files (append-only, one per conversation)
- `data/state.jsonl`: combined state used for persistence (not LHAR format)

## Version

Current LHAR version: **0.1.0**

This is early. The format may change. If you're building on LHAR, check the schema version field and handle mismatches gracefully.
