/**
 * Lightweight token estimator used throughout Context Lens.
 *
 * This is intentionally simple and model-agnostic: we approximate tokens as `ceil(chars / 4)`.
 * It is good enough for rough context utilization and relative comparisons.
 *
 * @param text - Value to estimate tokens for. Objects are stringified as JSON.
 * @returns Estimated token count (>= 0).
 */
export function estimateTokens(text: unknown): number {
  if (!text) return 0;
  const s = typeof text === 'object' ? JSON.stringify(text) : String(text);
  return Math.ceil(s.length / 4);
}

