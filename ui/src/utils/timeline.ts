import type { ProjectedEntry } from '@/api-types'
import { fmtTokens, fmtCost, shortModel } from './format'
import { CATEGORY_META, SIMPLE_GROUPS, SIMPLE_META, type ClassifiedEntry } from './messages'

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface GroupSegment {
  key: string
  label: string
  color: string
  tokens: number
  pct: number
}

export interface TimelineEvent {
  type: 'compaction' | 'cache-shift' | 'subagent-burst' | 'tool-jump'
  label: string
  detail: string
}

export interface DiffData {
  prevTurnNum: number
  currTurnNum: number
  delta: number
  lines: { type: 'add' | 'remove' | 'same'; text: string; category: string }[]
  topIncreases: { group: string; label: string; delta: number; category: string }[]
  topDecreases: { group: string; label: string; delta: number; category: string }[]
}

// ══════════════════════════════════════════════════════════════════════════════
// Composition & Segments
// ══════════════════════════════════════════════════════════════════════════════

export function groupedSegmentsForEntry(e: ProjectedEntry): GroupSegment[] {
  const comp = e.composition || []
  const total = comp.reduce((sum, item) => sum + item.tokens, 0)
  const segments: GroupSegment[] = []

  for (const [groupKey, categories] of Object.entries(SIMPLE_GROUPS)) {
    let tokens = 0
    for (const cat of categories) {
      const found = comp.find((item) => item.category === cat)
      if (found) tokens += found.tokens
    }
    if (tokens > 0) {
      segments.push({
        key: groupKey,
        label: SIMPLE_META[groupKey]?.label ?? groupKey,
        color: SIMPLE_META[groupKey]?.color ?? '#4b5563',
        tokens,
        pct: total > 0 ? (tokens / total) * 100 : 0,
      })
    }
  }

  return segments.sort((a, b) => b.tokens - a.tokens)
}

export function stackSegments(
  entry: ProjectedEntry,
  hiddenKeys: Set<string>
): GroupSegment[] {
  const segments = groupedSegmentsForEntry(entry)
  if (hiddenKeys.size === 0) return segments

  const visible = segments.filter((s) => !hiddenKeys.has(s.key))
  const total = visible.reduce((sum, s) => sum + s.tokens, 0)
  return visible.map((s) => ({
    ...s,
    pct: total > 0 ? (s.tokens / total) * 100 : 0,
  }))
}

export function visibleTokens(entry: ProjectedEntry, hiddenKeys: Set<string>): number {
  if (hiddenKeys.size === 0) return entry.contextInfo.totalTokens
  const segments = groupedSegmentsForEntry(entry)
  return segments.filter((s) => !hiddenKeys.has(s.key)).reduce((sum, s) => sum + s.tokens, 0)
}

// ══════════════════════════════════════════════════════════════════════════════
// Entry Navigation & Analysis
// ══════════════════════════════════════════════════════════════════════════════

export function previousMainEntry(
  currentId: number,
  classified: ClassifiedEntry[]
): ProjectedEntry | null {
  const idx = classified.findIndex((item) => item.entry.id === currentId)
  if (idx <= 0) return null
  for (let i = idx - 1; i >= 0; i--) {
    if (classified[i].isMain) return classified[i].entry
  }
  return null
}

export function subagentCallsInTurn(currentId: number, classified: ClassifiedEntry[]): number {
  const idx = classified.findIndex((item) => item.entry.id === currentId)
  if (idx < 0) return 0

  let mainStart = idx
  for (let i = idx; i >= 0; i--) {
    if (classified[i].isMain) {
      mainStart = i
      break
    }
  }

  let count = 0
  for (let i = mainStart + 1; i < classified.length; i++) {
    if (classified[i].isMain) break
    count++
  }
  return count
}

// ══════════════════════════════════════════════════════════════════════════════
// Event Detection
// ══════════════════════════════════════════════════════════════════════════════

