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

// Record & session builders
export { buildLharRecord, buildSessionLine } from "./lhar/record.js";
// Tool extraction
export { extractToolCalls, extractToolDefinitions } from "./lhar/tools.js";
// LHAR file reader
export { readLharFile, parseLharContent } from "./lhar/reader.js";
export type { ParsedLhar } from "./lhar/reader.js";
// Response usage parsing
export { parseResponseUsage } from "./lhar/response.js";
export type { ParsedResponseUsage } from "./lhar/response.js";
