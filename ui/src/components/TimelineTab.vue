<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import { fmtCost, fmtTokens, shortModel } from '@/utils/format'
import { classifyEntries, SIMPLE_META } from '@/utils/messages'
import type { ProjectedEntry } from '@/api-types'
import ContextDiffPanel from './ContextDiffPanel.vue'
import {
  type GroupSegment,
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
  cacheHitRate,
  projectTurnsRemaining,
} from '@/utils/timeline'

const store = useSessionStore()

type TimelineMode = 'all' | 'main'
const mode = computed({ get: () => store.timelineMode, set: (v) => { store.timelineMode = v } })
const stackMode = computed({ get: () => store.timelineStackMode, set: (v) => { store.timelineStackMode = v } })
const hiddenLegendKeys = computed({ get: () => store.timelineHiddenLegendKeys, set: (v) => { store.timelineHiddenLegendKeys = v } })
const showLimitOverlay = computed({ get: () => store.timelineShowLimitOverlay, set: (v) => { store.timelineShowLimitOverlay = v } })
const showCacheOverlay = computed({ get: () => store.timelineShowCacheOverlay, set: (v) => { store.timelineShowCacheOverlay = v } })
const tokenChartScrollEl = ref<HTMLElement | null>(null)
const costChartScrollEl = ref<HTMLElement | null>(null)

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

const maxTokenVal = computed(() => {
  let max = 0
  for (const item of filtered.value) {
    const val = item.entry.contextInfo.totalTokens
    if (val > max) max = val
  }
  return max
})