export function detectTimelineEvents(
  filtered: ClassifiedEntry[],
  classified: ClassifiedEntry[]
): Map<number, TimelineEvent[]> {
  const map = new Map<number, TimelineEvent[]>()
  const toolJumpThreshold = 1800

  for (const item of filtered) {
    const events: TimelineEvent[] = []
    const prevMain = previousMainEntry(item.entry.id, classified)

    if (prevMain && item.isMain) {
      // Compaction detection
      const prevTokens = prevMain.contextInfo.totalTokens
      const currTokens = item.entry.contextInfo.totalTokens
      if (prevTokens > 0 && currTokens < prevTokens * 0.75) {
        events.push({
          type: 'compaction',
          label: 'Compaction',
          detail: `${fmtTokens(prevTokens)} → ${fmtTokens(currTokens)} total tokens`,
        })
      }

      // Cache shift detection
      const prevTotal = prevMain.usage
        ? prevMain.usage.inputTokens + prevMain.usage.cacheReadTokens + prevMain.usage.cacheWriteTokens
        : 0
      const currTotal = item.entry.usage
        ? item.entry.usage.inputTokens + item.entry.usage.cacheReadTokens + item.entry.usage.cacheWriteTokens
        : 0
      const prevCache = prevTotal > 0 ? prevMain.usage!.cacheReadTokens / prevTotal : null
      const currCache = currTotal > 0 ? item.entry.usage!.cacheReadTokens / currTotal : null

      if (prevCache !== null && currCache !== null) {
        const delta = currCache - prevCache
        if (Math.abs(delta) >= 0.2) {
          events.push({
            type: 'cache-shift',
            label: 'Cache shift',
            detail: `${Math.round(prevCache * 100)}% → ${Math.round(currCache * 100)}% hit rate`,
          })
        }
      }

      // Tool jump detection
      const prevTool = prevMain.composition.find((comp) => comp.category === 'tool_results')?.tokens ?? 0
      const currTool = item.entry.composition.find((comp) => comp.category === 'tool_results')?.tokens ?? 0
      if (currTool - prevTool >= toolJumpThreshold) {
        events.push({
          type: 'tool-jump',
          label: 'Tool jump',
          detail: `tool results +${fmtTokens(currTool - prevTool)}`,
        })
      }
    }

    // Subagent burst detection
    if (item.isMain) {
      const subCalls = subagentCallsInTurn(item.entry.id, classified)
      if (subCalls >= 3) {
        events.push({
          type: 'subagent-burst',
          label: 'Subagent burst',
          detail: `${subCalls} subagent calls in this turn`,
        })
      }
    }

    if (events.length > 0) map.set(item.entry.id, events)
  }

  return map
}

export function markerLabel(type: TimelineEvent['type']): string {
  if (type === 'compaction') return 'C'
  if (type === 'cache-shift') return 'H'
  if (type === 'subagent-burst') return 'S'
  return 'T'
}

export function markerTitle(events: TimelineEvent[], turnNum: number): string {
  const summary = events.map((event) => `${event.label}: ${event.detail}`).join(' | ')
  return `Turn ${turnNum}: ${summary}`
}

// ══════════════════════════════════════════════════════════════════════════════
// Context Diff
// ══════════════════════════════════════════════════════════════════════════════

