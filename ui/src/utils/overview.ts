import type { CompositionEntry, HealthScore } from '@/api-types'
import { fmtTokens } from './format'
import { CATEGORY_META } from './messages'

export interface CompositionDelta {
  category: string
  delta: number
}

export interface HealthNarrative {
  toneClass: 'narrative-neutral' | 'narrative-advisory'
  headline: string
  detail: string
}

interface BuildHealthNarrativeArgs {
  utilization: number
  healthScore?: HealthScore | null
  composition: CompositionEntry[]
  topDelta?: CompositionDelta | null
}

export function buildHealthNarrative(args: BuildHealthNarrativeArgs): HealthNarrative {
  const utilPct = Math.round(args.utilization * 100)
  const health = args.healthScore
  const topComp = [...args.composition].sort((a, b) => b.tokens - a.tokens)[0]
  const topDelta = args.topDelta

  let toneClass: HealthNarrative['toneClass'] = 'narrative-neutral'
  let headline = `Context is at ${utilPct}% utilization.`
  if (health?.rating === 'poor' || utilPct >= 85) {
    toneClass = 'narrative-advisory'
    headline = `Turn health is elevated risk (${health ? health.overall + '/100' : utilPct + '% utilization'}).`
  } else if (health?.rating === 'needs-work' || utilPct >= 65) {
    toneClass = 'narrative-advisory'
    headline = `Turn health shows moderate pressure (${health ? health.overall + '/100' : utilPct + '% utilization'}).`
  } else if (health) {
    headline = `Turn health is stable at ${health.overall}/100.`
  }

  const likelyDrivers: string[] = []
  if (topComp) likelyDrivers.push(`${CATEGORY_META[topComp.category]?.label ?? topComp.category} is the largest share (${Math.round(topComp.pct)}%).`)
  if (topDelta) {
    const label = CATEGORY_META[topDelta.category]?.label ?? topDelta.category
    const direction = topDelta.delta > 0 ? 'grew' : 'shrank'
    likelyDrivers.push(`${label} ${direction} most vs previous main turn (${fmtTokens(Math.abs(topDelta.delta))}).`)
  }

  return {
    toneClass,
    headline,
    detail: likelyDrivers.join(' '),
  }
}
