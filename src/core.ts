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
export {
  analyzeSession,
  findCompactions,
  findGrowthBlocks,
  identifyUserTurns,
  buildAgentPaths,
} from "./core/session-analysis.js";
export type {
  SessionAnalysis,
  CompactionEvent,
  GrowthBlock,
  UserTurn,
  AgentPathStep,
  AnalyzeOptions,
  TimingStats,
  CacheStats,
} from "./core/session-analysis.js";
export {
  formatSessionAnalysis,
  fmtTokens,
  fmtCost,
  fmtDuration,
  shortModel,
} from "./core/session-format.js";
export type { FormatOptions } from "./core/session-format.js";
