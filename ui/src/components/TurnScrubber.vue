<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSessionStore } from '@/stores/session'
import { classifyEntries } from '@/utils/messages'
import { fmtTokens, fmtCost, shortModel } from '@/utils/format'

const store = useSessionStore()

const trackEl = ref<HTMLElement | null>(null)
const isDragging = ref(false)
const hoverIndex = ref<number | null>(null)

const session = computed(() => store.selectedSession)
const selectedEntry = computed(() => store.selectedEntry)

const classifiedOldestFirst = computed(() => {
  if (!session.value) return []
  return classifyEntries([...session.value.entries].reverse())
})

const mainEntries = computed(() => {
  return classifiedOldestFirst.value
    .filter((item) => item.isMain)
    .map((item) => item.entry)
})

const turnCount = computed(() => mainEntries.value.length)

const selectedTurnIndex = computed(() => {
  const selected = selectedEntry.value
  if (!selected) return -1
  // Find which main turn the selected entry belongs to
  let currentMain = -1
  for (const item of classifiedOldestFirst.value) {
    if (item.isMain) currentMain++
    if (item.entry.id === selected.id) return currentMain
  }
  return -1
})

const maxTokens = computed(() => {
  let max = 0
  for (const e of mainEntries.value) {
    if (e.contextInfo.totalTokens > max) max = e.contextInfo.totalTokens
  }
  return max
})

// Sparkline data: normalized heights 0..1 for each main turn
interface SparkDatum {
  height: number
  tokens: number
  cost: number
  model: string
  limit: number
  utilization: number
}

const sparkData = computed((): SparkDatum[] => {
  const max = maxTokens.value
  if (max === 0) return mainEntries.value.map(() => ({ height: 0.15, tokens: 0, cost: 0, model: '', limit: 0, utilization: 0 }))
  return mainEntries.value.map((e) => ({
    height: Math.max(0.08, e.contextInfo.totalTokens / max),
    tokens: e.contextInfo.totalTokens,
    cost: e.costUsd ?? 0,
    model: shortModel(e.contextInfo.model),
    limit: e.contextLimit,
    utilization: e.contextLimit > 0 ? e.contextInfo.totalTokens / e.contextLimit : 0,
  }))
})

const hasNewerTurns = computed(() => {
  if (store.selectionMode !== 'pinned') return false
  if (selectedTurnIndex.value < 0) return false
  return selectedTurnIndex.value < turnCount.value - 1
})

const newerTurnCount = computed(() => {
  if (!hasNewerTurns.value) return 0
  return Math.max(0, (turnCount.value - 1) - selectedTurnIndex.value)
})

// Badge positioning: center it in the dimmed (future) region of the track.
// Hide when the future region is too narrow to fit the badge legibly.
const showNewBadge = computed(() => {
  if (!hasNewerTurns.value) return false
  // Need at least ~12% of the track width to fit the badge without crowding
  const futureFraction = newerTurnCount.value / turnCount.value
  return futureFraction >= 0.12
})

const newBadgeLeft = computed(() => {
  // Midpoint of the future region: from (selectedTurnIndex+1) to (turnCount-1)
  const futureStart = (selectedTurnIndex.value + 1) / turnCount.value
  const futureEnd = 1
  return ((futureStart + futureEnd) / 2) * 100
})

// Sub-agent calls in each turn (for the density dots below the spark)
const subCallsPerTurn = computed(() => {
  const result: number[] = []
  let currentSubs = 0
  let mainIdx = -1
  for (const item of classifiedOldestFirst.value) {
    if (item.isMain) {
      if (mainIdx >= 0) result.push(currentSubs)
      currentSubs = 0
      mainIdx++
    } else {
      currentSubs++
    }
  }
  if (mainIdx >= 0) result.push(currentSubs)
  return result
})

// Tooltip data
const tooltipEntry = computed(() => {
  if (hoverIndex.value === null || hoverIndex.value < 0 || hoverIndex.value >= mainEntries.value.length) return null
  const e = mainEntries.value[hoverIndex.value]
  const data = sparkData.value[hoverIndex.value]
  const subs = subCallsPerTurn.value[hoverIndex.value] || 0
  return {
    turn: hoverIndex.value + 1,
    tokens: fmtTokens(e.contextInfo.totalTokens),
    cost: fmtCost(e.costUsd),
    model: data.model,
    subs,
    utilization: data.utilization,
    isSelected: hoverIndex.value === selectedTurnIndex.value,
  }
})

