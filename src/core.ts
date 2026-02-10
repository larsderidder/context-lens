/**
 * Public "core" API for Context Lens.
 *
 * This is intentionally a thin facade: other parts of the codebase import from here,
 * while implementations live in `src/core/*` to keep concerns separated.
 */

export { estimateTokens } from './core/tokens.js';

export {
  CONTEXT_LIMITS,
  getContextLimit,
  MODEL_PRICING,
  estimateCost,
} from './core/models.js';

export {
  API_PATH_SEGMENTS,
  detectProvider,
  detectApiFormat,
  extractSource,
  resolveTargetUrl,
} from './core/routing.js';

export { parseContextInfo } from './core/parse.js';

export {
  extractReadableText,
  extractWorkingDirectory,
  extractUserPrompt,
  extractSessionId,
  computeAgentKey,
  computeFingerprint,
  extractConversationLabel,
} from './core/conversation.js';

export {
  HEADER_SIGNATURES,
  SOURCE_SIGNATURES,
  detectSource,
} from './core/source.js';
