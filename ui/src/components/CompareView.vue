<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSessionStore } from '@/stores/session'
import { fmtTokens, fmtCost, fmtDuration, fmtPct, shortModel, healthColor, sourceBadgeClass } from '@/utils/format'
import { SIMPLE_GROUPS, SIMPLE_META } from '@/utils/messages'
import { cacheHitRate } from '@/utils/timeline'
import type { ProjectedEntry, CompositionEntry, ConversationGroup } from '@/api-types'

const store = useSessionStore()

const ERROR_COLOR = '#ef4444'
const STALL_COLOR = '#9ca3af'

// Cross-highlight state
const hoveredTurn = ref<number | null>(null)
const hoveredSession = ref<string | null>(null)
const focusedLane = ref<string | null>(null)

interface TurnBlock {
  turnNumber: number
  entry: ProjectedEntry
  dominantGroup: string
  color: string
  isError: boolean
  isStall: boolean
  tokens: number
  costUsd: number
  segments: { key: string; color: string; pct: number }[]
}

interface CompareSession {
  id: string
  source: string
  model: string
  directory: string
  turnCount: number
  totalCost: number
  totalDurationMs: number
  finalTokens: number
  contextLimit: number
  healthRating: string
  healthScore: number
  turns: TurnBlock[]
  tokenHistory: number[]
  costHistory: number[]
  utilization: number
  outputTokens: number
  cacheRate: number | null
  costPerOutputK: number | null
  finalComposition: { key: string; color: string; pct: number }[]
}

const legendItems = computed(() => {
  const items = Object.entries(SIMPLE_META).map(([key, meta]) => ({
    key,
    label: meta.label,
    color: meta.color,
  }))
  items.push({ key: 'error', label: 'Error', color: ERROR_COLOR })
  items.push({ key: 'stall', label: 'Stall', color: STALL_COLOR })
  return items
})

function computeSimpleGroupTotals(composition: CompositionEntry[]): Record<string, number> {
  const groupTotals: Record<string, number> = {}
  for (const [group, categories] of Object.entries(SIMPLE_GROUPS)) {
    groupTotals[group] = 0
    for (const cat of categories) {
      const entry = composition.find(c => c.category === cat)
      if (entry) groupTotals[group] += entry.tokens
    }
  }
  return groupTotals
}

function dominantSimpleGroup(composition: CompositionEntry[]): string {
  const groupTotals = computeSimpleGroupTotals(composition)
  let best = 'other'
  let bestTokens = 0
  for (const [group, tokens] of Object.entries(groupTotals)) {
    if (tokens > bestTokens) {
      best = group
      bestTokens = tokens
    }
  }
  return best
}

function computeSegments(composition: CompositionEntry[]): { key: string; color: string; pct: number }[] {
  const groupTotals = computeSimpleGroupTotals(composition)
  const total = Object.values(groupTotals).reduce((s, v) => s + v, 0)
  if (total === 0) return []
  return Object.entries(groupTotals)
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, tokens]) => ({
      key,
      color: SIMPLE_META[key]?.color ?? '#475569',
      pct: (tokens / total) * 100,
    }))
}

function findMainKey(entries: ProjectedEntry[]): string {
  const keyCounts = new Map<string, number>()
  for (const e of entries) {
    const k = e.agentKey || '_default'
    keyCounts.set(k, (keyCounts.get(k) || 0) + 1)
  }
  let mainKey = '_default'
  let maxCount = 0
  for (const [k, count] of keyCounts) {
    if (count > maxCount) {
      mainKey = k
      maxCount = count
    }
  }
  return mainKey
}

