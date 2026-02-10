/**
 * Public LHAR API for Context Lens.
 *
 * This is a thin barrel re-export: implementations live in `src/lhar/*`
 * to keep concerns separated, mirroring the `src/core/` pattern.
 */

// Composition analysis
export { analyzeComposition } from "./lhar/composition.js";

// Response usage parsing
export { parseResponseUsage } from "./lhar/response.js";
export type { ParsedResponseUsage } from "./lhar/response.js";

// Record & session builders
export { buildLharRecord, buildSessionLine } from "./lhar/record.js";

// Export serialization (JSONL / JSON)
export { toLharJson, toLharJsonl } from "./lhar/export.js";

// Header redaction (re-exported for backward compatibility)
export { redactHeaders, SENSITIVE_HEADERS } from "./http/headers.js";
