<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import { fmtTokens, fmtCost, shortModel } from '@/utils/format'
import { classifyEntries, SIMPLE_META } from '@/utils/messages'
import type { ProjectedEntry } from '@/api-types'
import {
  type GroupSegment,
  type TimelineEvent,
  type DiffData,
  detectTimelineEvents,
  calculateContextDiff,
  barColor,
  barTooltip,
  segmentTooltip,
  markerLabel,
  markerTitle,
  calculateBarHeight,
  calculateYTicks,
  calculateLabelStep,
  calculateTurnNumbers,
  formatYTick,
  stackSegments,
  visibleTokens,
  groupedSegmentsForEntry,
} from '@/utils/timeline'

const store = useSessionStore()

type TimelineMode = 'all' | 'main' | 'cost'
const mode = ref<TimelineMode>('all')
const hiddenLegendKeys = ref(new Set<string>())
const chartScrollEl = ref<HTMLElement | null>(null)
const showLimitOverlay = ref(true)

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

const maxVal = computed(() => {
  let max = 0
  for (const item of filtered.value) {
    const val = mode.value === 'cost' ? (item.entry.costUsd ?? 0) : item.entry.contextInfo.totalTokens
    if (val > max) max = val
  }
  return max
})

const isSparse = computed(() => filtered.value.length <= 40)

const yTicks = computed(() => calculateYTicks(maxVisibleVal.value))

const turnNumbers = computed(() => calculateTurnNumbers(filtered.value))

const eventsByEntryId = computed(() =>
  detectTimelineEvents(filtered.value, classified.value)
)

