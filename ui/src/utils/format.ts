/** Format token count: 1234 → "1.2K", 800 → "800" */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

/** Format cost: 0.0034 → "$0.00", 1.23 → "$1.23", null → "--" */
export function fmtCost(c: number | null | undefined): string {
  if (c == null) return '--'
  return '$' + c.toFixed(2)
}

/** Format ISO timestamp to local time: "14:32" */
export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Format duration in ms: 1234 → "1.2s", 456 → "456ms" */
export function fmtDuration(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's'
  return Math.round(ms) + 'ms'
}

/** Format bytes: 1234 → "1.2 KB" */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + ' MB'
  if (bytes >= 1000) return (bytes / 1000).toFixed(1) + ' KB'
  return bytes + ' B'
}

/** Format percentage: 0.456 → "45.6%", already-percentage 45.6 → "45.6%" */
export function fmtPct(value: number, alreadyPercent = false): string {
  const pct = alreadyPercent ? value : value * 100
  return pct.toFixed(1) + '%'
}

/** Shorten model name: "claude-sonnet-4-20250514" → "sonnet-4" */
export function shortModel(model: string): string {
  if (!model) return '?'
  // Claude models
  const claudeMatch = model.match(/(opus|sonnet|haiku)-(\d+(?:\.\d+)?)/)
  if (claudeMatch) return claudeMatch[1] + '-' + claudeMatch[2]
  // GPT models
  const gptMatch = model.match(/(gpt-4o(?:-mini)?|gpt-4|gpt-3\.5)/)
  if (gptMatch) return gptMatch[1]
  // o-series
  const oMatch = model.match(/(o[134](?:-mini)?)/)
  if (oMatch) return oMatch[1]
  // Gemini
  const geminiMatch = model.match(/(gemini-[\d.]+-(?:pro|flash)(?:-\w+)?)/)
  if (geminiMatch) return geminiMatch[1]
  // Fallback: last meaningful segment
  const parts = model.split(/[-_]/)
  if (parts.length > 2) return parts.slice(0, 3).join('-')
  return model
}

/** CSS class for model color: "claude-sonnet-4-..." → "model-sonnet" */
export function modelColorClass(model: string): string {
  if (/opus/i.test(model)) return 'model-opus'
  if (/sonnet/i.test(model)) return 'model-sonnet'
  if (/haiku/i.test(model)) return 'model-haiku'
  if (/gpt/i.test(model)) return 'model-gpt'
  if (/gemini/i.test(model)) return 'model-gemini'
  return 'model-default'
}

/** CSS class for source badge */
export function sourceBadgeClass(source: string): string {
  const s = (source || '').toLowerCase()
  if (s.includes('claude')) return 'badge-claude'
  if (s.includes('codex')) return 'badge-codex'
  if (s.includes('aider')) return 'badge-aider'
  if (s.includes('kimi')) return 'badge-kimi'
  if (s === 'pi' || s.startsWith('pi-')) return 'badge-pi'
  return 'badge-unknown'
}

/** Color for health rating */
export function healthColor(rating: string): string {
  switch (rating) {
    case 'good': return '#10b981'
    case 'needs-work': return '#f59e0b'
    case 'poor': return '#ef4444'
    default: return '#64748b'
  }
}
