import type { ConversationSummary } from '@/api-types'

export interface PriorityMeta {
  risk: number
  normalizedCost: number
  score: number
  label: 'Critical' | 'Warning' | 'Healthy'
  toneClass: 'priority-critical' | 'priority-warning' | 'priority-healthy'
  barClass: 'prio-critical' | 'prio-warning' | 'prio-healthy'
  tooltip: string
}

function clamp01(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/**
 * Compute priority meta for a session summary.
 * Score blends health risk (70%) with relative cost (30%).
 */
export function computeSessionPriority(
  summary: ConversationSummary,
  maxCost: number,
): PriorityMeta {
  const health = summary.healthScore
  const healthRisk = health ? clamp01((100 - health.overall) / 100) : null
  const utilizationRisk = summary.contextLimit
    ? clamp01(summary.latestTotalTokens / summary.contextLimit)
    : 0
  const risk = healthRisk === null
    ? utilizationRisk
    : clamp01((healthRisk * 0.7) + (utilizationRisk * 0.3))

  const normalizedCost = maxCost > 0
    ? clamp01(summary.totalCost / maxCost)
    : 0
  const score = clamp01((risk * 0.7) + (normalizedCost * 0.3))

  let label: PriorityMeta['label'] = 'Healthy'
  let toneClass: PriorityMeta['toneClass'] = 'priority-healthy'
  let barClass: PriorityMeta['barClass'] = 'prio-healthy'
  if (score >= 0.7) {
    label = 'Critical'
    toneClass = 'priority-critical'
    barClass = 'prio-critical'
  } else if (score >= 0.45) {
    label = 'Warning'
    toneClass = 'priority-warning'
    barClass = 'prio-warning'
  }

  const tooltip = `Priority ${Math.round(score * 100)} = 0.7×risk(${Math.round(risk * 100)}) + 0.3×cost(${Math.round(normalizedCost * 100)}).`
  return { risk, normalizedCost, score, label, toneClass, barClass, tooltip }
}