function toggleLegend(key: string) {
  const next = new Set(hiddenLegendKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  hiddenLegendKeys.value = next
}

const maxVisibleVal = computed(() => {
  if (hiddenLegendKeys.value.size === 0) return maxVal.value
  let max = 0
  for (const item of filtered.value) {
    const val = mode.value === 'cost' ? (item.entry.costUsd ?? 0) : visibleTokens(item.entry, hiddenLegendKeys.value)
    if (val > max) max = val
  }
  return max
})

function getBarHeight(item: { entry: ProjectedEntry }): number {
  const val = mode.value === 'cost' ? (item.entry.costUsd ?? 0) : visibleTokens(item.entry, hiddenLegendKeys.value)
  return calculateBarHeight(val, maxVisibleVal.value)
}

function getStackSegments(item: { entry: ProjectedEntry }): GroupSegment[] {
  if (mode.value === 'cost') return []
  return stackSegments(item.entry, hiddenLegendKeys.value)
}

function selectTurn(entry: ProjectedEntry) {
  store.pinEntry(entry.id)
}

function jumpToCategory(category: string) {
  store.setInspectorTab('messages')
  store.focusMessageCategory(category)
}

const labelStep = computed(() => calculateLabelStep(filtered.value.length))

// ── Context limit overlay ──
// A dashed line showing the model's context window ceiling, overlaid on the bar chart.

const CHART_HEIGHT = 140

// Active entry's context limit
const contextLimit = computed(() => {
  const e = entry.value
  if (e && e.contextLimit > 0) return e.contextLimit
  const entries = filtered.value
  if (entries.length > 0) return entries[entries.length - 1].entry.contextLimit
  return 0
})

// Chart Y ceiling: account for context limit when overlay is on (not in cost mode)
const chartMaxWithLimit = computed(() => {
  const base = maxVisibleVal.value
  if (!showLimitOverlay.value || mode.value === 'cost') return base
  return Math.max(base, contextLimit.value)
})

// Context limit as percentage from top (for CSS positioning)
const limitPct = computed(() => {
  const max = chartMaxWithLimit.value
  const limit = contextLimit.value
  if (max === 0 || limit === 0) return -1
  return (1 - limit / max) * 100
})

// Bar height scaled to the (potentially expanded) ceiling
function getBarHeightWithLimit(item: { entry: ProjectedEntry }): number {
  if (!showLimitOverlay.value) return getBarHeight(item)
  const val = mode.value === 'cost' ? (item.entry.costUsd ?? 0) : visibleTokens(item.entry, hiddenLegendKeys.value)
  return calculateBarHeight(val, chartMaxWithLimit.value)
}

// Y ticks adjusted when limit overlay changes the ceiling
const yTicksWithLimit = computed(() => calculateYTicks(chartMaxWithLimit.value))

const diffData = computed((): DiffData | null => {
  const e = entry.value
  if (!e) return null
  return calculateContextDiff(e, classified.value)
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

function scrollChartToLatest() {
  nextTick(() => {
    if (!chartScrollEl.value) return
    chartScrollEl.value.scrollLeft = chartScrollEl.value.scrollWidth
  })
}

onMounted(() => {
  scrollChartToLatest()
})

watch(
  () => session.value?.id,
  () => {
    scrollChartToLatest()
  },
)

watch(
  () => filtered.value.length,
  (next, prev) => {
    if ((prev ?? 0) === 0 && next > 0) {
      scrollChartToLatest()
    }
  },
)
</script>

<template>
  <div v-if="session" class="timeline-tab">
    <!-- ═══ Chart ═══ -->
    <section class="panel">
      <div class="panel-head">
        <span class="panel-title">Timeline</span>
        <button
          v-if="mode !== 'cost'"
          class="overlay-toggle"
          :class="{ on: showLimitOverlay }"
          @click="showLimitOverlay = !showLimitOverlay"
        >
          <span class="legend-dot legend-dot--dashed" />
          Limit
        </button>
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
            <span v-for="tick in [...(showLimitOverlay ? yTicksWithLimit : yTicks)].reverse()" :key="tick">{{ formatYTick(tick, mode === 'cost' ? 'cost' : 'tokens') }}</span>
          </div>
          <div ref="chartScrollEl" class="chart-scroll">
            <div class="bars-wrap" :class="{ sparse: isSparse }">
              <div class="bars" :class="{ sparse: isSparse }">
                <div
                  v-for="(item, i) in filtered" :key="item.entry.id"
                  class="bar" :class="{ active: entry?.id === item.entry.id }"
                  :style="{ height: getBarHeightWithLimit(item) + '%' }"
                  v-tooltip="mode === 'cost' ? barTooltip(item.entry, item.isMain) : ''"
                  @click="selectTurn(item.entry)"
                >
                  <div v-if="mode === 'cost'" class="bar-cost" :style="{ background: barColor(item.entry.contextInfo.model, item.isMain) }" />
                  <template v-else>
                    <div
                      v-for="segment in getStackSegments(item)"
                      :key="item.entry.id + '-' + segment.key"
                      class="bar-segment"
                      :style="{ height: segment.pct + '%', background: segment.color }"
                      v-tooltip="segmentTooltip(item.entry, segment)"
                    />
                  </template>
                </div>
              </div>

              <!-- Context limit line overlay -->
              <div
                v-if="showLimitOverlay && mode !== 'cost' && limitPct >= 0"
                class="limit-line"
                :style="{ top: limitPct + '%' }"
              />
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
            <button v-for="item in diffData.topIncreases" :key="'inc-' + item.group" class="diff-summary-chip diff-summary-chip--up" @click="jumpToCategory(item.category)">
              {{ item.label }} +{{ fmtTokens(item.delta) }}
            </button>
          </div>
          <div class="diff-summary-group" v-if="diffData.topDecreases.length > 0">
            <span class="diff-summary-label">Shrink drivers</span>
            <button v-for="item in diffData.topDecreases" :key="'dec-' + item.group" class="diff-summary-chip diff-summary-chip--down" @click="jumpToCategory(item.category)">
              {{ item.label }} {{ fmtTokens(item.delta) }}
            </button>
          </div>
        </div>

        <button v-for="(line, i) in diffData.lines" :key="i" class="diff-line" :class="`diff-${line.type}`" @click="jumpToCategory(line.category)">
          {{ line.text }}
        </button>
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

// ── Limit overlay toggle ──
.overlay-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  margin-right: var(--space-2);
  font-size: var(--text-xs);
  padding: 2px 7px;
  background: none;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.1s, color 0.1s, border-color 0.1s;

  &:hover { color: var(--text-secondary); border-color: var(--border-mid); }
  &.on { background: var(--accent-red-dim); color: var(--accent-red); border-color: rgba(239, 68, 68, 0.3); }
}

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

// Wrapper provides positioning context for the limit line overlay
.bars-wrap {
  position: relative;
  height: 140px;
  min-width: min-content;

  &.sparse {
    min-width: 100%;
  }
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

// ── Context limit overlay ──
.limit-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 1px dashed var(--accent-red);
  opacity: 0.5;
  pointer-events: none;
  z-index: 1;
}



.legend-dot--dashed {
  width: 10px;
  height: 2px;
  border-radius: 0;
  background: none;
  border-top: 2px dashed var(--accent-red);
  opacity: 0.5;
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
  cursor: pointer;
  background: none;
  transition: filter 0.12s;

  &:hover { filter: brightness(1.3); }
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
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  cursor: pointer;
  display: block;
  transition: filter 0.12s;

  &:hover { filter: brightness(1.3); }
}

.diff-add { background: rgba(16, 185, 129, 0.06); color: #4ade80; }
.diff-remove { background: rgba(240, 96, 96, 0.06); color: #f87171; }
.diff-same { color: var(--text-ghost); }
.diff-empty { @include mono-text; color: var(--text-ghost); font-size: var(--text-xs); }
</style>