export function calculateContextDiff(
  current: ProjectedEntry,
  classified: ClassifiedEntry[]
): DiffData | null {
  const idx = classified.findIndex((c) => c.entry.id === current.id)
  if (idx < 0) return null

  // Find previous entry with the same agent key for a meaningful diff
  const currAgentKey = current.agentKey || '_default'
  let prevEntry: ProjectedEntry | null = null
  for (let i = idx - 1; i >= 0; i--) {
    const candidate = classified[i].entry
    if ((candidate.agentKey || '_default') === currAgentKey) {
      prevEntry = candidate
      break
    }
  }
  if (!prevEntry) return null

  const prevComp = prevEntry.composition || []
  const currComp = current.composition || []
  const prevTotal = prevEntry.contextInfo.totalTokens
  const currTotal = current.contextInfo.totalTokens
  const delta = currTotal - prevTotal

  // Calculate category-level diffs
  const allCats = new Set<string>()
  for (const c of prevComp) allCats.add(c.category)
  for (const c of currComp) allCats.add(c.category)

  const categoryDiffs: {
    category: string
    label: string
    delta: number
    prevTokens: number
    currTokens: number
  }[] = []

  for (const cat of allCats) {
    const prev = prevComp.find((c) => c.category === cat)
    const curr = currComp.find((c) => c.category === cat)
    const prevTok = prev ? prev.tokens : 0
    const currTok = curr ? curr.tokens : 0
    const d = currTok - prevTok
    const meta = CATEGORY_META[cat] || { label: cat }
    categoryDiffs.push({
      category: cat,
      label: meta.label,
      delta: d,
      prevTokens: prevTok,
      currTokens: currTok,
    })
  }

  // Format diff lines
  const lines: { type: 'add' | 'remove' | 'same'; text: string; category: string }[] = []
  for (const diff of [...categoryDiffs].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
    if (diff.delta === 0) {
      lines.push({
        type: 'same',
        text: `  ${diff.label}: ${fmtTokens(diff.currTokens)} (unchanged)`,
        category: diff.category,
      })
    } else if (diff.prevTokens === 0) {
      lines.push({
        type: 'add',
        text: `+ ${diff.label}: ${fmtTokens(diff.currTokens)} (new)`,
        category: diff.category,
      })
    } else if (diff.currTokens === 0) {
      lines.push({
        type: 'remove',
        text: `- ${diff.label}: ${fmtTokens(diff.prevTokens)} (removed)`,
        category: diff.category,
      })
    } else if (diff.delta > 0) {
      lines.push({
        type: 'add',
        text: `+ ${diff.label}: ${fmtTokens(diff.prevTokens)} → ${fmtTokens(diff.currTokens)} (+${fmtTokens(diff.delta)})`,
        category: diff.category,
      })
    } else {
      lines.push({
        type: 'remove',
        text: `- ${diff.label}: ${fmtTokens(diff.prevTokens)} → ${fmtTokens(diff.currTokens)} (${fmtTokens(diff.delta)})`,
        category: diff.category,
      })
    }
  }

  // Group by SIMPLE_GROUPS
  const categoryToGroup = new Map<string, string>()
  for (const [group, categories] of Object.entries(SIMPLE_GROUPS)) {
    for (const cat of categories) categoryToGroup.set(cat, group)
  }

  const groupedDelta = new Map<string, number>()
  const groupTopCategory = new Map<string, { category: string; absDelta: number }>()

  for (const diff of categoryDiffs) {
    const group = categoryToGroup.get(diff.category) ?? 'other'
    groupedDelta.set(group, (groupedDelta.get(group) ?? 0) + diff.delta)
    const prev = groupTopCategory.get(group)
    if (!prev || Math.abs(diff.delta) > prev.absDelta) {
      groupTopCategory.set(group, { category: diff.category, absDelta: Math.abs(diff.delta) })
    }
  }

  const groupedSummary = Array.from(groupedDelta.entries())
    .map(([group, groupDelta]) => ({
      group,
      label: SIMPLE_META[group]?.label ?? group,
      delta: groupDelta,
      category: groupTopCategory.get(group)?.category ?? '',
    }))
    .filter((item) => item.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  const topIncreases = groupedSummary.filter((item) => item.delta > 0).slice(0, 3)
  const topDecreases = groupedSummary.filter((item) => item.delta < 0).slice(0, 3)

  // Calculate turn numbers
  let prevTurnNum = 0
  let currTurnNum = 0
  let agentCount = 0
  for (const c of classified) {
    if ((c.entry.agentKey || '_default') === currAgentKey) agentCount++
    if (c.entry.id === prevEntry.id) prevTurnNum = agentCount
    if (c.entry.id === current.id) currTurnNum = agentCount
  }

  return { prevTurnNum, currTurnNum, delta, lines, topIncreases, topDecreases }
}

// ══════════════════════════════════════════════════════════════════════════════
// Chart Calculations
// ══════════════════════════════════════════════════════════════════════════════

export function barColor(model: string, isMain: boolean): string {
  const alpha = isMain ? '0.85' : '0.35'
  if (/opus/i.test(model)) return `rgba(251, 146, 60, ${alpha})`
  if (/sonnet/i.test(model)) return `rgba(96, 165, 250, ${alpha})`
  if (/haiku/i.test(model)) return `rgba(167, 139, 250, ${alpha})`
  if (/gpt/i.test(model)) return `rgba(16, 185, 129, ${alpha})`
  return `rgba(148, 163, 184, ${alpha})`
}

export function calculateBarHeight(value: number, max: number, minHeight = 3): number {
  if (max === 0) return minHeight
  return Math.max(minHeight, Math.round((value / max) * 100))
}

export function calculateYTicks(max: number, count = 4): number[] {
  if (max === 0) return [0]
  const step = max / count
  const magnitude = Math.pow(10, Math.floor(Math.log10(step)))
  const niceStep = Math.ceil(step / magnitude) * magnitude
  const ticks: number[] = []
  for (let i = 0; i <= count; i++) {
    const v = i * niceStep
    if (v <= max * 1.1) ticks.push(v)
  }
  return ticks
}

export function calculateLabelStep(entryCount: number): number {
  return entryCount > 30 ? Math.ceil(entryCount / 15) : 1
}

export function calculateTurnNumbers(filtered: ClassifiedEntry[]): number[] {
  let mainNum = 0
  return filtered.map((item) => {
    if (item.isMain) mainNum++
    return item.isMain ? mainNum : 0
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// Tooltips
// ══════════════════════════════════════════════════════════════════════════════

export function barTooltip(entry: ProjectedEntry, isMain: boolean): string {
  const prefix = isMain ? '' : 'Sub '
  return `${prefix}${shortModel(entry.contextInfo.model)}: ${fmtTokens(entry.contextInfo.totalTokens)} / ${fmtCost(entry.costUsd)}`
}

export function segmentTooltip(entry: ProjectedEntry, activeSegment: GroupSegment): string {
  const segments = groupedSegmentsForEntry(entry)
  const total = entry.contextInfo.totalTokens
  const lines = segments.map((s) => {
    const marker = s.key === activeSegment.key ? '▸ ' : '  '
    return `${marker}${s.label}: ${fmtTokens(s.tokens)} (${s.pct.toFixed(1)}%)`
  })
  lines.push(`  Total: ${fmtTokens(total)}`)
  return lines.join('\n')
}

export function formatYTick(value: number, mode: 'cost' | 'tokens'): string {
  return mode === 'cost' ? fmtCost(value) : fmtTokens(value)
}
