/**
 * Known model context limits (tokens).
 *
 * Keys are ordered most-specific-first because `getContextLimit()` does substring matching.
 */
export const CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic
  "claude-opus-4.6": 1000000,
  "claude-opus-4.5": 200000,
  "claude-opus-4.1": 200000,
  "claude-opus-4": 200000,
  "claude-sonnet-4.6": 1000000,
  "claude-sonnet-4.5": 1000000,
  "claude-sonnet-4": 1000000,
  "claude-haiku-4.5": 200000,
  "claude-haiku-4": 200000,
  "claude-3-7-sonnet": 200000,
  "claude-3-5-sonnet": 200000,
  "claude-3-5-haiku": 200000,
  "claude-3-haiku": 200000,
  "claude-3-opus": 200000,
  // OpenAI — specific variants before generic slugs
  "gpt-5.2-pro": 400000,
  "gpt-5.2-codex": 400000,
  "gpt-5.2-chat": 128000,
  "gpt-5.2": 400000,
  "gpt-5.1-codex-max": 400000,
  "gpt-5.1-codex-mini": 400000,
  "gpt-5.1-codex": 400000,
  "gpt-5.1-chat": 128000,
  "gpt-5.1": 400000,
  "gpt-5.3-codex": 400000,
  "gpt-5-pro": 400000,
  "gpt-5-codex": 400000,
  "gpt-5-chat": 128000,
  "gpt-5-mini": 400000,
  "gpt-5-nano": 400000,
  "gpt-5": 400000,
  "gpt-4.1-mini": 1047576,
  "gpt-4.1-nano": 1047576,
  "gpt-4.1": 1047576,
  "gpt-4o-mini": 128000,
  "gpt-4o": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4": 8192,
  "gpt-3.5-turbo": 16385,
  "o4-mini-deep-research": 200000,
  "o4-mini-high": 200000,
  "o4-mini": 200000,
  "o3-deep-research": 200000,
  "o3-pro": 200000,
  "o3-mini-high": 200000,
  "o3-mini": 200000,
  o3: 200000,
  "o1-pro": 200000,
  "o1-mini": 128000,
  o1: 200000,
  // Google Gemini — specific before generic
  "gemini-3.1-pro-preview": 1048576,
  "gemini-3-pro-preview": 1048576,
  "gemini-3-flash-preview": 1048576,
  "gemini-2.5-pro-preview": 1048576,
  "gemini-2.5-pro": 1048576,
  "gemini-2.5-flash-lite": 1048576,
  "gemini-2.5-flash": 1048576,
  "gemini-2.0-flash-lite": 1048576,
  "gemini-2.0-flash": 1048576,
  "gemini-1.5-pro": 2097152,
  "gemini-1.5-flash": 1048576,
};

/**
 * Resolve an approximate context window size for a given model string.
 *
 * @param model - Model identifier (often includes version suffixes).
 * @returns Context limit in tokens.
 */
export function getContextLimit(model: string): number {
  for (const [key, limit] of Object.entries(CONTEXT_LIMITS)) {
    if (model.includes(key)) return limit;
  }
  return 128000; // default fallback
}

/**
 * Model pricing: `[inputPerMTok, outputPerMTok]` in USD.
 *
 * Keys ordered most-specific-first to avoid substring false matches
 * (e.g. `gpt-4o-mini` before `gpt-4o`, `o3-mini` before `o3`).
 *
 * Prices sourced from OpenRouter (openrouter.ai/api/v1/models) and reflect
 * standard per-token rates as of early 2026. Keys are matched as substrings
 * of the incoming model string, so they work for both direct-API model IDs
 * (e.g. `gemini-2.5-pro`) and OpenRouter-prefixed IDs
 * (e.g. `google/gemini-2.5-pro`).
 */