function selectTurn(index: number) {
  if (index < 0 || index >= mainEntries.value.length) return
  store.pinEntry(mainEntries.value[index].id)
}

function followLive() {
  store.followLive()
}

function goPrevTurn() {
  if (selectedTurnIndex.value <= 0) return
  selectTurn(selectedTurnIndex.value - 1)
}

function goNextTurn() {
  if (selectedTurnIndex.value < 0 || selectedTurnIndex.value >= turnCount.value - 1) return
  selectTurn(selectedTurnIndex.value + 1)
}

function pinCurrentTurn() {
  if (!selectedEntry.value) return
  store.pinEntry(selectedEntry.value.id)
}

// Drag / click on the track
function getIndexFromEvent(e: MouseEvent | PointerEvent): number {
  const track = trackEl.value
  if (!track || turnCount.value === 0) return -1
  const rect = track.getBoundingClientRect()
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
  const ratio = x / rect.width
  return Math.min(Math.floor(ratio * turnCount.value), turnCount.value - 1)
}

function onTrackPointerDown(e: PointerEvent) {
  if (turnCount.value === 0) return
  isDragging.value = true
  const idx = getIndexFromEvent(e)
  if (idx >= 0) selectTurn(idx)
  ;(e.target as HTMLElement)?.setPointerCapture?.(e.pointerId)
}

function onTrackPointerMove(e: PointerEvent) {
  const idx = getIndexFromEvent(e)
  hoverIndex.value = idx >= 0 ? idx : null

  if (isDragging.value && idx >= 0) {
    selectTurn(idx)
  }
}

function onTrackPointerUp(e: PointerEvent) {
  isDragging.value = false
  ;(e.target as HTMLElement)?.releasePointerCapture?.(e.pointerId)
}

function onTrackPointerLeave() {
  hoverIndex.value = null
}

// Keyboard navigation
function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault()
    goPrevTurn()
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault()
    goNextTurn()
  } else if (e.key === 'Home') {
    e.preventDefault()
    selectTurn(0)
  } else if (e.key === 'End') {
    e.preventDefault()
    if (turnCount.value > 0) selectTurn(turnCount.value - 1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    followLive()
  }
}

// Color for utilization
function barColor(utilization: number): string {
  if (utilization >= 0.9) return 'var(--accent-red)'
  if (utilization >= 0.7) return 'var(--accent-amber)'
  return 'var(--accent-blue)'
}
</script>

