<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session'
import { fmtTokens, fmtCost, fmtPct, fmtDuration, healthColor } from '@/utils/format'
import { classifyEntries, SIMPLE_GROUPS, SIMPLE_META, groupMessagesByCategory, getCategoryLabel, getCategoryColor } from '@/utils/messages'
import { computeRecommendations } from '@/utils/recommendations'
import { calculateContextDiff, projectTurnsRemaining } from '@/utils/timeline'
import { buildHealthNarrative } from '@/utils/overview'
import { extractSessionFileAttributions, fileColor, shortFileName, fileDirectory } from '@/utils/files'
import type { ProjectedEntry } from '@/api-types'
import CompositionTreemap from './CompositionTreemap.vue'
import ContextDiffPanel from './ContextDiffPanel.vue'
import HealthFindings from './HealthFindings.vue'

const store = useSessionStore()

const entry = computed(() => store.selectedEntry)
const session = computed(() => store.selectedSession)
const chronologicalEntries = computed(() => {
  if (!session.value) return []
  return [...session.value.entries].reverse()
})

const utilization = computed(() => {
  const e = entry.value
  if (!e || !e.contextLimit) return 0
  return e.contextInfo.totalTokens / e.contextLimit
})

const utilizationColor = computed(() => {
  const u = utilization.value
  if (u >= 0.9) return 'var(--accent-red)'
  if (u >= 0.7) return 'var(--accent-amber)'
  return 'var(--accent-blue)'
})

const cacheHitRate = computed(() => {
  const e = entry.value
  if (!e?.usage) return null
  const total = e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheWriteTokens
  if (total === 0) return null
  return e.usage.cacheReadTokens / total
})

const classified = computed(() => {
  return classifyEntries(chronologicalEntries.value)
})

const projection = computed(() => {
  return projectTurnsRemaining(classified.value)
})

const turnNum = computed(() => {
  const e = entry.value
  if (!e) return 0
  const allClassified = classified.value
  const idx = allClassified.findIndex(c => c.entry.id === e.id)
  if (idx < 0) return 0
  return allClassified.slice(0, idx + 1).reduce((n, item) => n + (item.isMain ? 1 : 0), 0)
})

const recommendations = computed(() => {
  const e = entry.value
  if (!e) return []
  const entries = chronologicalEntries.value
  const cl = classified.value
  return computeRecommendations(e, entries, cl)
})

const previousMainEntry = computed((): ProjectedEntry | null => {
  const e = entry.value
  if (!e) return null
  const allClassified = classified.value
  const idx = allClassified.findIndex((item) => item.entry.id === e.id)
  if (idx < 0) return null
  for (let i = idx - 1; i >= 0; i--) {
    if (allClassified[i].isMain) return allClassified[i].entry
  }
  return null
})

const compositionDelta = computed(() => {
  const e = entry.value
  const prev = previousMainEntry.value
  if (!e || !prev) return []
  const prevMap = new Map<string, number>(prev.composition.map((item) => [item.category, item.tokens]))
  const currMap = new Map<string, number>(e.composition.map((item) => [item.category, item.tokens]))
  const allCats = new Set([...prevMap.keys(), ...currMap.keys()])

  return Array.from(allCats)
    .map((cat) => {
      const prevTokens = prevMap.get(cat) ?? 0
      const currTokens = currMap.get(cat) ?? 0
      return { category: cat, delta: currTokens - prevTokens }
    })
    .filter((item) => item.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
})

// ── Composition tape (inline bar in Context stat card) ──
const compositionTape = computed(() => {
  const e = entry.value
  if (!e?.composition?.length) return null
  const total = e.composition.reduce((s, c) => s + c.tokens, 0)
  if (total === 0) return null

  // Build reverse map: category -> group key
  const catToGroup: Record<string, string> = {}
  for (const [gk, cats] of Object.entries(SIMPLE_GROUPS)) {
    for (const cat of cats) catToGroup[cat] = gk
  }

  const grouped = new Map<string, number>()
  for (const c of e.composition) {
    const g = catToGroup[c.category] ?? c.category
    grouped.set(g, (grouped.get(g) || 0) + c.tokens)
  }
  return [...grouped.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, tokens]) => ({
      key,
      color: SIMPLE_META[key]?.color ?? '#475569',
      pct: tokens / total * 100,
    }))
})

// ── Context diff ──
const diffData = computed(() => {
  const e = entry.value
  if (!e || classified.value.length === 0) return null
  return calculateContextDiff(e, classified.value)
})

