import type { ConversationSummary } from '@/api-types'
import { computeSessionPriority } from '@/utils/priority'

export type DashboardSortMode = 'recent' | 'priority' | 'cost'
export type KpiScope = 'today' | 'all'

export interface SummaryFilters {
  activeSources?: Set<string> | null
  searchQuery?: string
  tagFilter?: string | null
}

export interface DashboardKpis {
  totalSessions: number
  totalRequests: number
  totalTokens: number
  totalCost: number
  avgHealth: number
}

export const COMPOSITION_TAPE_CATEGORIES = [
  { key: 'system_prompt', label: 'System', color: 'var(--cat-system, #3b82f6)' },
  { key: 'tool_definitions', label: 'Tool defs', color: 'var(--cat-tools, #ec4899)' },
  { key: 'tool_results', label: 'Tool results', color: 'var(--cat-tool-results, #10b981)' },
  { key: 'assistant_text', label: 'Assistant', color: 'var(--cat-assistant, #f59e0b)' },
  { key: 'user_text', label: 'User', color: 'var(--cat-user, #06b6d4)' },
  { key: 'thinking', label: 'Thinking', color: 'var(--cat-thinking, #8b5cf6)' },
  { key: 'system_injections', label: 'Injections', color: 'var(--cat-injections, #6366f1)' },
]

export function filterSummaries(summaries: ConversationSummary[], filters: SummaryFilters): ConversationSummary[] {
  let list = summaries

  if (filters.activeSources) {
    list = list.filter((summary) => filters.activeSources!.has(summary.source))
  }

  const query = filters.searchQuery?.trim().toLowerCase() ?? ''
  if (query) {
    list = list.filter((summary) => {
      const haystack = [
        summary.id,
        summary.source,
        summary.label,
        summary.workingDirectory ?? '',
        summary.latestModel,
      ].join('\0').toLowerCase()
      return haystack.includes(query)
    })
  }

  if (filters.tagFilter) {
    const tag = filters.tagFilter.toLowerCase()
    list = list.filter((summary) => summary.tags?.includes(tag))
  }

  return list
}

export function maxSummaryCost(summaries: ConversationSummary[]): number {
  let max = 0
  for (const summary of summaries) {
    max = Math.max(max, summary.totalCost)
  }
  return max
}

export function sortSummaries(
  summaries: ConversationSummary[],
  sortMode: DashboardSortMode,
  maxCost = maxSummaryCost(summaries),
): ConversationSummary[] {
  const list = [...summaries]

  if (sortMode === 'priority') {
    list.sort((a, b) => {
      const aScore = computeSessionPriority(a, maxCost).score
      const bScore = computeSessionPriority(b, maxCost).score
      return bScore - aScore
    })
  } else if (sortMode === 'cost') {
    list.sort((a, b) => b.totalCost - a.totalCost)
  }

  return list
}

/** Limit KPI totals to the current local calendar day unless all-time is selected. */
export function summariesForKpiScope(
  summaries: ConversationSummary[],
  scope: KpiScope,
  now = new Date(),
): ConversationSummary[] {
  if (scope === 'all') return summaries

  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const cutoff = todayStart.getTime()
  return summaries.filter((summary) => new Date(summary.latestTimestamp).getTime() >= cutoff)
}

export function computeDashboardKpis(summaries: ConversationSummary[]): DashboardKpis {
  const totalSessions = summaries.length
  const totalRequests = summaries.reduce((sum, summary) => sum + summary.entryCount, 0)
  const totalTokens = summaries.reduce((sum, summary) => sum + summary.latestTotalTokens, 0)
  const totalCost = summaries.reduce((sum, summary) => sum + summary.totalCost, 0)

  const withHealth = summaries.filter((summary) => summary.healthScore?.overall != null)
  const avgHealth = withHealth.length === 0
    ? 0
    : Math.round(withHealth.reduce((sum, summary) => sum + (summary.healthScore?.overall ?? 0), 0) / withHealth.length)

  return { totalSessions, totalRequests, totalTokens, totalCost, avgHealth }
}

export function utilization(summary: ConversationSummary): number {
  if (!summary.contextLimit) return 0
  return summary.latestTotalTokens / summary.contextLimit
}

export function utilClass(value: number): string {
  if (value >= 0.8) return 'util-high'
  if (value >= 0.6) return 'util-mid'
  return 'util-low'
}

export function healthRatingClass(summary: ConversationSummary): string {
  const rating = summary.healthScore?.rating
  if (rating === 'poor') return 'health-bad'
  if (rating === 'needs-work') return 'health-warn'
  return 'health-good'
}

export function auditRatingClass(score: number): string {
  if (score >= 90) return 'health-good'
  if (score >= 50) return 'health-warn'
  return 'health-bad'
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

export function exactTime(iso: string): string {
  const date = new Date(iso)
  const time = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const day = date.toLocaleDateString('en-CA')
  return `${time} on ${day}`
}

export function compactDir(inputPath: string | null | undefined): string {
  if (!inputPath) return ''

  let compacted = inputPath
  if (/^\/home\/[^/]+(\/|$)/.test(compacted)) {
    compacted = compacted.replace(/^\/home\/[^/]+/, '~')
  } else if (/^\/Users\/[^/]+(\/|$)/.test(compacted)) {
    compacted = compacted.replace(/^\/Users\/[^/]+/, '~')
  }

  const parts = compacted.split('/')
  if (parts.length > 2) return parts.slice(-2).join('/')
  return compacted
}

export function sparkColor(barClass: string): string {
  if (barClass === 'prio-critical') return '#ef4444'
  if (barClass === 'prio-warning') return '#f59e0b'
  return '#0ea5e9'
}

/** Render a tiny self-contained sparkline used inside table rows. */
export function buildSparkSVG(data: number[], color: string): string {
  if (data.length === 0) return ''

  const width = 72
  const height = 22
  const max = Math.max(...data)
  if (max === 0) return ''

  const points = data.map((value, index) => {
    const x = data.length <= 1 ? width / 2 : (index / (data.length - 1)) * width
    const y = height - (value / max) * (height - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const area = `${points.join(' ')} ${width},${height} 0,${height}`
  const id = `sg${color.replace('#', '')}`
  const [lastX, lastY] = points[points.length - 1].split(',')

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="display:block;width:100%;height:100%">`
    + `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${color}" stop-opacity="0.15"/>`
    + `<stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>`
    + '</linearGradient></defs>'
    + `<polygon points="${area}" fill="url(#${id})"/>`
    + `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<circle cx="${lastX}" cy="${lastY}" r="2" fill="${color}"/>`
    + '</svg>'
}

export function getSparkSVG(summary: ConversationSummary, barClass: string): string {
  const data = summary.tokenHistory
  if (!data || data.length < 2) return ''
  return buildSparkSVG(data, sparkColor(barClass))
}