<template>
  <div
    class="scrubber"
    v-if="session && selectedEntry && turnCount >= 1"
    role="slider"
    :aria-label="`Turn scrubber: turn ${selectedTurnIndex + 1} of ${turnCount}`"
    :aria-valuemin="1"
    :aria-valuemax="turnCount"
    :aria-valuenow="selectedTurnIndex + 1"
    tabindex="0"
    @keydown="onKeyDown"
  >
    <!-- Left: transport controls -->
    <div class="scrubber-controls">
      <button
        class="ctrl-btn"
        :disabled="selectedTurnIndex <= 0"
        @click="goPrevTurn"
        title="Previous turn (←)"
        aria-label="Previous turn"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M7 1L3 5L7 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>

      <span class="turn-readout" :class="store.selectionMode === 'live' ? 'is-live' : 'is-pinned'">
        <span class="readout-dot" />
        <span class="readout-num">{{ selectedTurnIndex + 1 }}</span>
        <span class="readout-sep">/</span>
        <span class="readout-total">{{ turnCount }}</span>
      </span>

      <button
        class="ctrl-btn"
        :disabled="selectedTurnIndex < 0 || selectedTurnIndex >= turnCount - 1"
        @click="goNextTurn"
        title="Next turn (→)"
        aria-label="Next turn"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M3 1L7 5L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>

    <!-- Center: the track (sparkline with playhead) -->
    <div
      ref="trackEl"
      class="scrubber-track"
      @pointerdown="onTrackPointerDown"
      @pointermove="onTrackPointerMove"
      @pointerup="onTrackPointerUp"
      @pointerleave="onTrackPointerLeave"
    >
      <!-- Sparkline bars -->
      <div class="spark-bars">
        <div
          v-for="(d, i) in sparkData"
          :key="i"
          class="spark-col"
          :class="{
            active: i === selectedTurnIndex,
            hover: i === hoverIndex && i !== selectedTurnIndex,
            past: store.selectionMode === 'pinned' && i > selectedTurnIndex,
          }"
        >
          <div
            class="spark-bar"
            :style="{
              height: (d.height * 100) + '%',
              '--bar-color': barColor(d.utilization),
            }"
          />
          <!-- Sub-agent density dot -->
          <div
            v-if="subCallsPerTurn[i] > 0"
            class="sub-dot"
            :class="{ 'sub-burst': subCallsPerTurn[i] >= 3 }"
          />
        </div>
      </div>

      <!-- Playhead indicator -->
      <div
        v-if="selectedTurnIndex >= 0"
        class="playhead"
        :class="{ live: store.selectionMode === 'live' }"
        :style="{ left: ((selectedTurnIndex + 0.5) / turnCount * 100) + '%' }"
      >
        <div class="playhead-line" />
        <div class="playhead-head" />
      </div>

      <!-- "+N new" overlay badge centered in the dimmed future region -->
      <div
        v-if="showNewBadge"
        class="new-turns-badge"
        :style="{ left: newBadgeLeft + '%' }"
        @click.stop="followLive"
      >
        +{{ newerTurnCount }} new
      </div>

      <!-- Hover tooltip -->
      <Transition name="tooltip-fade">
        <div
          v-if="tooltipEntry && hoverIndex !== selectedTurnIndex"
          class="scrub-tooltip"
          :style="{
            left: Math.min(Math.max(((hoverIndex! + 0.5) / turnCount * 100), 8), 92) + '%',
          }"
        >
          <div class="tt-row tt-turn">T{{ tooltipEntry.turn }}</div>
          <div class="tt-row">{{ tooltipEntry.tokens }} · {{ tooltipEntry.cost }}</div>
          <div class="tt-row tt-dim">{{ tooltipEntry.model }}{{ tooltipEntry.subs > 0 ? ` · ${tooltipEntry.subs} sub` : '' }}</div>
        </div>
      </Transition>
    </div>

    <!-- Right: single toggle button (fixed width, no layout shift) -->
    <button
      v-if="store.selectionMode === 'live'"
      class="action-btn action-pin"
      @click="pinCurrentTurn"
      title="Pin current turn to scrub history"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <circle cx="5" cy="5" r="3.5" stroke="currentColor" stroke-width="1"/>
        <circle cx="5" cy="5" r="1.5" fill="currentColor"/>
      </svg>
      Pin
    </button>
    <button
      v-else
      class="action-btn action-return"
      @click="followLive"
      title="Return to live (Esc)"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M2 5H8M8 5L5.5 2.5M8 5L5.5 7.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Live
    </button>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.scrubber {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
  height: 36px;
  user-select: none;

  &:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--border-focus);
  }
}

// ── Transport controls ──
.scrubber-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.ctrl-btn {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
  padding: 0;

  &:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--bg-hover);
    border-color: var(--border-dim);
  }

  &:disabled {
    opacity: 0.25;
    cursor: default;
  }

  &:focus-visible {
    @include focus-ring;
  }
}

.turn-readout {
  display: flex;
  align-items: center;
  gap: 3px;
  @include mono-text;
  font-size: var(--text-xs);
  min-width: 42px;
  justify-content: center;
}

.readout-dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  transition: background 0.2s, box-shadow 0.2s;
}

.turn-readout.is-live .readout-dot {
  background: var(--accent-green);
  box-shadow: 0 0 5px rgba(16, 185, 129, 0.6);
  animation: live-pulse 1.35s ease-out infinite;
}

.turn-readout.is-pinned .readout-dot {
  background: var(--accent-amber);
}

.readout-num {
  color: var(--text-primary);
  font-weight: 600;
}

.readout-sep {
  color: var(--text-ghost);
}