// ── Messages preview ──
const messages = computed(() => entry.value?.contextInfo.messages || [])
const categorizedMessages = computed(() => groupMessagesByCategory(messages.value))
const totalMsgTokens = computed(() => categorizedMessages.value.reduce((s, g) => s + g.tokens, 0))
const contextTotalTokens = computed(() => entry.value?.contextInfo.totalTokens ?? 0)

const healthNarrative = computed(() => {
  const e = entry.value
  if (!e) return null
  return buildHealthNarrative({
    utilization: utilization.value,
    healthScore: e.healthScore,
    composition: e.composition,
    topDelta: compositionDelta.value[0] ?? null,
  })
})

function openNarrativeTarget(target: 'messages' | 'timeline') {
  store.setInspectorTab(target)
}

function openMessagesTab() {
  store.setInspectorTab('messages')
}

function jumpToMessagesCategory(category: string, openDetail = true) {
  openMessagesTab()
  store.focusMessageCategory(category, openDetail)
}

function openAllMessages() {
  openMessagesTab()
}

function jumpToMessagesTool(toolName: string) {
  openMessagesTab()
  store.focusMessageTool('tool_results', toolName)
}

function handleRecClick(rec: { messageIndex?: number; highlight?: string }) {
  if (rec.messageIndex == null) return
  openMessagesTab()
  store.focusMessageByIndex(rec.messageIndex)
}

function auditTooltip(audit: { id: string; name: string; description: string }): string {
  const isGrowthAudit = /growth/i.test(audit.id) || /growth/i.test(audit.name)
  if (!isGrowthAudit) return audit.description

  const desc = audit.description || ''
  if (!/first turn/i.test(desc) || turnNum.value <= 1) return desc

  const curr = entry.value
  const prev = previousMainEntry.value
  if (!curr || !prev || !curr.contextLimit) return desc

  const delta = curr.contextInfo.totalTokens - prev.contextInfo.totalTokens
  const abs = Math.abs(delta)
  const pctOfLimit = (abs / curr.contextLimit) * 100
  const direction = delta >= 0 ? 'grew' : 'shrunk'
  return `Compared with previous main turn, context ${direction} by ${fmtTokens(abs)} (${pctOfLimit.toFixed(1)}% of limit).`
}

function msgCategoryLabel(cat: string): string {
  return getCategoryLabel(cat)
}

function msgCategoryDot(cat: string): string {
  return getCategoryColor(cat)
}

function categoryPct(tokens: number): number {
  return contextTotalTokens.value > 0 ? Math.round(tokens / contextTotalTokens.value * 100) : 0
}

function categoryWidth(tokens: number): string {
  return contextTotalTokens.value > 0 ? `${(tokens / contextTotalTokens.value) * 100}%` : '0%'
}

// ── File attribution ──
const fileAttributions = computed(() => {
  const s = session.value
  if (!s || s.entries.length === 0) return []
  const wd = s.workingDirectory
  return extractSessionFileAttributions(s.entries, wd)
})

const totalFileTokens = computed(() => fileAttributions.value.reduce((s, f) => s + f.tokens, 0))

function filePct(tokens: number): number {
  return totalFileTokens.value > 0 ? Math.round(tokens / totalFileTokens.value * 100) : 0
}

function fileBarWidth(tokens: number): string {
  return totalFileTokens.value > 0 ? `${(tokens / totalFileTokens.value) * 100}%` : '0%'
}

function jumpToFile(filePath: string) {
  openMessagesTab()
  store.focusMessageFile(filePath)
}

function handleTreemapFileClick(filePath: string) {
  jumpToFile(filePath)
}
</script>

