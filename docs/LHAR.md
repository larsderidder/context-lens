# LHAR Format

Context Lens exports sessions in **LHAR** (LLM HTTP Archive) format: what HAR is for web traffic, but for LLM API calls.

**Canonical definition:** `schema/lhar.schema.json`

## OpenTelemetry Compatibility

LHAR is designed to map cleanly onto **OpenTelemetry-style traces and spans**:

- `trace_id` identifies a session trace.
- Each `entry` includes a `span_id` and optional `parent_span_id` for span relationships.

## Files

- `*.lhar`: **JSON Lines** (one JSON object per line).
  - A session preamble line with `"type": "session"`.
  - Followed by one or more entry lines with `"type": "entry"`.
  - Entries are grouped by `trace_id`.
- `*.lhar.json`: Wrapped JSON object containing `version`, `creator`, `sessions[]`, and `entries[]`.

## Record Types (High Level)

- `session` line (`LharSessionLine`)
  - Identifies a session (`trace_id`) and basic metadata like tool and model.
- `entry` record (`LharRecord`)
  - One captured API call (request/response + usage + timings + Context Lens-specific context window analysis).

## Example (Truncated / Illustrative)

```json
{"type":"session","trace_id":"...","started_at":"2026-02-08T12:00:00.000Z","tool":"claude","model":"claude-sonnet-4-20250514"}
{"type":"entry","id":"...","trace_id":"...","timestamp":"2026-02-08T12:00:01.000Z","gen_ai":{ "...": "..." }, "http":{ "...":"..." }, "context_lens":{ "...":"..." }}
```

For a complete, machine-validated description of all fields (including required/optional), see `schema/lhar.schema.json`.
