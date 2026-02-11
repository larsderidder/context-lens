<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSessionStore } from '@/stores/session'
import { fmtTokens, fmtCost, shortModel } from '@/utils/format'
import { classifyEntries, CATEGORY_META, SIMPLE_GROUPS, SIMPLE_META } from '@/utils/messages'
import type { ProjectedEntry } from '@/api-types'

const store = useSessionStore()

type TimelineMode = 'all' | 'main' | 'cost'
const mode = ref<TimelineMode>('all')
const hiddenLegendKeys = ref(new Set<string>())

const session = computed(() => store.selectedSession)
const entry = computed(() => store.selectedEntry)

const classified = computed(() => {
  if (!session.value) return []
  return classifyEntries([...session.value.entries].reverse())
})

const filtered = computed(() => {
  if (mode.value === 'main') return classified.value.filter(x => x.isMain)
  return classified.value
})

interface GroupSegment {
  key: string
  label: string
  color: string
  tokens: number
  pct: number
}

interface TimelineEvent {
  type: 'compaction' | 'cache-shift' | 'subagent-burst' | 'tool-jump'
  label: string
  detail: string
}

function groupedSegmentsForEntry(e: ProjectedEntry): GroupSegment[] {
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

const maxVal = computed(() => {
  let max = 0
  for (const item of filtered.value) {
    const val = mode.value === 'cost' ? (item.entry.costUsd ?? 0) : item.entry.contextInfo.totalTokens
    if (val > max) max = val
  }
  return max
})

const isSparse = computed(() => filtered.value.length <= 40)

const yTicks = computed(() => {
  const max = maxVisibleVal.value
  if (max === 0) return [0]
  const count = 4
  const step = max / count
  const magnitude = Math.pow(10, Math.floor(Math.log10(step)))
  const niceStep = Math.ceil(step / magnitude) * magnitude
  const ticks: number[] = []
  for (let i = 0; i <= count; i++) {
    const v = i * niceStep
    if (v <= max * 1.1) ticks.push(v)
  }
  return ticks
})

const turnNumbers = computed(() => {
  let mainNum = 0
  return filtered.value.map(item => {
    if (item.isMain) mainNum++
    return item.isMain ? mainNum : 0
  })
})

function previousMainEntry(currentId: number): ProjectedEntry | null {
  const idx = classified.value.findIndex((item) => item.entry.id === currentId)
  if (idx <= 0) return null
  for (let i = idx - 1; i >= 0; i--) {
    if (classified.value[i].isMain) return classified.value[i].entry
  }
  return null
}

function subagentCallsInTurn(currentId: number): number {
  const idx = classified.value.findIndex((item) => item.entry.id === currentId)
  if (idx < 0) return 0
  let mainStart = idx
  for (let i = idx; i >= 0; i--) {
    if (classified.value[i].isMain) { mainStart = i; break }
  }
  let count = 0
  for (let i = mainStart + 1; i < classified.value.length; i++) {
    if (classified.value[i].isMain) break
    count++
  }
  return count
}

function markerLabel(type: TimelineEvent['type']): string {
  if (type === 'compaction') return 'C'
  if (type === 'cache-shift') return 'H'
  if (type === 'subagent-burst') return 'S'
  return 'T'
}

function markerTitle(events: TimelineEvent[], turnNum: number): string {
  const summary = events.map((event) => `${event.label}: ${event.detail}`).join(' | ')
  return `Turn ${turnNum}: ${summary}`
}

const eventsByEntryId = computed(() => {
  const map = new Map<number, TimelineEvent[]>()
  const toolJumpThreshold = 1800

  for (const item of filtered.value) {
    const events: TimelineEvent[] = []
    const prevMain = previousMainEntry(item.entry.id)

    if (prevMain && item.isMain) {
      const prevTokens = prevMain.contextInfo.totalTokens
      const currTokens = item.entry.contextInfo.totalTokens
      if (prevTokens > 0 && currTokens < prevTokens * 0.75) {
        events.push({
          type: 'compaction',
          label: 'Compaction',
          detail: `${fmtTokens(prevTokens)} → ${fmtTokens(currTokens)} total tokens`,
        })
      }

      const prevCache = prevMain.usage && prevMain.usage.inputTokens > 0
        ? prevMain.usage.cacheReadTokens / prevMain.usage.inputTokens
        : null
      const currCache = item.entry.usage && item.entry.usage.inputTokens > 0
        ? item.entry.usage.cacheReadTokens / item.entry.usage.inputTokens
        : null
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

    if (item.isMain) {
      const subCalls = subagentCallsInTurn(item.entry.id)
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
})

function toggleLegend(key: string) {
  const next = new Set(hiddenLegendKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  hiddenLegendKeys.value = next
}

function visibleTokens(item: { entry: ProjectedEntry }): number {
  if (mode.value === 'cost') return 0
  const hidden = hiddenLegendKeys.value
  if (hidden.size === 0) return item.entry.contextInfo.totalTokens
  const segments = groupedSegmentsForEntry(item.entry)
  return segments.filter(s => !hidden.has(s.key)).reduce((sum, s) => sum + s.tokens, 0)
}

const maxVisibleVal = computed(() => {
  if (hiddenLegendKeys.value.size === 0) return maxVal.value
  let max = 0
  for (const item of filtered.value) {
    const val = mode.value === 'cost' ? (item.entry.costUsd ?? 0) : visibleTokens(item)
    if (val > max) max = val
  }
  return max
})

function barHeight(item: { entry: ProjectedEntry }): number {
  const val = mode.value === 'cost' ? (item.entry.costUsd ?? 0) : visibleTokens(item)
  const max = maxVisibleVal.value
  if (max === 0) return 3
  return Math.max(3, Math.round((val / max) * 100))
}

function stackSegments(item: { entry: ProjectedEntry }): GroupSegment[] {
  if (mode.value === 'cost') return []
  const segments = groupedSegmentsForEntry(item.entry)
  const hidden = hiddenLegendKeys.value
  if (hidden.size === 0) return segments
  const visible = segments.filter(s => !hidden.has(s.key))
  // Recalculate percentages relative to visible total
  const total = visible.reduce((sum, s) => sum + s.tokens, 0)
  return visible.map(s => ({
    ...s,
    pct: total > 0 ? (s.tokens / total) * 100 : 0,
  }))
}

function barColor(model: string, isMain: boolean): string {
  const alpha = isMain ? '0.85' : '0.35'
  if (/opus/i.test(model)) return `rgba(251, 146, 60, ${alpha})`
  if (/sonnet/i.test(model)) return `rgba(96, 165, 250, ${alpha})`
  if (/haiku/i.test(model)) return `rgba(167, 139, 250, ${alpha})`
  if (/gpt/i.test(model)) return `rgba(16, 185, 129, ${alpha})`
  return `rgba(148, 163, 184, ${alpha})`
}

function barTooltip(item: { entry: ProjectedEntry; isMain: boolean }): string {
  const e = item.entry
  const prefix = item.isMain ? '' : 'Sub '
  return `${prefix}${shortModel(e.contextInfo.model)}: ${fmtTokens(e.contextInfo.totalTokens)} / ${fmtCost(e.costUsd)}`
}

function segmentTooltip(item: { entry: ProjectedEntry }, segment: GroupSegment): string {
  return `${segment.label}: ${fmtTokens(segment.tokens)} (${segment.pct.toFixed(1)}%)`
}

function selectTurn(entry: ProjectedEntry) {
  const idx = session.value?.entries.findIndex(e => e.id === entry.id) ?? -1
  if (idx >= 0) store.selectTurn(idx)
}

function fmtYTick(v: number): string {
  return mode.value === 'cost' ? fmtCost(v) : fmtTokens(v)
}

const labelStep = computed(() => {
  const len = filtered.value.length
  return len > 30 ? Math.ceil(len / 15) : 1
})

// Context diff
const diffData = computed(() => {
  const e = entry.value
  if (!e) return null
  const allClassified = classified.value
  const idx = allClassified.findIndex(c => c.entry.id === e.id)
  if (idx < 0) return null

  let prevEntry: ProjectedEntry | null = null
  for (let i = idx - 1; i >= 0; i--) {
    if (allClassified[i].isMain) { prevEntry = allClassified[i].entry; break }
  }
  if (!prevEntry) return null

  const prevComp = prevEntry.composition || []
  const currComp = e.composition || []
  const prevTotal = prevComp.reduce((s, c) => s + c.tokens, 0)
  const currTotal = currComp.reduce((s, c) => s + c.tokens, 0)
  const delta = currTotal - prevTotal

  const allCats = new Set<string>()
  for (const c of prevComp) allCats.add(c.category)
  for (const c of currComp) allCats.add(c.category)

  const categoryDiffs: { category: string; label: string; delta: number; prevTokens: number; currTokens: number }[] = []
  for (const cat of allCats) {
    const prev = prevComp.find(c => c.category === cat)
    const curr = currComp.find(c => c.category === cat)
    const prevTok = prev ? prev.tokens : 0
    const currTok = curr ? curr.tokens : 0
    const d = currTok - prevTok
    const meta = CATEGORY_META[cat] || { label: cat }
    categoryDiffs.push({ category: cat, label: meta.label, delta: d, prevTokens: prevTok, currTokens: currTok })
  }

  const lines: { type: 'add' | 'remove' | 'same'; text: string }[] = []
  for (const diff of [...categoryDiffs].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
    if (diff.delta === 0) lines.push({ type: 'same', text: `  ${diff.label}: ${fmtTokens(diff.currTokens)} (unchanged)` })
    else if (diff.prevTokens === 0) lines.push({ type: 'add', text: `+ ${diff.label}: ${fmtTokens(diff.currTokens)} (new)` })
    else if (diff.currTokens === 0) lines.push({ type: 'remove', text: `- ${diff.label}: ${fmtTokens(diff.prevTokens)} (removed)` })
    else if (diff.delta > 0) lines.push({ type: 'add', text: `+ ${diff.label}: ${fmtTokens(diff.prevTokens)} → ${fmtTokens(diff.currTokens)} (+${fmtTokens(diff.delta)})` })
    else lines.push({ type: 'remove', text: `- ${diff.label}: ${fmtTokens(diff.prevTokens)} → ${fmtTokens(diff.currTokens)} (${fmtTokens(diff.delta)})` })
  }

  const categoryToGroup = new Map<string, string>()
  for (const [group, categories] of Object.entries(SIMPLE_GROUPS)) {
    for (const cat of categories) categoryToGroup.set(cat, group)
  }
  const groupedDelta = new Map<string, number>()
  for (const diff of categoryDiffs) {
    const group = categoryToGroup.get(diff.category) ?? 'other'
    groupedDelta.set(group, (groupedDelta.get(group) ?? 0) + diff.delta)
  }

  const groupedSummary = Array.from(groupedDelta.entries())
    .map(([group, groupDelta]) => ({
      group,
      label: SIMPLE_META[group]?.label ?? group,
      delta: groupDelta,
    }))
    .filter((item) => item.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  const topIncreases = groupedSummary.filter((item) => item.delta > 0).slice(0, 3)
  const topDecreases = groupedSummary.filter((item) => item.delta < 0).slice(0, 3)

  let prevTurnNum = 0, currTurnNum = 0, mainCount = 0
  for (const c of allClassified) {
    if (c.isMain) mainCount++
    if (c.entry.id === prevEntry.id) prevTurnNum = mainCount
    if (c.entry.id === e.id) currTurnNum = mainCount
  }

  return { prevTurnNum, currTurnNum, delta, lines, topIncreases, topDecreases }
})

const legendModels = computed(() => {
  const seen = new Map<string, string>()
  for (const item of filtered.value) {
    const sm = shortModel(item.entry.contextInfo.model)
    if (!seen.has(sm)) seen.set(sm, barColor(item.entry.contextInfo.model, true))
  }
  return Array.from(seen.entries()).map(([name, color]) => ({ name, color }))
})

const legendGroups = computed(() => {
  return Object.entries(SIMPLE_META).map(([key, meta]) => ({
    key,
    name: meta.label,
    color: meta.color,
  }))
})
</script>

<template>
  <div v-if="session" class="timeline-tab">
    <!-- ═══ Chart ═══ -->
    <section class="panel">
      <div class="panel-head">
        <span class="panel-title">Timeline</span>
        <div class="mode-toggle">
          <button v-for="m in (['all', 'main', 'cost'] as TimelineMode[])" :key="m"
            :class="{ on: mode === m }" @click="mode = m">
            {{ m === 'all' ? 'All' : m === 'main' ? 'Main' : 'Cost' }}
          </button>
        </div>
      </div>
      <div class="panel-body">
        <div class="chart-container">
          <div class="y-axis">
            <span v-for="tick in [...yTicks].reverse()" :key="tick">{{ fmtYTick(tick) }}</span>
          </div>
          <div class="chart-scroll">
            <div class="bars" :class="{ sparse: isSparse }">
              <div
                v-for="(item, i) in filtered" :key="item.entry.id"
                class="bar" :class="{ active: entry?.id === item.entry.id }"
                :style="{ height: barHeight(item) + '%' }"
                v-tooltip="mode === 'cost' ? barTooltip(item) : ''"
                @click="selectTurn(item.entry)"
              >
                <div v-if="mode === 'cost'" class="bar-cost" :style="{ background: barColor(item.entry.contextInfo.model, item.isMain) }" />
                <template v-else>
                  <div
                    v-for="segment in stackSegments(item)"
                    :key="item.entry.id + '-' + segment.key"
                    class="bar-segment"
                    :style="{ height: segment.pct + '%', background: segment.color }"
                    v-tooltip="segmentTooltip(item, segment)"
                  />
                </template>
              </div>
            </div>
            <div class="events" :class="{ sparse: isSparse }">
              <div v-for="(item, i) in filtered" :key="'evt-' + item.entry.id" class="event-slot">
                <button
                  v-if="eventsByEntryId.get(item.entry.id)?.length"
                  class="event-marker"
                  :class="`event-marker--${eventsByEntryId.get(item.entry.id)![0].type}`"
                  type="button"
                  :aria-label="markerTitle(eventsByEntryId.get(item.entry.id)!, turnNumbers[i] || i + 1)"
                  v-tooltip="markerTitle(eventsByEntryId.get(item.entry.id)!, turnNumbers[i] || i + 1)"
                >
                  {{ markerLabel(eventsByEntryId.get(item.entry.id)![0].type) }}
                </button>
              </div>
            </div>
            <div class="labels" :class="{ sparse: isSparse }">
              <div v-for="(num, i) in turnNumbers" :key="i" class="label">
                {{ num && (labelStep <= 1 || num % labelStep === 0) ? num : '' }}
              </div>
            </div>
          </div>
        </div>
        <div class="chart-legend" v-if="mode === 'cost'">
          <span v-for="m in legendModels" :key="m.name" class="legend-item">
            <span class="legend-dot" :style="{ background: m.color }" />
            {{ m.name }}
          </span>
        </div>
        <div class="chart-legend" v-else>
          <button
            v-for="g in legendGroups" :key="g.key"
            class="legend-item legend-item--interactive"
            :class="{ 'legend-item--hidden': hiddenLegendKeys.has(g.key) }"
            @click="toggleLegend(g.key)"
          >
            <span class="legend-dot" :style="{ background: hiddenLegendKeys.has(g.key) ? 'var(--text-ghost)' : g.color }" />
            {{ g.name }}
          </button>
        </div>
      </div>
    </section>

    <!-- ═══ Context diff ═══ -->
    <section class="panel" v-if="diffData">
      <div class="panel-head">
        <span class="panel-title">Context Diff</span>
        <span class="panel-sub">Turn {{ diffData.prevTurnNum }} → {{ diffData.currTurnNum }}</span>
        <span class="diff-delta" :style="{ color: diffData.delta >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }">
          {{ diffData.delta >= 0 ? '+' : '' }}{{ fmtTokens(diffData.delta) }}
        </span>
      </div>
      <div class="panel-body diff-body">
        <div
          v-if="diffData.topIncreases.length > 0 || diffData.topDecreases.length > 0"
          class="diff-summary-row"
        >
          <div class="diff-summary-group" v-if="diffData.topIncreases.length > 0">
            <span class="diff-summary-label">Growth drivers</span>
            <span v-for="item in diffData.topIncreases" :key="'inc-' + item.group" class="diff-summary-chip diff-summary-chip--up">
              {{ item.label }} +{{ fmtTokens(item.delta) }}
            </span>
          </div>
          <div class="diff-summary-group" v-if="diffData.topDecreases.length > 0">
            <span class="diff-summary-label">Shrink drivers</span>
            <span v-for="item in diffData.topDecreases" :key="'dec-' + item.group" class="diff-summary-chip diff-summary-chip--down">
              {{ item.label }} {{ fmtTokens(item.delta) }}
            </span>
          </div>
        </div>

        <div v-for="(line, i) in diffData.lines" :key="i" class="diff-line" :class="`diff-${line.type}`">
          {{ line.text }}
        </div>
      </div>
    </section>
    <section class="panel" v-else-if="entry">
      <div class="panel-head">
        <span class="panel-title">Context Diff</span>
      </div>
      <div class="panel-body">
        <span class="diff-empty">First turn — no previous context.</span>
      </div>
    </section>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.timeline-tab {
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

// ── Panels ──
.panel { @include panel; }

.panel-head {
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-dim);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.panel-title { @include section-label; }
.panel-sub { font-size: var(--text-xs); color: var(--text-ghost); }
.panel-body { padding: var(--space-4); }

// ── Mode toggle ──
.mode-toggle {
  display: flex;
  margin-left: auto;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  overflow: hidden;

  button {
    font-size: var(--text-xs);
    padding: 3px 8px;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.1s, color 0.1s;

    &:hover { color: var(--text-secondary); }
    &.on { background: var(--accent-blue-dim); color: var(--accent-blue); }
    & + button { border-left: 1px solid var(--border-dim); }
  }
}

// ── Chart ──
.chart-container {
  display: flex;
  gap: 0;
}

.y-axis {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 140px;
  flex-shrink: 0;
  padding-right: 6px;
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-ghost);
  text-align: right;
  min-width: 32px;

  span { line-height: 1; }
}

.chart-scroll {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  @include scrollbar-thin;
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 140px;
  min-width: min-content;

  &.sparse .bar {
    flex: 1;
    width: auto;
    min-width: 6px;
    max-width: 24px;
  }
}

.bar {
  flex: 0 0 auto;
  width: 10px;
  border-radius: 2px 2px 0 0;
  cursor: pointer;
  transition: filter 0.12s, height 0.3s ease;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  overflow: hidden;
  background: rgba(51, 65, 85, 0.25);

  &:hover { filter: brightness(1.3); }
  &.active {
    box-shadow: 0 0 0 1.5px var(--accent-blue), 0 0 6px rgba(94, 159, 248, 0.25);
  }
}

.bar-cost {
  width: 100%;
  height: 100%;
}

.bar-segment {
  width: 100%;
}

.labels {
  display: flex;
  gap: 2px;
  min-width: min-content;

  &.sparse .label {
    flex: 1;
    width: auto;
    min-width: 6px;
    max-width: 24px;
  }
}

.events {
  display: flex;
  gap: 2px;
  min-width: min-content;
  margin-top: 2px;

  &.sparse .event-slot {
    flex: 1;
    width: auto;
    min-width: 6px;
    max-width: 24px;
  }
}

.event-slot {
  flex: 0 0 auto;
  width: 10px;
  display: flex;
  justify-content: center;
}

.event-marker {
  width: 11px;
  height: 11px;
  border-radius: var(--radius-full);
  border: 1px solid rgba(148, 163, 184, 0.45);
  background: rgba(148, 163, 184, 0.2);
  color: var(--text-secondary);
  @include mono-text;
  font-size: 8px;
  line-height: 1;
  padding: 0;
  cursor: help;
}

.event-marker--compaction {
  border-color: rgba(248, 113, 113, 0.5);
  background: rgba(248, 113, 113, 0.25);
}

.event-marker--cache-shift {
  border-color: rgba(91, 156, 245, 0.5);
  background: rgba(91, 156, 245, 0.25);
}

.event-marker--subagent-burst {
  border-color: rgba(167, 139, 250, 0.5);
  background: rgba(167, 139, 250, 0.25);
}

.event-marker--tool-jump {
  border-color: rgba(52, 211, 153, 0.55);
  background: rgba(52, 211, 153, 0.25);
}

.label {
  flex: 0 0 auto;
  width: 10px;
  text-align: center;
  font-size: var(--text-xs);
  color: var(--text-ghost);
  @include mono-text;
  padding-top: 2px;
}

.chart-legend {
  display: flex;
  gap: var(--space-4);
  margin-top: var(--space-2);
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--text-dim);
}

.legend-item--interactive {
  background: none;
  border: none;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s;

  &:hover { background: var(--bg-hover); }
  &.legend-item--hidden { opacity: 0.4; text-decoration: line-through; }
}

.legend-dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  transition: background 0.15s;
}

// ── Diff ──
.diff-delta {
  margin-left: auto;
  @include mono-text;
  font-size: var(--text-xs);
  font-weight: 700;
}

.diff-body { padding: var(--space-3) var(--space-4); }

.diff-summary-row {
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  padding: var(--space-2);
  margin-bottom: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.diff-summary-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.diff-summary-label {
  font-size: var(--text-xs);
  color: var(--text-ghost);
}

.diff-summary-chip {
  @include mono-text;
  font-size: var(--text-xs);
  border-radius: var(--radius-sm);
  padding: 2px 6px;
  border: 1px solid transparent;
}

.diff-summary-chip--up {
  color: #4ade80;
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.25);
}

.diff-summary-chip--down {
  color: #f87171;
  background: rgba(240, 96, 96, 0.08);
  border-color: rgba(240, 96, 96, 0.25);
}

.diff-line {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 2px 6px;
  border-radius: 2px;
  margin-bottom: 1px;
}

.diff-add { background: rgba(16, 185, 129, 0.06); color: #4ade80; }
.diff-remove { background: rgba(240, 96, 96, 0.06); color: #f87171; }
.diff-same { color: var(--text-ghost); }
.diff-empty { @include mono-text; color: var(--text-ghost); font-size: var(--text-xs); }
</style>