<template>
  <div v-if="entry" class="overview">
    <section v-if="healthNarrative" class="health-narrative" :class="healthNarrative.toneClass">
      <div class="narrative-copy">
        <div class="narrative-title">{{ healthNarrative.headline }}</div>
        <div class="narrative-detail">{{ healthNarrative.detail }}</div>
      </div>
      <div class="narrative-actions">
        <button class="narrative-action" @click="openNarrativeTarget('messages')">
          <i class="i-carbon-chat" /> Review Messages
        </button>
        <button class="narrative-action" @click="openNarrativeTarget('timeline')">
          <i class="i-carbon-activity" /> View Timeline
        </button>
      </div>
    </section>

    <!-- ═══ Stats row ═══ -->
    <div class="stats-grid">
      <!-- Context utilization -->
      <div class="stat-card stat-card--spine" :style="{ '--spine-color': utilizationColor }">
        <div class="stat-readout" :style="{ color: utilizationColor }">
          {{ fmtPct(utilization) }}
        </div>
        <div class="stat-label">Context</div>
        <div class="stat-detail">{{ fmtTokens(entry.contextInfo.totalTokens) }} / {{ fmtTokens(entry.contextLimit) }}</div>
        <div v-if="projection.turnsRemaining !== null && projection.turnsRemaining > 0" class="stat-projection" v-tooltip="`Growing ~${fmtTokens(Math.round(projection.growthPerTurn))}/turn over ${projection.sinceCompaction} turns`">
          ~{{ projection.turnsRemaining }} turns left
        </div>
        <div v-else-if="projection.turnsRemaining === 0" class="stat-projection stat-projection--warn" v-tooltip="'Context window is at or near the limit'">
          At limit
        </div>
        <!-- Composition tape -->
        <div v-if="compositionTape" class="stat-tape">
          <div
            v-for="seg in compositionTape" :key="seg.key"
            class="stat-tape-seg"
            :style="{ flex: seg.pct, background: seg.color }"
          />
        </div>
        <!-- Fallback plain utilization bar -->
        <div v-else class="util-track">
          <div class="util-fill" :style="{ width: Math.min(utilization * 100, 100) + '%', background: utilizationColor }" />
        </div>
      </div>

      <!-- Cost -->
      <div class="stat-card">
        <div class="stat-readout green">{{ fmtCost(entry.costUsd) }}</div>
        <div class="stat-label">Turn cost</div>
        <div class="stat-detail">{{ fmtCost(session?.entries.reduce((s, e) => s + (e.costUsd ?? 0), 0) ?? 0) }} session</div>
      </div>

      <!-- Output -->
      <div class="stat-card">
        <div class="stat-readout">{{ entry.usage ? fmtTokens(entry.usage.outputTokens) : '—' }}</div>
        <div class="stat-label">Output</div>
        <div class="stat-detail" v-if="entry.timings">{{ fmtDuration(entry.timings.total_ms) }}</div>
      </div>

      <!-- Health -->
      <div class="stat-card stat-card--health" v-if="entry.healthScore">
        <div class="health-ring">
          <svg width="48" height="48" viewBox="0 0 48 48">
            <!-- Track -->
            <circle cx="24" cy="24" r="19" fill="none" stroke="var(--border-dim)" stroke-width="3"
              :stroke-dasharray="`${89.5} ${30}`" stroke-linecap="round" transform="rotate(135 24 24)" />
            <!-- Fill -->
            <circle cx="24" cy="24" r="19" fill="none" :stroke="healthColor(entry.healthScore.rating)" stroke-width="3"
              :stroke-dasharray="`${89.5 * (entry.healthScore.overall / 100)} ${119.4 - 89.5 * (entry.healthScore.overall / 100)}`"
              stroke-linecap="round" transform="rotate(135 24 24)" style="transition: stroke-dasharray 0.6s ease" />
            <!-- Score -->
            <text x="24" y="25" text-anchor="middle" dominant-baseline="central"
              :fill="healthColor(entry.healthScore.rating)" font-family="var(--font-display)" font-size="13" font-weight="700">
              {{ entry.healthScore.overall }}
            </text>
          </svg>
        </div>
        <div class="stat-label">Health</div>
      </div>
      <div class="stat-card" v-else>
        <div class="stat-readout dim">—</div>
        <div class="stat-label">Health</div>
      </div>
    </div>

    <!-- ═══ Secondary stats ═══ -->
    <div class="meta-row">
      <span>{{ entry.contextInfo.messages.length }} messages</span>
      <span v-if="cacheHitRate !== null">
        cache {{ fmtPct(cacheHitRate) }} hit
        ({{ fmtTokens(entry.usage!.cacheReadTokens) }}r / {{ fmtTokens(entry.usage!.cacheWriteTokens) }}w)
      </span>
      <span v-if="entry.stopReason">stop: {{ entry.stopReason }}</span>
      <span v-if="entry.responseModel && entry.responseModel !== entry.contextInfo.model">
        model: {{ entry.responseModel }}
      </span>
    </div>

    <!-- ═══ Composition treemap ═══ -->
    <CompositionTreemap
      :entry="entry"
      :turn-num="turnNum"
      @category-click="(cat) => jumpToMessagesCategory(cat, false)"
      @tool-click="jumpToMessagesTool"
      @file-click="handleTreemapFileClick"
    />

    <!-- ═══ Findings ═══ -->
    <HealthFindings
      :entry="entry"
      :recommendations="recommendations"
      :audit-tooltip="auditTooltip"
      @recommendation-click="handleRecClick"
    />

    <!-- ═══ Context Diff ═══ -->
    <ContextDiffPanel
      :diff-data="diffData"
      :current-entry="entry"
      :previous-entry="previousMainEntry"
      :show-tapes="true"
      :hide-unchanged="true"
      summary-mode="combined"
      delta-tone="bad"
      @category-click="(cat) => jumpToMessagesCategory(cat, false)"
    />

    <!-- ═══ Messages preview ═══ -->
    <section v-if="categorizedMessages.length" class="panel panel--secondary">
      <div class="panel-head">
        <span class="panel-title">Messages</span>
        <span class="panel-sub">{{ messages.length }} messages · {{ fmtTokens(totalMsgTokens) }}</span>
      </div>
      <div class="panel-body msg-preview">
        <div
          v-for="group in categorizedMessages" :key="group.category"
          class="msg-group-row"
          @click="jumpToMessagesCategory(group.category, false)"
        >
          <span class="msg-group-dot" :style="{ background: msgCategoryDot(group.category) }" />
          <span class="msg-group-name">{{ msgCategoryLabel(group.category) }}</span>
          <span class="msg-group-count">{{ group.items.length }}</span>
          <span class="msg-group-tokens">{{ fmtTokens(group.tokens) }}</span>
          <span class="msg-group-pct">{{ categoryPct(group.tokens) }}%</span>
          <div class="msg-group-bar">
            <div class="msg-group-bar-fill" :style="{
              width: categoryWidth(group.tokens),
              background: msgCategoryDot(group.category),
            }" />
          </div>
        </div>
        <button class="msg-view-all" @click="openAllMessages">View all messages ›</button>
      </div>
    </section>

    <!-- ═══ Files preview ═══ -->
    <section v-if="fileAttributions.length > 0" class="panel panel--secondary">
      <div class="panel-head">
        <span class="panel-title">Files</span>
        <span class="panel-sub">{{ fileAttributions.length }} files · {{ fmtTokens(totalFileTokens) }}</span>
      </div>
      <div class="panel-body file-preview">
        <div class="file-list">
          <div
            v-for="(file, idx) in fileAttributions" :key="file.path"
            class="file-row"
            @click="jumpToFile(file.path)"
          >
            <span class="file-dot" :style="{ background: fileColor(idx) }" />
            <span class="file-path" v-tooltip="file.path">
              <span class="file-dir">{{ fileDirectory(file.path) ? fileDirectory(file.path) + '/' : '' }}</span>{{ shortFileName(file.path) }}
            </span>
            <span class="file-ops">
              <span v-if="file.reads > 0" class="file-op file-op--read" v-tooltip="`${file.reads} read${file.reads > 1 ? 's' : ''}`">{{ file.reads }}r</span>
              <span v-if="file.writes > 0" class="file-op file-op--write" v-tooltip="`${file.writes} write/edit${file.writes > 1 ? 's' : ''}`">{{ file.writes }}w</span>
            </span>
            <span class="file-tokens">{{ fmtTokens(file.tokens) }}</span>
            <span class="file-pct">{{ filePct(file.tokens) }}%</span>
            <div class="file-bar">
              <div class="file-bar-fill" :style="{
                width: fileBarWidth(file.tokens),
                background: fileColor(idx),
              }" />
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.overview {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.health-narrative {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  border: 1px solid var(--border-mid);
  border-left: none;
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  padding: var(--space-2) var(--space-3);

  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: transparent;
    pointer-events: none;
  }
}

