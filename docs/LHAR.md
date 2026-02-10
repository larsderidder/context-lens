# LHAR Format

**LHAR** (LLM HTTP Archive) is to LLM API calls what HAR is to web traffic: a structured format for recording, analyzing, and sharing context window interactions.

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
  "version": "0.1.0",
  "creator": {...},
  "sessions": [...],
  "entries": [...]
}
```

Same data, different packaging. Use `.lhar` for streaming/append workflows, `.lhar.json` for static analysis.

## Records

### Session Line

Identifies the trace and declares metadata:

```json
{
  "type": "session",
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "started_at": "2026-02-10T12:00:00.000Z",
  "tool": "claude",
  "model": "claude-sonnet-4-20250514"
}
```

- `trace_id`: unique identifier for the entire conversation session
- `started_at`: ISO 8601 timestamp of first API call
- `tool`: detected tool name (claude, aider, pi, etc)
- `model`: primary model used in session

### Entry Record

One API call:

```json
{
  "type": "entry",
  "id": "req_123",
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "span_id": "span_001",
  "parent_span_id": null,
  "timestamp": "2026-02-10T12:00:01.000Z",
  "sequence": 0,
  "source": {...},
  "gen_ai": {...},
  "http": {...},
  "context_lens": {...}
}
```

Fields:

- `id`: unique entry identifier
- `trace_id`: links back to session
- `span_id` / `parent_span_id`: OpenTelemetry-style span hierarchy for subagents
- `timestamp`: when request was sent
- `sequence`: turn number in conversation (0-indexed)

## Namespaces

Entry data is grouped into four namespaces:

### `source`

Where the request came from:

```json
{
  "tool": "aider",
  "tool_version": "0.73.1",
  "agent_role": "main",
  "collector": "context-lens",
  "collector_version": "0.1.0"
}
```

- `agent_role`: `main`, `subagent`, or `unknown`
- `collector`: always "context-lens" for files from this tool

### `gen_ai`

LLM-specific fields (model, tokens, cost):

```json
{
  "system": "You are a helpful coding assistant...",
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
    "input_tokens": 1234,
    "output_tokens": 567,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0
  },
  "cost": {
    "input": 0.00370,
    "output": 0.00851,
    "cache_read": 0.0,
    "cache_write": 0.0,
    "total": 0.01221
  }
}
```

- `system`: combined system prompt (all system blocks concatenated)
- `usage`: token counts from provider response
- `cost`: estimated USD cost (based on published rates)

### `http`

Low-level HTTP capture:

```json
{
  "method": "POST",
  "url": "https://api.anthropic.com/v1/messages",
  "status": 200,
  "headers": {
    "request": {...},
    "response": {...}
  },
  "body": {
    "request": {...},
    "response": {...}
  },
  "timings": {
    "send_ms": 12,
    "wait_ms": 1834,
    "receive_ms": 45,
    "total_ms": 1891,
    "tokens_per_second": 17.2
  }
}
```

- Headers are redacted (no API keys)
- Bodies are the raw JSON payloads
- Timings track latency and throughput

### `context_lens`

Context Lens-specific analysis:

```json
{
  "composition": [
    {"category": "system_prompt", "tokens": 1523, "pct": 31.2, "count": 1},
    {"category": "tool_definitions", "tokens": 2891, "pct": 59.3, "count": 12},
    {"category": "user_text", "tokens": 463, "pct": 9.5, "count": 1}
  ],
  "findings": [
    {
      "type": "large_tool_result",
      "severity": "warning",
      "message": "Tool result 'read_file' is 45234 tokens (92% of response)",
      "details": {...}
    }
  ]
}
```

- `composition`: breakdown of what's in the context window (categories sorted by token count descending)
- `findings`: detected issues: large results, unused tools, overflow risk, compaction

Composition categories:

- `system_prompt`: system messages and instructions
- `tool_definitions`: function/tool schemas
- `tool_results`: outputs from tool executions
- `tool_calls`: assistant requests to call tools
- `assistant_text`: model-generated text
- `user_text`: user messages
- `thinking`: extended thinking / reasoning blocks
- `system_injections`: dynamic system reminders (e.g. `<system-reminder>`)
- `images`: image content blocks
- `cache_markers`: prompt caching control blocks
- `other`: unclassified content

## OpenTelemetry Mapping

LHAR is designed to map cleanly onto OpenTelemetry traces:

- `trace_id` → trace ID
- `span_id` → span ID
- `parent_span_id` → parent span ID
- `timestamp` → span start time
- `http.timings.total_ms` → span duration

This makes LHAR files compatible with observability stacks (Jaeger, Honeycomb, etc) if you write an adapter.

## Use Cases

- **Debugging context bloat:** load an `.lhar` file into a custom analyzer to find what's eating tokens
- **Cost analysis:** aggregate costs across sessions, group by model/tool/agent
- **Sharing repros:** send an `.lhar` file instead of pasting logs
- **Building tools:** parse LHAR to feed data into your own visualizations or automation
- **Regression testing:** snapshot context structure before/after changes

## Canonical Schema

The machine-readable source of truth is `schema/lhar.schema.json` (JSON Schema draft-07). Generate types for your language:

```bash
# TypeScript
npm install -g json-schema-to-typescript
json-schema-to-typescript schema/lhar.schema.json -o lhar-types.ts

# Python (with dataclasses)
pip install datamodel-code-generator
datamodel-codegen --input schema/lhar.schema.json --output lhar_types.py
```

Context Lens itself uses the generated TypeScript types (`src/lhar-types.generated.ts`).

## File Locations

LHAR files are written to `data/` by default:

- `data/state.jsonl`: combined state (all sessions, used for persistence)
- `data/<trace_id>.lhar`: individual session exports

## Version

Current LHAR version: **0.1.0**

This is early. Format may change. If you're building on LHAR, check the schema version field (`version`) and handle mismatches gracefully.
