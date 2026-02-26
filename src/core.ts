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
export type {
  AgentPathStep,
  AnalyzeOptions,
  CacheStats,
  CompactionEvent,
  GrowthBlock,
  SessionAnalysis,
  TimingStats,
  UserTurn,
} from "./core/session-analysis.js";
export {
  analyzeSession,
  buildAgentPaths,
  findCompactions,
  findGrowthBlocks,
  identifyUserTurns,
} from "./core/session-analysis.js";
export type { FormatOptions } from "./core/session-format.js";
export {
  fmtCost,
  fmtDuration,
  fmtTokens,
  formatSessionAnalysis,
  shortModel,
} from "./core/session-format.js";
export { detectSource } from "./core/source.js";
export { initTokenizer, isTokenizerReady } from "./core/tokenizer.js";
export { estimateTokens, rescaleContextTokens } from "./core/tokens.js";