function buildTurns(convo: ConversationGroup): TurnBlock[] {
  const mainKey = findMainKey(convo.entries)

  const mainEntries = convo.entries
    .filter(e => (e.agentKey || '_default') === mainKey)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  return mainEntries.map((entry, i) => {
    const isError = (entry.httpStatus ?? 200) >= 400
    const isStall = entry.stopReason === 'max_tokens'
    const group = dominantSimpleGroup(entry.composition)

    let color: string
    if (isError) {
      color = ERROR_COLOR
    } else if (isStall) {
      color = STALL_COLOR
    } else {
      color = SIMPLE_META[group]?.color ?? SIMPLE_META.other.color
    }

    return {
      turnNumber: i + 1,
      entry,
      dominantGroup: group,
      color,
      isError,
      isStall,
      tokens: entry.contextInfo.totalTokens,
      costUsd: entry.costUsd ?? 0,
      segments: computeSegments(entry.composition),
    }
  })
}

function compactDir(path: string | null | undefined): string {
  if (!path) return ''
  let p = path
  if (/^\/home\/[^/]+(\/|$)/.test(p)) p = p.replace(/^\/home\/[^/]+/, '~')
  else if (/^\/Users\/[^/]+(\/|$)/.test(p)) p = p.replace(/^\/Users\/[^/]+/, '~')
  const parts = p.split('/')
  if (parts.length > 2) return parts.slice(-2).join('/')
  return p
}

/** Compute session-wide cache hit rate from the latest entry with usage data. */
function sessionCacheRate(turns: TurnBlock[]): number | null {
  // Use the latest turn that has usage data
  for (let i = turns.length - 1; i >= 0; i--) {
    const rate = cacheHitRate(turns[i].entry)
    if (rate !== null) return rate
  }
  return null
}

const compareSessions = computed<CompareSession[]>(() => {
  const sessions: CompareSession[] = []
  for (const id of store.compareSessionIds) {
    const convo = store.loadedConversations.get(id)
    const summary = store.summaries.find(s => s.id === id)
    if (!convo && !summary) continue

    const turns = convo ? buildTurns(convo) : []
    const totalCost = convo
      ? convo.entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0)
      : (summary?.totalCost ?? 0)
    const totalDurationMs = convo
      ? convo.entries.reduce((sum, e) => sum + (e.timings?.total_ms ?? 0), 0)
      : 0
    const latestMain = turns.length > 0 ? turns[turns.length - 1].entry : null
    const tokenHistory = turns.map(t => t.tokens)
    const costHistory = turns.map(t => t.costUsd)
    const health = convo
      ? (latestMain?.healthScore ?? summary?.healthScore)
      : summary?.healthScore
    const finalTokens = latestMain?.contextInfo.totalTokens ?? summary?.latestTotalTokens ?? 0
    const contextLimit = latestMain?.contextLimit ?? summary?.contextLimit ?? 200000
    const model = summary?.latestModel ?? latestMain?.contextInfo.model ?? ''
    const source = summary?.source ?? convo?.source ?? ''
    const wd = summary?.workingDirectory ?? convo?.workingDirectory ?? null

    const outputTokens = convo
      ? convo.entries.reduce((sum, e) => sum + (e.usage?.outputTokens ?? 0), 0)
      : 0

    const finalComposition = latestMain
      ? computeSegments(latestMain.composition)
      : []

    const cacheRate = sessionCacheRate(turns)
    const costPerOutputK = outputTokens > 0 && totalCost > 0
      ? (totalCost / outputTokens) * 1000
      : null

    sessions.push({
      id,
      source,
      model,
      directory: compactDir(wd),
      turnCount: turns.length,
      totalCost,
      totalDurationMs,
      finalTokens,
      contextLimit,
      healthRating: health?.rating ?? 'unknown',
      healthScore: health?.overall ?? 0,
      turns,
      tokenHistory,
      costHistory,
      utilization: contextLimit > 0 ? finalTokens / contextLimit : 0,
      outputTokens,
      cacheRate,
      costPerOutputK,
      finalComposition,
    })
  }
  return sessions
})

// Global max tokens across all sessions (for proportional block sizing)
const globalMaxTokens = computed(() => {
  let max = 0
  for (const s of compareSessions.value) {
    for (const t of s.turns) {
      if (t.tokens > max) max = t.tokens
    }
  }
  return max || 1
})