const maxCostVal = computed(() => {
  let max = 0
  for (const item of filtered.value) {
    const val = item.entry.costUsd ?? 0
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

const eventSlots = computed(() => {
  return filtered.value.map((item, i) => {
    const events = eventsByEntryId.value.get(item.entry.id) || []
    const firstEvent = events[0] || null
    const turnNum = turnNumbers.value[i] || i + 1
    return {
      entryId: item.entry.id,
      firstEvent,
      title: firstEvent ? markerTitle(events, turnNum) : '',
    }
  })
})

function toggleLegend(key: string) {
  const next = new Set(hiddenLegendKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  hiddenLegendKeys.value = next
}

const maxVisibleVal = computed(() => {
  if (hiddenLegendKeys.value.size === 0) return maxTokenVal.value
  let max = 0
  for (const item of filtered.value) {
    const val = visibleTokens(item.entry, hiddenLegendKeys.value)
    if (val > max) max = val
  }
  return max
})

function getBarHeight(item: { entry: ProjectedEntry }): number {
  const val = visibleTokens(item.entry, hiddenLegendKeys.value)
  return calculateBarHeight(val, maxVisibleVal.value)
}

function getStackSegments(item: { entry: ProjectedEntry }): GroupSegment[] {
  return stackSegments(item.entry, hiddenLegendKeys.value)
}

function getCostBarHeight(item: { entry: ProjectedEntry }): number {
  return calculateBarHeight(item.entry.costUsd ?? 0, maxCostVal.value)
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
  if (!showLimitOverlay.value) return base
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
  if (stackMode.value === 'normalized') return 100
  if (!showLimitOverlay.value) return getBarHeight(item)
  const val = visibleTokens(item.entry, hiddenLegendKeys.value)
  return calculateBarHeight(val, chartMaxWithLimit.value)
}

// Y ticks adjusted when limit overlay changes the ceiling
const yTicksWithLimit = computed(() => calculateYTicks(chartMaxWithLimit.value))
const costYTicks = computed(() => calculateYTicks(maxCostVal.value))

const yTicksNormalized = [0, 25, 50, 75, 100]

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

// ── Cache hit rate overlay (SVG polyline) ──

const lastMainSlotIndex = computed(() => {
  const items = filtered.value
  if (items.length === 0) return -1
  if (mode.value !== 'all') return items.length - 1
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].isMain) return i
  }
  return -1
})

const hasCacheData = computed(() => {
  const items = filtered.value
  const last = lastMainSlotIndex.value
  if (last < 0) return false
  for (let i = 0; i <= last; i++) {
    if (mode.value === 'all' && !items[i].isMain) continue
    if (cacheHitRate(items[i].entry) !== null) return true
  }
  return false
})

// SVG polyline points for cache hit rate.
// We use a viewBox whose X range matches the number of bar slots so each
// point lands exactly on its bar center, regardless of sparse/dense mode.
const cacheViewBox = computed(() => {
  const count = Math.max(0, lastMainSlotIndex.value + 1)
  if (count === 0) return '0 0 1 100'
  return `0 0 ${count} 100`
})

const cacheOverlayWidthPct = computed(() => {
  const totalSlots = filtered.value.length
  const coveredSlots = Math.max(0, lastMainSlotIndex.value + 1)
  if (totalSlots === 0 || coveredSlots === 0) return '0%'
  return `${(coveredSlots / totalSlots) * 100}%`
})

const cacheLinePoints = computed((): string => {
  const items = filtered.value
  const last = lastMainSlotIndex.value
  if (items.length === 0 || last < 0) return ''
  const points: string[] = []
  for (let i = 0; i <= last; i++) {
    if (mode.value === 'all' && !items[i].isMain) continue
    const rate = cacheHitRate(items[i].entry)
    if (rate === null) continue
    // X: center of bar slot i (in slot units)
    const x = i + 0.5
    // Y: inverted (0% = top, 100% = bottom)
    const y = (1 - rate) * 100
    points.push(`${x.toFixed(3)},${y.toFixed(2)}`)
  }
  return points.join(' ')
})

// ── Turns remaining projection ──

const projection = computed(() => {
  return projectTurnsRemaining(classified.value)
})

function scrollToLatest(el: HTMLElement | null) {
  if (!el) return
  el.scrollLeft = el.scrollWidth
}

function scrollChartsToLatest() {
  nextTick(() => {
    scrollToLatest(tokenChartScrollEl.value)
    scrollToLatest(costChartScrollEl.value)
  })
}

onMounted(() => {
  scrollChartsToLatest()
})

watch(
  () => [
    session.value?.id ?? '',
    mode.value,
    filtered.value.length,
    filtered.value[filtered.value.length - 1]?.entry.id ?? '',
  ],
  () => {
    scrollChartsToLatest()
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="session" class="timeline-tab">
    <div class="timeline-scope-controls">
      <span class="scope-label">Scope</span>
      <div class="scope-toggle">
        <button
          v-for="m in (['all', 'main'] as TimelineMode[])"
          :key="'scope-' + m"
          :class="{ on: mode === m }"
          @click="mode = m"
        >
          {{ m === 'all' ? 'All turns' : 'Main turns' }}
        </button>
      </div>
    </div>

    <!-- ═══ Token timeline ═══ -->
    <section class="panel panel--hero">
      <div class="panel-head">
        <span class="panel-title">Token Timeline</span>
        <div class="panel-controls">
          <button v-if="hasCacheData" class="overlay-toggle" :class="{ on: showCacheOverlay }" @click="showCacheOverlay = !showCacheOverlay">
            <span class="legend-dot legend-dot--cache" />
            Cache
          </button>
          <button v-if="stackMode === 'absolute'" class="overlay-toggle" :class="{ on: showLimitOverlay }" @click="showLimitOverlay = !showLimitOverlay">
            <span class="legend-dot legend-dot--dashed" />
            Limit
          </button>
          <div class="mode-toggle">
            <button :class="{ on: stackMode === 'absolute' }" v-tooltip="'Absolute token counts'" @click="stackMode = 'absolute'">
              <i class="i-carbon-chart-column mode-icon" />
              Abs
            </button>
            <button :class="{ on: stackMode === 'normalized' }" v-tooltip="'Normalized to 100% per turn'" @click="stackMode = 'normalized'">
              <i class="i-carbon-chart-maximum mode-icon" />
              Pct
            </button>
          </div>
        </div>
      </div>
      <div class="panel-body">
        <div class="chart-container">
          <div class="y-axis">
            <template v-if="stackMode === 'normalized'">
              <span v-for="tick in [...yTicksNormalized].reverse()" :key="'norm-' + tick">{{ tick }}%</span>
            </template>
            <template v-else>
              <span v-for="tick in [...(showLimitOverlay ? yTicksWithLimit : yTicks)].reverse()" :key="tick">{{ formatYTick(tick, 'tokens') }}</span>
            </template>
          </div>
          <div ref="tokenChartScrollEl" class="chart-scroll">
            <div class="bars-wrap" :class="{ sparse: isSparse }">
              <div class="bars" :class="{ sparse: isSparse }">
                <div
                  v-for="(item, i) in filtered" :key="item.entry.id"
                  class="bar" :class="{ active: entry?.id === item.entry.id, normalized: stackMode === 'normalized' }"
                  :style="{ height: getBarHeightWithLimit(item) + '%' }"
                  @click="selectTurn(item.entry)"
                >
                  <div
                    v-for="segment in getStackSegments(item)"
                    :key="item.entry.id + '-' + segment.key"
                    class="bar-segment"
                    :style="{ height: segment.pct + '%', background: segment.color }"
                    v-tooltip="segmentTooltip(item.entry, segment)"
                  />
                </div>
              </div>

              <!-- Context limit line overlay -->
              <div
                v-if="stackMode === 'absolute' && showLimitOverlay && limitPct >= 0"
                class="limit-line"
                :style="{ top: limitPct + '%' }"
              />

              <!-- Cache hit rate line overlay -->
              <svg
                v-if="showCacheOverlay && cacheLinePoints"
                class="cache-line-svg"
                :viewBox="cacheViewBox"
                :style="{ width: cacheOverlayWidthPct }"
                preserveAspectRatio="none"
              >
                <polyline
                  :points="cacheLinePoints"
                  fill="none"
                  stroke="var(--accent-cyan)"
                  stroke-width="1.5"
                  vector-effect="non-scaling-stroke"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                  opacity="0.7"
                />
              </svg>

            </div>

            <div class="events" :class="{ sparse: isSparse }">
              <div v-for="slot in eventSlots" :key="'evt-' + slot.entryId" class="event-slot">
                <button
                  v-if="slot.firstEvent"
                  class="event-marker"
                  :class="`event-marker--${slot.firstEvent.type}`"
                  type="button"
                  :aria-label="slot.title"
                  v-tooltip="slot.title"
                >
                  {{ markerLabel(slot.firstEvent.type) }}
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
        <div class="chart-legend">
          <button
            v-for="g in legendGroups" :key="g.key"
            class="legend-item legend-item--interactive"
            :class="{ 'legend-item--hidden': hiddenLegendKeys.has(g.key) }"
            @click="toggleLegend(g.key)"
          >
            <span class="legend-dot" :style="{ background: hiddenLegendKeys.has(g.key) ? 'var(--text-ghost)' : g.color }" />
            {{ g.name }}
          </button>
          <span v-if="projection.turnsRemaining !== null && projection.turnsRemaining > 0" class="projection-badge" v-tooltip="`Growing ~${fmtTokens(Math.round(projection.growthPerTurn))}/turn over ${projection.sinceCompaction} turns since last compaction`">
            ~{{ projection.turnsRemaining }} turns remaining
          </span>
          <span v-else-if="projection.turnsRemaining === 0" class="projection-badge projection-badge--warn" v-tooltip="'Context window is at or near the limit'">
            At limit
          </span>
        </div>
      </div>
    </section>

    <!-- ═══ Cost timeline ═══ -->
    <section class="panel panel--secondary panel--spine panel--cost">
      <div class="panel-head">
        <span class="panel-title">Cost Timeline</span>
        <span class="panel-sub">Scope: {{ mode === 'main' ? 'Main turns only' : 'All turns' }}</span>
      </div>
      <div class="panel-body">
        <div class="chart-container">
          <div class="y-axis">
            <span v-for="tick in [...costYTicks].reverse()" :key="'cost-' + tick">{{ formatYTick(tick, 'cost') }}</span>
          </div>
          <div ref="costChartScrollEl" class="chart-scroll">
            <div class="bars-wrap" :class="{ sparse: isSparse }">
              <div class="bars" :class="{ sparse: isSparse }">
                <div
                  v-for="item in filtered" :key="'cost-' + item.entry.id"
                  class="bar" :class="{ active: entry?.id === item.entry.id }"
                  :style="{ height: getCostBarHeight(item) + '%' }"
                  v-tooltip="barTooltip(item.entry, item.isMain)"
                  @click="selectTurn(item.entry)"
                >
                  <div class="bar-cost" :style="{ background: barColor(item.entry.contextInfo.model, item.isMain) }" />
                </div>
              </div>
            </div>
            <div class="labels" :class="{ sparse: isSparse }">
              <div v-for="(num, i) in turnNumbers" :key="'cost-label-' + i" class="label">
                {{ num && (labelStep <= 1 || num % labelStep === 0) ? num : '' }}
              </div>
            </div>
          </div>
        </div>
        <div class="chart-legend">
          <span v-for="m in legendModels" :key="m.name" class="legend-item">
            <span class="legend-dot" :style="{ background: m.color }" />
            {{ m.name }}
          </span>
        </div>
      </div>
    </section>

    <!-- ═══ Context diff ═══ -->
    <ContextDiffPanel
      :diff-data="diffData"
      :show-when-empty="!!entry"
      @category-click="jumpToCategory"
    />
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

.timeline-scope-controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.scope-label {
  @include section-label;
  font-size: var(--text-xs);
  color: var(--text-dim);
}

.scope-toggle {
  display: inline-flex;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  overflow: hidden;

  button {
    font-size: var(--text-xs);
    padding: 4px 10px;
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

// ── Panels ──
.panel { @include panel; }

.panel--hero {
  border-color: var(--border-mid);
  border-left: 3px solid var(--accent-blue);
  box-shadow: -4px 0 12px rgba(14, 165, 233, 0.06);
}

.panel--secondary {
  background: var(--bg-field);
  border-color: rgba(51, 51, 51, 0.75);
}

.panel--spine {
  position: relative;
  border-left: none;

  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--spine-color, var(--accent-blue));
    pointer-events: none;
  }
}

.panel--cost {
  --spine-color: var(--accent-green);
}

.panel-head {
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-dim);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.panel-controls {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.panel--secondary .panel-head {
  background: var(--bg-surface);
}

.panel-title { @include section-label; }
.panel-sub { font-size: var(--text-xs); color: var(--text-ghost); }
.panel-body { padding: var(--space-4); }

// ── Limit overlay toggle ──
.overlay-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
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

  &:has(.legend-dot--cache).on {
    background: rgba(6, 182, 212, 0.12);
    color: var(--accent-cyan);
    border-color: rgba(6, 182, 212, 0.3);
  }
}

// ── Mode toggle ──
.mode-toggle {
  display: flex;
  margin-left: 0;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  overflow: hidden;

  button {
    font-size: var(--text-xs);
    padding: 3px 9px;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
    display: inline-flex;
    align-items: center;
    gap: 4px;

    &:hover { color: var(--text-secondary); }
    &.on { background: var(--accent-blue-dim); color: var(--accent-blue); }
    & + button { border-left: 1px solid var(--border-dim); }
  }
}

.mode-icon {
  font-size: 12px;
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
  width: fit-content;
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
  &.normalized {
    border-radius: 0;
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

.legend-dot--cache {
  width: 10px;
  height: 2px;
  border-radius: 0;
  background: var(--accent-cyan);
  opacity: 0.7;
}

// ── Cache hit rate line overlay ──
.cache-line-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2;
}

// ── Projection badge ──
.projection-badge {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--accent-amber);
  opacity: 0.8;
  margin-left: auto;

  &--warn {
    color: var(--accent-red);
  }
}

</style>
