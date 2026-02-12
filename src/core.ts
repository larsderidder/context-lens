/**
 * Public "core" API for Context Lens.
 *
 * This is intentionally a thin facade: other parts of the codebase import from here,
 * while implementations live in `src/core/*` to keep concerns separated.
 */

export {
  computeAgentKey,
  computeFingerprint,
  extractConversationLabel,
  extractReadableText,
  extractSessionId,
  extractToolsUsed,
  extractUserPrompt,
  extractWorkingDirectory,
} from "./core/conversation.js";

export { computeHealthScore } from "./core/health.js";
export {
  estimateCost,
  getContextLimit,
} from "./core/models.js";
export { parseContextInfo } from "./core/parse.js";
export {
  detectApiFormat,
  detectProvider,
  extractSource,
  resolveTargetUrl,
} from "./core/routing.js";
export { scanSecurity } from "./core/security.js";
export { detectSource } from "./core/source.js";
export { estimateTokens, rescaleContextTokens } from "./core/tokens.js";