.narrative-advisory {
  border-color: rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.06);

  &::before { background: var(--accent-amber); }
}

.narrative-neutral {
  border-color: rgba(94, 159, 248, 0.35);

  &::before { background: var(--accent-blue); }
}

.narrative-copy {
  min-width: 0;
  flex: 1;
}

.narrative-title {
  font-size: var(--text-sm);
  color: var(--text-primary);
  font-weight: 600;
}

.narrative-detail {
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--text-dim);
}

.narrative-actions {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}

.narrative-action {
  font-size: var(--text-xs);
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  color: var(--text-secondary);
  padding: 4px 8px;
  border-radius: 0;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
  display: inline-flex;
  align-items: center;
  gap: 4px;

  i { font-size: 12px; }

  &:hover {
    border-color: var(--border-mid);
    color: var(--text-primary);
    background: var(--bg-hover);
  }
}

// ═══ Stats grid ═══
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-3);
}

.stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-3) var(--space-3);
  background: var(--bg-surface);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  position: relative;
}

.stat-card--spine {
  border-left: none;

  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--spine-color, var(--accent-blue));
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
    pointer-events: none;
  }
}

.stat-card--health {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.stat-readout {
  @include readout;
  font-size: var(--text-lg);
  color: var(--text-primary);
  &.green { color: var(--accent-green); }
  &.dim { color: var(--text-ghost); }
}

.stat-label {
  @include section-label;
  font-size: var(--text-xs);
  margin-top: 4px;
}

.stat-detail {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-ghost);
  margin-top: 2px;
}

