/**
 * Public "core" API for Context Lens.
 *
 * This is intentionally a thin facade: other parts of the codebase import from here,
 * while implementations live in `src/core/*` to keep concerns separated.
 */

export { estimateTokens } from './core/tokens.js';

export {
  getContextLimit,
  estimateCost,
} from './core/models.js';

export {
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
  detectSource,
} from './core/source.js';