export const MODEL_PRICING: Record<string, [number, number]> = {
  // Anthropic — specific point-releases before generic slugs
  "claude-opus-4.6": [5, 25],
  "claude-opus-4.5": [5, 25],
  "claude-opus-4.1": [15, 75],
  "claude-opus-4": [15, 75],
  "claude-sonnet-4.6": [3, 15],
  "claude-sonnet-4.5": [3, 15],
  "claude-sonnet-4": [3, 15],
  "claude-haiku-4.5": [1, 5],
  "claude-haiku-4": [0.8, 4],
  "claude-3-7-sonnet": [3, 15],
  "claude-3-5-sonnet": [3, 15],
  "claude-3-5-haiku": [0.8, 4],
  "claude-3-haiku": [0.25, 1.25],
  "claude-3-opus": [15, 75],
  // OpenAI — specific variants before generic slugs
  "gpt-5.2-pro": [21, 168],
  "gpt-5.2-codex": [1.75, 14],
  "gpt-5.2-chat": [1.75, 14],
  "gpt-5.2": [1.75, 14],
  "gpt-5.1-codex-max": [1.25, 10],
  "gpt-5.1-codex-mini": [0.25, 2],
  "gpt-5.1-codex": [1.25, 10],
  "gpt-5.1-chat": [1.25, 10],
  "gpt-5.1": [1.25, 10],
  // Codex subscription estimates
  "gpt-5.3-codex": [1.75, 14],
  "gpt-5-pro": [15, 120],
  "gpt-5-codex": [1.25, 10],
  "gpt-5-chat": [1.25, 10],
  "gpt-5-mini": [0.25, 2],
  "gpt-5-nano": [0.05, 0.4],
  "gpt-5": [1.25, 10],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1-nano": [0.1, 0.4],
  "gpt-4.1": [2.0, 8.0],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
  "gpt-4-turbo": [10, 30],
  "gpt-4": [30, 60],
  "gpt-3.5-turbo": [0.5, 1.5],
  "o4-mini-deep-research": [2, 8],
  "o4-mini-high": [1.1, 4.4],
  "o4-mini": [1.1, 4.4],
  "o3-deep-research": [10, 40],
  "o3-pro": [20, 80],
  "o3-mini-high": [1.1, 4.4],
  "o3-mini": [1.1, 4.4],
  o3: [2, 8],
  "o1-pro": [150, 600],
  "o1-mini": [3, 12],
  o1: [15, 60],
  // Google Gemini — specific before generic
  "gemini-3.1-pro-preview": [2, 12],
  "gemini-3-pro-preview": [2, 12],
  "gemini-3-flash-preview": [0.5, 3],
  "gemini-2.5-pro-preview": [1.25, 10],
  "gemini-2.5-pro": [1.25, 10],
  "gemini-2.5-flash-lite": [0.1, 0.4],
  "gemini-2.5-flash": [0.3, 2.5],
  "gemini-2.0-flash-lite": [0.075, 0.3],
  "gemini-2.0-flash": [0.1, 0.4],
  "gemini-1.5-pro": [1.25, 5],
  "gemini-1.5-flash": [0.075, 0.3],
};

/**
 * Cache pricing multipliers by provider prefix.
 *
 * Each entry maps a model key prefix to `[readMultiplier, writeMultiplier]`
 * relative to the base input price. For example, Anthropic charges 10% of
 * the base input rate for cache reads and 25% for cache writes.
 *
 * Gemini charges 25% of base input for cached content (reads). Gemini has
 * no separate "cache write" billing; context caching cost is handled
 * outside the per-request pricing.
 */
const CACHE_PRICING: Record<string, [number, number]> = {
  "claude-": [0.1, 0.25],
  "gemini-": [0.25, 0],
};

/**
 * Look up cache pricing multipliers for a model key.
 */
function getCacheMultipliers(modelKey: string): [number, number] {
  for (const [prefix, multipliers] of Object.entries(CACHE_PRICING)) {
    if (modelKey.startsWith(prefix)) return multipliers;
  }
  return [0, 0];
}

/**
 * Estimate cost in USD for a request/response token pair using `MODEL_PRICING`.
 *
 * Cache pricing varies by provider:
 * - Anthropic: cache reads at 10% of base input, writes at 25%
 * - Gemini: cached content at 25% of base input, no write cost
 *
 * @param model - Model identifier (substring matched against known keys).
 * @param inputTokens - Input/prompt tokens (non-cached).
 * @param outputTokens - Output/completion tokens.
 * @param cacheReadTokens - Cache read tokens.
 * @param cacheWriteTokens - Cache write tokens.
 * @returns Cost in USD, rounded to 6 decimals; `null` if the model is unknown.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number | null {
  for (const [key, [inp, out]] of Object.entries(MODEL_PRICING)) {
    if (model.includes(key)) {
      const [readMul, writeMul] = getCacheMultipliers(key);
      const cacheReadCost = cacheReadTokens * inp * readMul;
      const cacheWriteCost = cacheWriteTokens * inp * writeMul;

      return (
        Math.round(
          ((inputTokens * inp +
            outputTokens * out +
            cacheReadCost +
            cacheWriteCost) /
            1_000_000) *
            1_000_000,
        ) / 1_000_000
      );
    }
  }
  return null;
}
