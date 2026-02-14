/**
 * Public LHAR API for Context Lens.
 *
 * This is a thin barrel re-export: implementations live in `src/lhar/*`
 * to keep concerns separated, mirroring the `src/core/` pattern.
 */

// Header redaction (re-exported for backward compatibility)
export { redactHeaders, SENSITIVE_HEADERS } from "./http/headers.js";
// Composition analysis
export {
  analyzeComposition,
  normalizeComposition,
} from "./lhar/composition.js";
// Export serialization (JSONL / JSON)
export { toLharJson, toLharJsonl } from "./lhar/export.js";
export type { ParsedLhar } from "./lhar/reader.js";
// LHAR file reader
export { parseLharContent, readLharFile } from "./lhar/reader.js";
// Record & session builders
export { buildLharRecord, buildSessionLine } from "./lhar/record.js";
export type { ParsedResponseUsage } from "./lhar/response.js";
// Response usage parsing
export { extractResponseId, parseResponseUsage } from "./lhar/response.js";
// Tool extraction
export { extractToolCalls, extractToolDefinitions } from "./lhar/tools.js";