.readout-total {
  color: var(--text-muted);
}

// ── Scrubber track ──
.scrubber-track {
  flex: 1;
  min-width: 0;
  height: 28px;
  position: relative;
  cursor: pointer;
  border-radius: var(--radius-sm);
  background: var(--bg-deep);
  border: 1px solid var(--border-dim);
  overflow: visible;
  touch-action: none;

  &:hover {
    border-color: var(--border-mid);
  }
}

.spark-bars {
  display: flex;
  align-items: flex-end;
  height: 100%;
  padding: 2px 1px;
  gap: 1px;
}

.spark-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
  min-width: 2px;
  position: relative;
}

.spark-bar {
  width: 100%;
  min-height: 2px;
  border-radius: 1px 1px 0 0;
  background: var(--bar-color, var(--accent-blue));
  opacity: 0.45;
  transition: opacity 0.1s;

  .spark-col.active & {
    opacity: 1;
  }

  .spark-col.hover & {
    opacity: 0.75;
  }

  .spark-col.past & {
    opacity: 0.15;
  }
}

.sub-dot {
  width: 3px;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--accent-purple);
  opacity: 0.5;
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);

  &.sub-burst {
    opacity: 0.85;
    width: 4px;
    height: 4px;
  }
}

// ── Playhead ──
.playhead {
  position: absolute;
  top: -1px;
  bottom: -1px;
  width: 0;
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 2;
  transition: left 0.15s ease;
}

.playhead-line {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  background: var(--text-primary);
  opacity: 0.7;
  transform: translateX(-50%);
}

.playhead-head {
  position: absolute;
  top: -3px;
  left: 50%;
  transform: translateX(-50%);
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--text-primary);
  border: 1.5px solid var(--bg-deep);
  transition: background 0.2s, box-shadow 0.2s;
}

.playhead.live .playhead-head {
  background: var(--accent-green);
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.5);
}

.playhead.live .playhead-line {
  background: var(--accent-green);
  opacity: 0.5;
}

// ── Hover tooltip ──
.scrub-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  background: var(--bg-raised);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-md);
  padding: 4px 8px;
  pointer-events: none;
  z-index: 10;
  white-space: nowrap;
  box-shadow: var(--shadow-md);
}

.tt-row {
  @include mono-text;
  font-size: 10px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.tt-turn {
  color: var(--text-primary);
  font-weight: 600;
}

.tt-dim {
  color: var(--text-muted);
}

.tooltip-fade-enter-active { transition: opacity 0.1s ease; }
.tooltip-fade-leave-active { transition: opacity 0.06s ease; }
.tooltip-fade-enter-from,
.tooltip-fade-leave-to { opacity: 0; }

// ── In-track "new turns" badge ──
.new-turns-badge {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 3;
  @include mono-text;
  font-size: 9px;
  font-weight: 600;
  color: var(--accent-amber);
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
  cursor: pointer;
  pointer-events: auto;
  transition: background 0.12s, border-color 0.12s;
  line-height: 1.4;
  white-space: nowrap;

  &:hover {
    background: rgba(245, 158, 11, 0.22);
    border-color: rgba(245, 158, 11, 0.5);
  }
}

// ── Action button (single, fixed-width toggle) ──
.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  @include mono-text;
  font-size: var(--text-xs);
  padding: 3px 7px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-dim);
  background: var(--bg-raised);
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s, color 0.12s;
  white-space: nowrap;
  flex-shrink: 0;
  min-width: 48px;

  &:hover {
    border-color: var(--border-mid);
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  &:focus-visible {
    @include focus-ring;
  }

  svg {
    flex-shrink: 0;
  }
}

.action-pin {
  color: var(--text-dim);
}

.action-return {
  color: var(--accent-green);
  border-color: rgba(16, 185, 129, 0.3);
  background: rgba(16, 185, 129, 0.08);

  &:hover {
    border-color: rgba(16, 185, 129, 0.5);
    background: rgba(16, 185, 129, 0.15);
  }
}

@keyframes live-pulse {
  0% { opacity: 1; transform: scale(1); }
  70% { opacity: 0.35; transform: scale(1.35); }
  100% { opacity: 1; transform: scale(1); }
}
</style>
