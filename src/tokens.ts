// Simple token estimation: chars / 4
export function estimateTokens(text: unknown): number {
  if (!text) return 0;
  const s = typeof text === 'object' ? JSON.stringify(text) : String(text);
  return Math.ceil(s.length / 4);
}

