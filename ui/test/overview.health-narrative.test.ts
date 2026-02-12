import { describe, expect, it } from 'vitest'
import { buildHealthNarrative } from '@/utils/overview'
import type { CompositionEntry } from '@/api-types'

function comp(category: CompositionEntry['category'], tokens: number, pct: number): CompositionEntry {
  return { category, tokens, pct, count: 1 }
}

describe('buildHealthNarrative', () => {
  it('returns advisory narrative for elevated risk and includes top driver + delta', () => {
    const result = buildHealthNarrative({
      utilization: 0.91,
      healthScore: {
        overall: 52,
        rating: 'poor',
        audits: [],
      },
      composition: [
        comp('tool_results', 4800, 48),
        comp('assistant_text', 2600, 26),
      ],
      topDelta: { category: 'tool_results', delta: 2200 },
    })

    expect(result.toneClass).toBe('narrative-advisory')
    expect(result.headline).toContain('elevated risk')
    expect(result.detail).toContain('Tool results')
    expect(result.detail).toContain('grew most')
  })

  it('returns stable narrative when health is good and utilization is moderate', () => {
    const result = buildHealthNarrative({
      utilization: 0.42,
      healthScore: {
        overall: 89,
        rating: 'good',
        audits: [],
      },
      composition: [
        comp('assistant_text', 1200, 50),
        comp('user_text', 900, 37.5),
      ],
      topDelta: null,
    })

    expect(result.toneClass).toBe('narrative-neutral')
    expect(result.headline).toBe('Turn health is stable at 89/100.')
    expect(result.detail).toContain('Assistant text is the largest share')
  })

  it('falls back to utilization-based headline when no health score exists', () => {
    const result = buildHealthNarrative({
      utilization: 0.37,
      healthScore: null,
      composition: [comp('user_text', 800, 80)],
      topDelta: null,
    })

    expect(result.toneClass).toBe('narrative-neutral')
    expect(result.headline).toBe('Context is at 37% utilization.')
  })
})
