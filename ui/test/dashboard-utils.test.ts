import { describe, expect, it, vi } from 'vitest'
import {
  buildSparkSVG,
  compactDir,
  computeDashboardKpis,
  filterSummaries,
  relativeTime,
  sortSummaries,
  sparkColor,
  summariesForKpiScope,
} from '@/utils/dashboard'
import type { ConversationSummary } from '@/api-types'

function summary(overrides: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: 'session-a',
    label: 'Session A',
    source: 'claude',
    workingDirectory: '/home/lars/project-a',
    firstSeen: '2026-01-01T00:00:00.000Z',
    entryCount: 1,
    latestTimestamp: '2026-01-01T12:00:00.000Z',
    latestModel: 'claude-sonnet-4',
    latestTotalTokens: 100,
    contextLimit: 1000,
    totalCost: 0.01,
    healthScore: { overall: 80, rating: 'good', audits: [] },
    tokenHistory: [20, 100],
    tags: [],
    ...overrides,
  }
}

describe('dashboard helpers', () => {
  it('filters by source, query, and tag without changing the source list', () => {
    const sessions = [
      summary({ id: 'a', source: 'claude', workingDirectory: '/home/lars/alpha', tags: ['work'] }),
      summary({ id: 'b', source: 'codex', workingDirectory: '/home/lars/beta', tags: ['side'] }),
    ]

    const result = filterSummaries(sessions, {
      activeSources: new Set(['claude']),
      searchQuery: 'alpha',
      tagFilter: 'work',
    })

    expect(result.map((s) => s.id)).toEqual(['a'])
  })

  it('sorts by priority and cost while leaving recent order untouched', () => {
    const low = summary({ id: 'low', latestTotalTokens: 50, totalCost: 0.01, healthScore: { overall: 95, rating: 'good', audits: [] } })
    const high = summary({ id: 'high', latestTotalTokens: 900, totalCost: 0.5, healthScore: { overall: 25, rating: 'poor', audits: [] } })

    expect(sortSummaries([low, high], 'recent', 0.5).map((s) => s.id)).toEqual(['low', 'high'])
    expect(sortSummaries([low, high], 'priority', 0.5).map((s) => s.id)).toEqual(['high', 'low'])
    expect(sortSummaries([low, high], 'cost', 0.5).map((s) => s.id)).toEqual(['high', 'low'])
  })

  it("computes today's KPI totals from a stable day boundary", () => {
    const today = summary({ id: 'today', latestTimestamp: '2026-06-12T08:00:00.000', latestTotalTokens: 150, entryCount: 2, totalCost: 0.2 })
    const yesterday = summary({ id: 'yesterday', latestTimestamp: '2026-06-11T10:00:00.000', latestTotalTokens: 500, entryCount: 9, totalCost: 1.5 })

    const scoped = summariesForKpiScope([today, yesterday], 'today', new Date('2026-06-12T10:00:00.000'))

    expect(scoped.map((s) => s.id)).toEqual(['today'])
    expect(computeDashboardKpis(scoped)).toEqual({
      totalSessions: 1,
      totalRequests: 2,
      totalTokens: 150,
      totalCost: 0.2,
      avgHealth: 80,
    })
  })

  it('formats relative time and compact directory labels', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-12T10:00:00.000Z'))
    try {
      expect(relativeTime('2026-06-12T09:58:30.000Z')).toBe('1m ago')
      expect(compactDir('/home/lars/xithing/context-lens')).toBe('xithing/context-lens')
    } finally {
      vi.useRealTimers()
    }
  })

  it('builds deterministic sparkline SVG markup', () => {
    const svg = buildSparkSVG([1, 3, 2], sparkColor('prio-warning'))

    expect(svg).toContain('<svg viewBox="0 0 72 22"')
    expect(svg).toContain('stroke="#f59e0b"')
    expect(svg).toContain('<polyline')
  })
})