.stat-projection {
  @include mono-text;
  font-size: 9px;
  color: var(--accent-amber);
  margin-top: 2px;
  cursor: help;

  &--warn {
    color: var(--accent-red);
  }
}

// ── Composition tape in Context card ──
.stat-tape {
  margin-top: 6px;
  height: 3px;
  width: 100%;
  display: flex;
  border-radius: 2px;
  overflow: hidden;
  gap: 1px;
}

.stat-tape-seg {
  height: 100%;
  min-width: 1px;
}

.util-track {
  margin-top: 6px;
  height: 2px;
  background: var(--bg-raised);
  border-radius: 2px;
  overflow: hidden;
}

.util-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.5s ease, background 0.3s;
}

.health-ring { line-height: 0; }

// ═══ Meta row ═══
.meta-row {
  font-size: var(--text-xs);
  color: var(--text-muted);
  display: flex;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding: 0 2px;
}

// ═══ Panels ═══
.panel {
  @include panel;
}

.panel--secondary {
  background: var(--bg-field);
  border-color: rgba(51, 51, 51, 0.75);
}

.panel-head {
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-dim);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.panel--secondary .panel-head {
  background: var(--bg-surface);
}

.panel-title {
  @include section-label;
}

.panel-sub {
  font-size: var(--text-xs);
  color: var(--text-dim);
}

.panel-body {
  padding: var(--space-3);
}

// ═══ Messages preview ═══
.msg-preview {
  padding: var(--space-2) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.msg-group-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.1s;

  &:hover { background: var(--bg-hover); }
}

.msg-group-dot {
  width: 6px;
  height: 6px;
  border-radius: 1px;
  flex-shrink: 0;
}

.msg-group-name {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  min-width: 120px;
}

.msg-group-count {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);
  width: 30px;
  text-align: right;
}

.msg-group-tokens {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  width: 55px;
  text-align: right;
}

.msg-group-pct {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);
  width: 32px;
  text-align: right;
}

.msg-group-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-raised);
  border-radius: 2px;
  overflow: hidden;
  min-width: 40px;
}

.msg-group-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.msg-view-all {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  background: none;
  border: none;
  padding: 6px 4px 0;
  cursor: pointer;
  transition: color 0.12s;

  &:hover { color: var(--accent-blue); }
}

// ═══ Files preview ═══
.file-preview {
  padding: var(--space-2) var(--space-4);
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  overflow-y: auto;
  @include scrollbar-thin;
}

.file-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.1s;

  &:hover { background: var(--bg-hover); }
}

.file-dot {
  width: 6px;
  height: 6px;
  border-radius: 1px;
  flex-shrink: 0;
}

.file-path {
  @include mono-text;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  min-width: 0;
  flex: 1;
  @include truncate;
  cursor: help;
}

.file-dir {
  color: var(--text-ghost);
}

.file-ops {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.file-op {
  @include mono-text;
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 2px;
  white-space: nowrap;
}

.file-op--read {
  color: var(--accent-blue);
  background: rgba(59, 130, 246, 0.12);
}

.file-op--write {
  color: var(--accent-amber);
  background: rgba(245, 158, 11, 0.12);
}

.file-tokens {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  width: 55px;
  text-align: right;
  flex-shrink: 0;
}

.file-pct {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);
  width: 32px;
  text-align: right;
  flex-shrink: 0;
}

.file-bar {
  width: 48px;
  height: 4px;
  background: var(--bg-raised);
  border-radius: 2px;
  overflow: hidden;
  flex-shrink: 0;
}

.file-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
}
</style>
