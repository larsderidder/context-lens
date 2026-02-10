/**
 * Known model context limits (tokens).
 *
 * Keys are ordered most-specific-first because `getContextLimit()` does substring matching.
 */
export const CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic
  "claude-opus-4": 200000,
  "claude-sonnet-4": 200000,
  "claude-haiku-4": 200000,
  "claude-3-5-sonnet": 200000,
  "claude-3-5-haiku": 200000,
  "claude-3-opus": 200000,
  // OpenAI (specific before generic)
  "gpt-4o-mini": 128000,
  "gpt-4o": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4": 8192,
  "gpt-3.5-turbo": 16385,
  "o4-mini": 200000,
  "o3-mini": 200000,
  o3: 200000,
  "o1-mini": 128000,
  o1: 200000,
  // Gemini
  "gemini-2.5-pro": 1048576,
  "gemini-2.5-flash": 1048576,
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
 * (e.g. `gpt-4o-mini` before `gpt-4o`).
 */
export const MODEL_PRICING: Record<string, [number, number]> = {
  "claude-opus-4": [15, 75],
  "claude-sonnet-4": [3, 15],
  "claude-haiku-4": [0.8, 4],
  "claude-3-5-sonnet": [3, 15],
  "claude-3-5-haiku": [0.8, 4],
  "claude-3-opus": [15, 75],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
  "gpt-4-turbo": [10, 30],
  "gpt-4": [30, 60],
  "o4-mini": [1.1, 4.4],
  "o3-mini": [1.1, 4.4],
  o3: [10, 40],
  "o1-mini": [3, 12],
  o1: [15, 60],
  // Codex (subscription estimate)
  "gpt-5.3-codex": [1.75, 14],
  "gpt-5.2-codex": [1.75, 14],
  "gpt-5.1-codex-mini": [0.25, 2],
  "gpt-5.1-codex": [1.25, 10],
  "gpt-5-codex": [1.25, 10],
  // Gemini
  "gemini-2.5-pro": [1.25, 10],
  "gemini-2.5-flash": [0.15, 0.6],
  "gemini-2.0-flash": [0.1, 0.4],
  "gemini-1.5-pro": [1.25, 5],
  "gemini-1.5-flash": [0.075, 0.3],
};

/**
 * Estimate cost in USD for a request/response token pair using `MODEL_PRICING`.
 *
 * @param model - Model identifier (substring matched against known keys).
 * @param inputTokens - Input/prompt tokens.
 * @param outputTokens - Output/completion tokens.
 * @returns Cost in USD, rounded to 6 decimals; `null` if the model is unknown.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  for (const [key, [inp, out]] of Object.entries(MODEL_PRICING)) {
    if (model.includes(key)) {
      return (
        Math.round(
          ((inputTokens * inp + outputTokens * out) / 1_000_000) * 1_000_000,
        ) / 1_000_000
      );
    }
  }
  return null;
}
