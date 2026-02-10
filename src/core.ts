// `src/core.ts` is a stable facade: other modules import from here.
// Keep this file small by delegating to focused modules.

export { estimateTokens } from './tokens.js';

export {
  CONTEXT_LIMITS,
  getContextLimit,
  MODEL_PRICING,
  estimateCost,
} from './models.js';

export {
  API_PATH_SEGMENTS,
  detectProvider,
  detectApiFormat,
  extractSource,
  resolveTargetUrl,
} from './routing.js';

export { parseContextInfo } from './context/parse.js';

export {
  extractReadableText,
  extractWorkingDirectory,
  extractUserPrompt,
  extractSessionId,
  computeAgentKey,
  computeFingerprint,
  extractConversationLabel,
} from './conversation.js';

export {
  HEADER_SIGNATURES,
  SOURCE_SIGNATURES,
  detectSource,
} from './source.js';