// Global max cost per turn (for cost dot sizing)
const globalMaxCost = computed(() => {
  let max = 0
  for (const s of compareSessions.value) {
    for (const t of s.turns) {
      if (t.costUsd > max) max = t.costUsd
    }
  }
  return max || 0.01
})

// Max context limit across sessions (for sparkline Y axis)
const sparklineMaxTokens = computed(() => {
  let max = 0
  for (const s of compareSessions.value) {
    max = Math.max(max, s.contextLimit)
    for (const t of s.tokenHistory) {
      if (t > max) max = t
    }
  }
  return max || 1
})

function blockHeight(tokens: number): string {
  const minPx = 8
  const maxPx = 32
  const ratio = tokens / globalMaxTokens.value
  const px = minPx + ratio * (maxPx - minPx)
  return Math.round(px) + 'px'
}

/** Cost dot opacity: 0.15 for cheap turns, 1.0 for the most expensive. */
function costDotOpacity(cost: number): number {
  if (cost <= 0) return 0
  const ratio = cost / globalMaxCost.value
  return 0.15 + ratio * 0.85
}

function sparklinePath(history: number[], maxVal: number): string {
  if (history.length === 0) return ''
  const w = 100
  const h = 100
  const step = history.length > 1 ? w / (history.length - 1) : 0
  return history
    .map((v, i) => {
      const x = history.length === 1 ? w / 2 : i * step
      const y = h - (v / maxVal) * h
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function sparklineAreaPath(history: number[], maxVal: number): string {
  if (history.length === 0) return ''
  const w = 100
  const h = 100
  const step = history.length > 1 ? w / (history.length - 1) : 0
  const line = history
    .map((v, i) => {
      const x = history.length === 1 ? w / 2 : i * step
      const y = h - (v / maxVal) * h
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const lastX = history.length === 1 ? w / 2 : (history.length - 1) * step
  const firstX = history.length === 1 ? w / 2 : 0
  return `${line} L${lastX.toFixed(1)},${h} L${firstX.toFixed(1)},${h} Z`
}

function sparklineLimitY(limit: number): number {
  const max = sparklineMaxTokens.value
  return 100 - (limit / max) * 100
}

// Max cost across all sessions (for the cost sparkline Y axis)
const costSparklineMax = computed(() => {
  let max = 0
  for (const s of compareSessions.value) {
    for (const c of s.costHistory) {
      if (c > max) max = c
    }
  }
  return max || 0.01
})

function turnOpacity(sessionId: string, turnNumber: number): number {
  if (hoveredTurn.value === null) return 1
  if (turnNumber === hoveredTurn.value) return 1
  if (sessionId === hoveredSession.value) return 0.3
  return 0.4
}

function turnTooltip(turn: TurnBlock): string {
  const lines = [
    `Turn ${turn.turnNumber}`,
    `Model: ${shortModel(turn.entry.contextInfo.model)}`,
    `Context: ${fmtTokens(turn.entry.contextInfo.totalTokens)}`,
    `Cost: ${fmtCost(turn.entry.costUsd)}`,
    `Dominant: ${SIMPLE_META[turn.dominantGroup]?.label ?? turn.dominantGroup}`,
  ]
  if (turn.entry.timings) {
    lines.push(`Duration: ${fmtDuration(turn.entry.timings.total_ms)}`)
  }
  if (turn.entry.stopReason) {
    lines.push(`Stop: ${turn.entry.stopReason}`)
  }
  if (turn.isError) {
    lines.push(`HTTP ${turn.entry.httpStatus}`)
  }
  return lines.join('\n')
}

function turnHref(sessionId: string, turnNumber: number): string {
  return `#session/${encodeURIComponent(sessionId)}?tab=overview&turn=${turnNumber}`
}

function sessionHref(id: string): string {
  return `#session/${encodeURIComponent(id)}?tab=overview`
}

function onTurnEnter(sessionId: string, turnNumber: number) {
  hoveredTurn.value = turnNumber
  hoveredSession.value = sessionId
}

function onTurnLeave() {
  hoveredTurn.value = null
  hoveredSession.value = null
}

function handleTurnClick(e: MouseEvent, sessionId: string, turn: TurnBlock) {
  if (e.ctrlKey || e.metaKey || e.button === 1) return
  e.preventDefault()
  store.exitCompare('inspector')
  store.selectSession(sessionId)
  store.pinEntry(turn.entry.id)
}

function inspectSession(e: MouseEvent, id: string) {
  if (e.ctrlKey || e.metaKey || e.button === 1) return
  e.preventDefault()
  store.exitCompare('inspector')
  store.setInspectorTab('overview')
  store.selectSession(id)
}

function handleBack() {
  store.exitCompare('dashboard')
}

function utilClass(u: number): string {
  if (u >= 0.8) return 'util-high'
  if (u >= 0.6) return 'util-mid'
  return 'util-low'
}

function onLaneEnter(sessionId: string) {
  focusedLane.value = sessionId
}

function onLaneLeave() {
  focusedLane.value = null
}

function fmtCostPerK(v: number): string {
  if (v >= 0.01) return '$' + v.toFixed(2) + '/K'
  return '$' + v.toFixed(3) + '/K'
}

// Best values for winner dots
const metricDeltas = computed(() => {
  const sessions = compareSessions.value
  if (sessions.length < 2) return null

  const costs = sessions.map(s => s.totalCost)
  const tokens = sessions.map(s => s.finalTokens)
  const turns = sessions.map(s => s.turnCount)
  const efficiencies = sessions.map(s => s.costPerOutputK)

  const minCost = Math.min(...costs)
  const minTokens = Math.min(...tokens)
  const minTurns = Math.min(...turns)
  const validEff = efficiencies.filter((e): e is number => e !== null)
  const bestEff = validEff.length > 0 ? Math.min(...validEff) : null

  return sessions.map(s => ({
    isCheapest: s.totalCost <= minCost,
    isLeanest: s.finalTokens <= minTokens,
    isFewest: s.turnCount <= minTurns,
    isMostEfficient: bestEff !== null && s.costPerOutputK !== null && s.costPerOutputK <= bestEff,
  }))
})
</script>

<template>
  <div class="compare-view">
    <!-- Header -->
    <header class="compare-header">
      <button class="back-btn" @click="handleBack">
        <i class="i-carbon-arrow-left" /> Dashboard
      </button>

      <h1 class="compare-title">
        Compare
        <span class="compare-count">{{ compareSessions.length }} sessions</span>
      </h1>

      <div class="legend">
        <span
          v-for="item in legendItems"
          :key="item.key"
          class="legend-chip"
        >
          <span class="legend-swatch" :style="{ background: item.color }" />
          {{ item.label }}
        </span>
      </div>
    </header>

    <!-- Session lanes -->
    <div class="lanes">
      <div
        v-for="(session, sIdx) in compareSessions"
        :key="session.id"
        class="lane"
        :class="{
          'lane--focused': focusedLane === session.id,
          'lane--dimmed': focusedLane !== null && focusedLane !== session.id,
        }"
        @mouseenter="onLaneEnter(session.id)"
        @mouseleave="onLaneLeave"
      >
        <!-- Lane header: source badge, model, directory, metrics, inspect button -->
        <div class="lane-header">
          <div class="lane-identity">
            <div class="lane-index">{{ sIdx + 1 }}</div>
            <span class="source-badge" :class="sourceBadgeClass(session.source)">{{ session.source || '?' }}</span>
            <span class="lane-model">{{ shortModel(session.model) }}</span>
            <span v-if="session.directory" class="lane-dir">{{ session.directory }}</span>
          </div>

          <div class="lane-metrics">
            <div class="lm-cell">
              <span class="lm-value">{{ session.turnCount }}</span>
              <span class="lm-key">turns</span>
              <span v-if="metricDeltas && metricDeltas[sIdx].isFewest" class="lm-winner" />
            </div>
            <div class="lm-cell">
              <span class="lm-value green">{{ fmtCost(session.totalCost) }}</span>
              <span class="lm-key">cost</span>
              <span v-if="metricDeltas && metricDeltas[sIdx].isCheapest" class="lm-winner" />
            </div>
            <div class="lm-cell">
              <span class="lm-value" :class="utilClass(session.utilization)">
                {{ Math.round(session.utilization * 100) }}%
              </span>
              <span class="lm-key">context</span>
              <span v-if="metricDeltas && metricDeltas[sIdx].isLeanest" class="lm-winner" />
            </div>
            <div class="lm-cell">
              <span
                v-if="session.healthRating !== 'unknown'"
                class="lm-value lm-health"
                :style="{ color: healthColor(session.healthRating) }"
              >{{ session.healthScore }}</span>
              <span v-else class="lm-value ghost">--</span>
              <span class="lm-key">health</span>
            </div>
            <div v-if="session.cacheRate !== null" class="lm-cell">
              <span class="lm-value dim">{{ fmtPct(session.cacheRate) }}</span>
              <span class="lm-key">cache</span>
            </div>
            <div v-if="session.costPerOutputK !== null" class="lm-cell">
              <span class="lm-value dim">{{ fmtCostPerK(session.costPerOutputK) }}</span>
              <span class="lm-key">$/out</span>
              <span v-if="metricDeltas && metricDeltas[sIdx].isMostEfficient" class="lm-winner" />
            </div>
            <div class="lm-cell">
              <span class="lm-value dim">
                {{ session.totalDurationMs > 0 ? fmtDuration(session.totalDurationMs) : '--' }}
              </span>
              <span class="lm-key">duration</span>
            </div>
          </div>

          <a
            class="inspect-btn"
            title="Open in inspector"
            :href="sessionHref(session.id)"
            @click="inspectSession($event, session.id)"
          ><i class="i-carbon-arrow-right" /></a>
        </div>

        <!-- Turn track + sparklines -->
        <div class="lane-body">
          <div class="turn-track">
            <a
              v-for="turn in session.turns"
              :key="turn.turnNumber"
              class="turn-col"
              :class="{
                'turn-col--error': turn.isError,
                'turn-col--stall': turn.isStall,
                'turn-col--crosslit': hoveredTurn === turn.turnNumber && hoveredSession !== session.id,
              }"
              :style="{ opacity: turnOpacity(session.id, turn.turnNumber) }"
              :title="turnTooltip(turn)"
              :href="turnHref(session.id, turn.turnNumber)"
              @mouseenter="onTurnEnter(session.id, turn.turnNumber)"
              @mouseleave="onTurnLeave"
              @click="handleTurnClick($event, session.id, turn)"
            >
              <div class="turn-bar" :style="{ height: blockHeight(turn.tokens) }">
                <div
                  v-for="seg in turn.segments"
                  :key="seg.key"
                  class="turn-seg"
                  :style="{ flex: seg.pct, background: seg.color }"
                />
              </div>
              <div
                class="cost-dot"
                :style="{ opacity: costDotOpacity(turn.costUsd) }"
              />
              <span class="turn-num">{{ turn.turnNumber }}</span>
            </a>

            <div v-if="session.turns.length === 0" class="turns-empty">
              Loading...
            </div>
          </div>

          <!-- Sparklines column: tokens + cost -->
          <div v-if="session.tokenHistory.length > 1" class="sparkline-col">
            <div class="sparkline-cell">
              <svg class="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none">
                <line
                  x1="0" :y1="sparklineLimitY(session.contextLimit)"
                  x2="100" :y2="sparklineLimitY(session.contextLimit)"
                  class="sparkline-limit"
                />
                <path :d="sparklineAreaPath(session.tokenHistory, sparklineMaxTokens)" class="sparkline-area" />
                <path :d="sparklinePath(session.tokenHistory, sparklineMaxTokens)" class="sparkline-line" />
              </svg>
              <span class="sparkline-val">{{ fmtTokens(session.finalTokens) }}<span class="sparkline-sep">/</span>{{ fmtTokens(session.contextLimit) }}</span>
            </div>
            <div class="sparkline-cell">
              <svg class="sparkline sparkline--cost" viewBox="0 0 100 100" preserveAspectRatio="none">
                <path :d="sparklineAreaPath(session.costHistory, costSparklineMax)" class="sparkline-area sparkline-area--cost" />
                <path :d="sparklinePath(session.costHistory, costSparklineMax)" class="sparkline-line sparkline-line--cost" />
              </svg>
              <span class="sparkline-val">{{ fmtCost(session.totalCost) }} total</span>
            </div>
          </div>
        </div>

        <!-- Composition tape -->
        <div v-if="session.finalComposition.length > 0" class="comp-row">
          <div class="comp-tape">
            <div
              v-for="seg in session.finalComposition"
              :key="seg.key"
              class="comp-seg"
              :style="{ flex: seg.pct, background: seg.color }"
              :title="`${SIMPLE_META[seg.key]?.label ?? seg.key}: ${Math.round(seg.pct)}%`"
            >
              <span v-if="seg.pct >= 18" class="comp-seg-label">{{ SIMPLE_META[seg.key]?.label ?? seg.key }}</span>
            </div>
          </div>
          <span class="comp-total">{{ fmtTokens(session.finalTokens) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.compare-view {
  padding: var(--space-4) var(--space-6);
  max-width: 1600px;
  margin: 0 auto;
  overflow-y: auto;
  height: 100%;
  @include scrollbar-thin;
}

// ── Header ──

.compare-header {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.back-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.12s, border-color 0.12s;

  &:hover {
    color: var(--text-primary);
    border-color: var(--border-mid);
  }
}

.compare-title {
  font-family: var(--font-sans);
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.compare-count {
  @include mono-text;
  font-size: var(--text-xs);
  font-weight: 400;
  color: var(--text-muted);
  margin-left: var(--space-2);
  background: var(--bg-raised);
  padding: 2px 7px;
  border-radius: var(--radius-sm);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-left: auto;
}

.legend-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--text-dim);
  letter-spacing: 0.02em;
}

.legend-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

// ── Lanes ──

.lanes {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.lane {
  background: var(--bg-field);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  transition: border-color 0.15s, opacity 0.15s;

  &--focused {
    border-color: var(--border-mid);
  }

  &--dimmed {
    opacity: 0.55;
  }
}

// ── Lane header ──

.lane-header {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: var(--space-3);
}

.lane-identity {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  flex: 1;
}

.lane-index {
  @include mono-text;
  font-size: var(--text-xs);
  font-weight: 700;
  color: var(--text-ghost);
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.source-badge {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 2px 5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  border-radius: var(--radius-sm);
  line-height: 1.4;
  flex-shrink: 0;
}

.badge-claude { background: rgba(251, 146, 60, 0.15); color: #fb923c; }
.badge-codex { background: rgba(52, 211, 153, 0.15); color: #34d399; }
.badge-aider { background: rgba(14, 165, 233, 0.15); color: var(--accent-blue); }
.badge-opencode { background: rgba(139, 92, 246, 0.15); color: #8b5cf6; }
.badge-kimi { background: rgba(167, 139, 250, 0.15); color: var(--accent-purple); }
.badge-pi { background: rgba(167, 139, 250, 0.15); color: var(--accent-purple); }
.badge-bryti { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
.badge-gemini { background: rgba(74, 144, 226, 0.15); color: #4a90e2; }
.badge-unknown { background: var(--bg-raised); color: var(--text-dim); }

.lane-model {
  @include mono-text;
  font-size: var(--text-sm);
  color: var(--text-dim);
  flex-shrink: 0;
}

.lane-dir {
  @include mono-text;
  font-size: var(--text-sm);
  color: var(--text-dim);
  @include truncate;
  min-width: 0;
}

// ── Inline metrics ──

.lane-metrics {
  display: flex;
  gap: var(--space-4);
  flex-shrink: 0;
}

.lm-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  position: relative;
  min-width: 40px;
}

.lm-value {
  @include mono-text;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.3;

  &.green { color: var(--accent-green); }
  &.dim { color: var(--text-dim); font-weight: 400; }
  &.ghost { color: var(--text-ghost); }
}

.lm-health {
  font-weight: 700;
}

.lm-key {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-ghost);
  margin-top: 1px;
}

.lm-winner {
  position: absolute;
  top: -1px;
  right: -6px;
  width: 4px;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--accent-green);
  opacity: 0.7;
}

.util-low { color: var(--accent-blue) !important; }
.util-mid { color: var(--accent-amber) !important; }
.util-high { color: var(--accent-red) !important; }

// ── Inspect button ──

.inspect-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 13px;
  flex-shrink: 0;
  transition: all 0.15s ease;

  &:hover {
    background: var(--accent-blue-dim);
    border-color: var(--accent-blue);
    color: var(--accent-blue);
    transform: translateX(2px);
    text-decoration: none;
  }
}

// ── Lane body ──

.lane-body {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}

.turn-track {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  min-height: 48px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  align-content: flex-start;
}

.turn-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  transition: opacity 0.12s, transform 0.1s;
  flex: 0 0 auto;
  text-decoration: none;
  color: inherit;

  &:hover {
    transform: translateY(-1px);
    text-decoration: none;
  }

  &--error .turn-bar {
    outline: 1.5px solid #ef4444;
    outline-offset: -1px;
  }

  &--stall .turn-bar {
    opacity: 0.6;
  }

  &--crosslit .turn-bar {
    outline: 1.5px solid rgba(255, 255, 255, 0.4);
    outline-offset: -1px;
  }
}

.turn-bar {
  width: 24px;
  min-height: 8px;
  border-radius: 2px 2px 0 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.turn-seg {
  min-height: 1px;
}

.cost-dot {
  width: 24px;
  height: 3px;
  border-radius: 1px;
  background: var(--accent-green);
}

.turn-num {
  @include mono-text;
  font-size: 8px;
  color: var(--text-ghost);
  line-height: 1;
}

.turns-empty {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-ghost);
  padding: var(--space-2);
}

// ── Sparklines ──

.sparkline-col {
  flex-shrink: 0;
  width: 180px;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  position: sticky;
  top: 0;
  align-self: flex-start;
}

.sparkline-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: flex-end;
}

.sparkline {
  width: 100%;
  height: 28px;
}

.sparkline--cost {
  height: 20px;
}

.sparkline-area {
  fill: rgba(14, 165, 233, 0.08);
}

.sparkline-area--cost {
  fill: rgba(16, 185, 129, 0.08);
}

.sparkline-line {
  fill: none;
  stroke: var(--accent-blue);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.sparkline-line--cost {
  stroke: var(--accent-green);
  stroke-width: 1;
}

.sparkline-limit {
  stroke: var(--accent-red);
  stroke-width: 1;
  stroke-dasharray: 3 2;
  vector-effect: non-scaling-stroke;
  opacity: 0.35;
}

.sparkline-val {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  white-space: nowrap;
}

.sparkline-sep {
  color: var(--text-ghost);
  margin: 0 1px;
}

// ── Composition tape ──

.comp-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid rgba(51, 51, 51, 0.5);
}

.comp-tape {
  flex: 1;
  height: 6px;
  display: flex;
  gap: 1px;
  border-radius: 2px;
  overflow: hidden;
  background: var(--bg-deep);
}

.comp-seg {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  transition: filter 0.12s;

  &:hover { filter: brightness(1.25); }
}

.comp-seg-label {
  @include mono-text;
  font-size: 8px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  @include truncate;
  padding: 0 3px;
}

.comp-total {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);
  flex-shrink: 0;
  width: 50px;
  text-align: right;
}

// ── Reduced motion ──

@media (prefers-reduced-motion: reduce) {
  .turn-col,
  .lane,
  .comp-seg,
  .inspect-btn { transition: none; }
}
</style>
