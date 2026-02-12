<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useExpandable } from '@/composables/useExpandable'
import { fmtTokens, fmtCost, fmtPct, fmtDuration, healthColor, shortModel, modelColorClass } from '@/utils/format'
import { classifyEntries, extractCallSummary, CATEGORY_META } from '@/utils/messages'
import { computeRecommendations } from '@/utils/recommendations'
import type { ProjectedEntry } from '@/api-types'
import CompositionTreemap from './CompositionTreemap.vue'
import HealthFindings from './HealthFindings.vue'

const store = useSessionStore()
const { isExpanded, toggle } = useExpandable()

const entry = computed(() => store.selectedEntry)
const session = computed(() => store.selectedSession)

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
  if (!session.value) return []
  return classifyEntries([...session.value.entries].reverse())
})

const turnGroup = computed(() => {
  const e = entry.value
  if (!e || !session.value) return []
  const allClassified = classified.value
  const idx = allClassified.findIndex(c => c.entry.id === e.id)
  if (idx < 0) return [{ entry: e, isMain: true }]

  let mainIdx = idx
  for (let i = idx; i >= 0; i--) {
    if (allClassified[i].isMain) { mainIdx = i; break }
  }
  const group: typeof allClassified = []
  for (let j = mainIdx; j < allClassified.length; j++) {
    if (j > mainIdx && allClassified[j].isMain) break
    group.push(allClassified[j])
  }
  return group
})

const turnNum = computed(() => {
  const e = entry.value
  if (!e) return 0
  const allClassified = classified.value
  const idx = allClassified.findIndex(c => c.entry.id === e.id)
  let num = 0
  for (let k = 0; k <= Math.max(0, idx); k++) {
    if (allClassified[k]?.isMain) num++
  }
  return num
})

const agentBreakdown = computed(() => {
  const cl = turnGroup.value
  if (cl.length === 0) return { main: [] as any[], subGroups: [] as any[], totalTok: 0, subPct: 0, subTokPct: 0 }

  const agents = new Map<string, {
    key: string; label: string; model: string; latestTokens: number
    cost: number; count: number; isMain: boolean
  }>()

  for (const item of cl) {
    const ak = item.entry.agentKey || '_main'
    if (!agents.has(ak)) {
      agents.set(ak, {
        key: ak, label: item.entry.agentLabel || 'Main',
        model: item.entry.contextInfo.model, latestTokens: 0,
        cost: 0, count: 0, isMain: item.isMain,
      })
    }
    const ag = agents.get(ak)!
    ag.latestTokens = item.entry.contextInfo.totalTokens
    ag.cost += item.entry.costUsd || 0
    ag.count += 1
  }

  const mainAgents = [...agents.values()].filter(a => a.isMain)
  const subAgents = [...agents.values()].filter(a => !a.isMain)

  const subByModel = new Map<string, {
    model: string; shortModel: string; totalTokens: number
    totalCost: number; count: number; agents: typeof mainAgents
  }>()
  for (const ag of subAgents) {
    const sm = shortModel(ag.model)
    if (!subByModel.has(sm)) {
      subByModel.set(sm, { model: ag.model, shortModel: sm, totalTokens: 0, totalCost: 0, count: 0, agents: [] })
    }
    const g = subByModel.get(sm)!
    g.totalTokens += ag.latestTokens
    g.totalCost += ag.cost
    g.count += ag.count
    g.agents.push(ag)
  }

  let totalTok = 0
  for (const a of mainAgents) totalTok += a.latestTokens
  for (const g of subByModel.values()) totalTok += g.totalTokens

  const subCount = cl.filter(x => !x.isMain).length
  const subPct = cl.length > 0 ? Math.round(subCount / cl.length * 100) : 0
  const subTok = subAgents.reduce((s, a) => s + a.latestTokens, 0)
  const subTokPct = totalTok > 0 ? Math.round(subTok / totalTok * 100) : 0

  return {
    main: mainAgents,
    subGroups: [...subByModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    totalTok,
    subPct,
    subTokPct,
  }
})


const recommendations = computed(() => {
  const e = entry.value
  if (!e || !session.value) return []
  const entries = [...session.value.entries].reverse()
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
  const prevMap = new Map(prev.composition.map((item) => [item.category, item.tokens]))
  const currMap = new Map(e.composition.map((item) => [item.category, item.tokens]))
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

const healthNarrative = computed(() => {
  const e = entry.value
  if (!e) return null

  const utilPct = Math.round(utilization.value * 100)
  const health = e.healthScore
  const topComp = [...e.composition].sort((a, b) => b.tokens - a.tokens)[0]
  const topDelta = compositionDelta.value[0]

  let toneClass = 'narrative-neutral'
  let headline = `Context is at ${utilPct}% utilization.`
  if (health?.rating === 'poor' || utilPct >= 85) {
    toneClass = 'narrative-advisory'
    headline = `Turn health is elevated risk (${health ? health.overall + '/100' : utilPct + '% utilization'}).`
  } else if (health?.rating === 'needs-work' || utilPct >= 65) {
    toneClass = 'narrative-advisory'
    headline = `Turn health shows moderate pressure (${health ? health.overall + '/100' : utilPct + '% utilization'}).`
  } else if (health) {
    headline = `Turn health is stable at ${health.overall}/100.`
  }

  const likelyDrivers: string[] = []
  if (topComp) likelyDrivers.push(`${CATEGORY_META[topComp.category]?.label ?? topComp.category} is the largest share (${Math.round(topComp.pct)}%).`)
  if (topDelta) {
    const label = CATEGORY_META[topDelta.category]?.label ?? topDelta.category
    const direction = topDelta.delta > 0 ? 'grew' : 'shrank'
    likelyDrivers.push(`${label} ${direction} most vs previous main turn (${fmtTokens(Math.abs(topDelta.delta))}).`)
  }

  return {
    toneClass,
    headline,
    detail: likelyDrivers.join(' '),
  }
})

function openNarrativeTarget(target: 'messages' | 'timeline') {
  store.setInspectorTab(target)
}

function jumpToMessagesCategory(category: string) {
  store.setInspectorTab('messages')
  store.focusMessageCategory(category)
}

function jumpToMessagesTool(toolName: string) {
  store.setInspectorTab('messages')
  store.focusMessageTool('tool_results', toolName)
}

function handleRecClick(rec: { messageIndex?: number; highlight?: string }) {
  if (rec.messageIndex == null) return
  store.setInspectorTab('messages')
  store.focusMessageByIndex(rec.messageIndex, rec.highlight)
}

function modelBarColor(model: string): string {
  if (/opus/i.test(model)) return '#fb923c'
  if (/sonnet/i.test(model)) return 'var(--accent-blue)'
  if (/haiku/i.test(model)) return '#a78bfa'
  if (/gpt/i.test(model)) return '#10b981'
  return '#94a3b8'
}

function barPct(tokens: number): number {
  return agentBreakdown.value.totalTok > 0
    ? Math.round(tokens / agentBreakdown.value.totalTok * 100)
    : 0
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
</script>

<template>
  <div v-if="entry" class="overview">
    <section v-if="healthNarrative" class="health-narrative" :class="healthNarrative.toneClass">
      <div class="narrative-copy">
        <div class="narrative-title">{{ healthNarrative.headline }}</div>
        <div class="narrative-detail">{{ healthNarrative.detail }}</div>
      </div>
      <div class="narrative-actions">
        <button class="narrative-action" @click="openNarrativeTarget('messages')">Review Messages</button>
        <button class="narrative-action" @click="openNarrativeTarget('timeline')">View Timeline Diff</button>
      </div>
    </section>

    <!-- ═══ Stats row ═══ -->
    <div class="stats-grid">
      <!-- Context utilization -->
      <div class="stat-card">
        <div class="stat-readout" :style="{ color: utilizationColor }">
          {{ fmtPct(utilization) }}
        </div>
        <div class="stat-label">Context</div>
        <div class="stat-detail">{{ fmtTokens(entry.contextInfo.totalTokens) }} / {{ fmtTokens(entry.contextLimit) }}</div>
        <!-- Utilization bar -->
        <div class="util-track">
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
      @category-click="jumpToMessagesCategory"
      @tool-click="jumpToMessagesTool"
    />

    <!-- ═══ Agent breakdown ═══ -->
    <section class="panel" v-if="classified.length > 1">
      <div class="panel-head">
        <span class="panel-title">Agents</span>
      </div>
      <div class="panel-body agent-list">
        <div v-for="ag in agentBreakdown.main" :key="ag.key" class="agent-row">
          <span class="agent-name">Main <span class="agent-model">{{ shortModel(ag.model) }}</span></span>
          <div class="bar-track"><div class="bar-fill" :style="{ width: barPct(ag.latestTokens) + '%', background: modelBarColor(ag.model) }" /></div>
          <span class="agent-stat">{{ fmtTokens(ag.latestTokens) }} · {{ fmtCost(ag.cost) }}</span>
        </div>
        <template v-for="g in agentBreakdown.subGroups" :key="g.shortModel">
          <div class="agent-row clickable" @click="toggle('agent-' + g.shortModel)">
            <span class="agent-name">
              <span class="expand-arrow">{{ isExpanded('agent-' + g.shortModel) ? '▾' : '▸' }}</span>
              Sub <span class="agent-model">{{ g.shortModel }}</span>
              <span class="agent-count">×{{ g.count }}</span>
            </span>
            <div class="bar-track"><div class="bar-fill" :style="{ width: barPct(g.totalTokens) + '%', background: modelBarColor(g.model) }" /></div>
            <span class="agent-stat">{{ fmtTokens(g.totalTokens) }} · {{ fmtCost(g.totalCost) }}</span>
          </div>
          <template v-if="isExpanded('agent-' + g.shortModel)">
            <div v-for="sub in g.agents" :key="sub.key" class="agent-row sub-row">
              <span class="agent-name sub-name">{{ sub.label || sub.key }} <span class="agent-count">×{{ sub.count }}</span></span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: barPct(sub.latestTokens) + '%', background: modelBarColor(sub.model), opacity: 0.5 }" /></div>
              <span class="agent-stat sub-stat">{{ fmtTokens(sub.latestTokens) }} · {{ fmtCost(sub.cost) }}</span>
            </div>
          </template>
        </template>
        <div v-if="agentBreakdown.subPct > 0" class="agent-footer">
          {{ agentBreakdown.subPct }}% calls subagent · {{ agentBreakdown.subTokPct }}% tokens
        </div>
      </div>
    </section>

    <!-- ═══ Turn detail ═══ -->
    <section class="panel" v-if="turnGroup.length > 0">
      <div class="panel-head">
        <span class="panel-title">Turn {{ turnNum }}</span>
        <span class="panel-sub">
          {{ turnGroup.length }} call{{ turnGroup.length !== 1 ? 's' : '' }}
          · {{ fmtTokens(turnGroup.reduce((s, x) => s + x.entry.contextInfo.totalTokens, 0)) }}
          · {{ fmtCost(turnGroup.reduce((s, x) => s + (x.entry.costUsd || 0), 0)) }}
        </span>
      </div>
      <div class="panel-body call-list">
        <div v-for="item in turnGroup" :key="item.entry.id" class="call-item">
          <div
            class="call-row"
            :class="{ 'call-main': item.isMain, 'expanded': isExpanded(String(item.entry.id)) }"
            @click="toggle(String(item.entry.id))"
          >
            <span class="call-badge" :class="modelColorClass(item.entry.contextInfo.model)">
              {{ shortModel(item.entry.contextInfo.model) }}
            </span>
            <span class="call-desc" :class="{ main: item.isMain }">
              {{ extractCallSummary(item.entry) || item.entry.agentLabel || (item.isMain ? 'Main' : 'Sub') }}
            </span>
            <span class="call-tok">{{ fmtTokens(item.entry.contextInfo.totalTokens) }}</span>
            <span class="call-cost">{{ fmtCost(item.entry.costUsd) }}</span>
          </div>
          <Transition name="call-expand">
            <div v-if="isExpanded(String(item.entry.id))" class="call-detail">
              <div class="detail-section">
                <span class="detail-label">Messages</span>
                <span class="detail-value">{{ item.entry.contextInfo.messages?.length || 0 }}</span>
              </div>
              <div class="detail-section" v-if="item.entry.usage">
                <span class="detail-label">Input</span>
                <span class="detail-value">{{ fmtTokens(item.entry.usage.inputTokens) }} ({{ item.entry.usage.cacheReadTokens ? fmtTokens(item.entry.usage.cacheReadTokens) + ' cached' : 'no cache' }})</span>
              </div>
              <div class="detail-section" v-if="item.entry.usage">
                <span class="detail-label">Output</span>
                <span class="detail-value">{{ fmtTokens(item.entry.usage.outputTokens) }}</span>
              </div>
              <div class="detail-section" v-if="item.entry.timings">
                <span class="detail-label">Duration</span>
                <span class="detail-value">{{ fmtDuration(item.entry.timings.total_ms) }}</span>
              </div>
              <div class="detail-section" v-if="item.entry.stopReason">
                <span class="detail-label">Stop reason</span>
                <span class="detail-value">{{ item.entry.stopReason }}</span>
              </div>
            </div>
          </Transition>
        </div>
      </div>
    </section>

    <!-- ═══ Findings ═══ -->
    <HealthFindings
      :entry="entry"
      :recommendations="recommendations"
      :audit-tooltip="auditTooltip"
      @recommendation-click="handleRecClick"
    />
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.overview {
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.health-narrative {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  padding: var(--space-3) var(--space-4);
}

.narrative-advisory {
  border-color: rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.06);
}

.narrative-neutral {
  border-color: rgba(94, 159, 248, 0.35);
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
  padding: var(--space-4);
  background: var(--bg-surface);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
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

.panel-head {
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-dim);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.panel-title {
  @include section-label;
}

.panel-sub {
  font-size: var(--text-xs);
  color: var(--text-dim);
}

.panel-body {
  padding: var(--space-4);
}

// ═══ Agent breakdown ═══
.agent-list {
  padding: var(--space-3) var(--space-4);
  max-height: 280px;
  overflow-y: auto;
  @include scrollbar-thin;
}

.agent-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 0;
  font-size: var(--text-sm);

  &.clickable { cursor: pointer; }
  &.sub-row { padding-left: var(--space-5); }
}

.agent-name {
  width: 130px;
  color: var(--text-secondary);
  @include truncate;
  flex-shrink: 0;
}

.sub-name { color: var(--text-dim); font-size: var(--text-xs); }
.agent-model { @include mono-text; color: var(--text-muted); }
.agent-count { @include mono-text; font-size: var(--text-xs); color: var(--text-ghost); }
.expand-arrow { color: var(--text-muted); margin-right: 2px; font-size: var(--text-xs); }

.bar-track {
  flex: 1;
  height: 5px;
  background: var(--bg-raised);
  border-radius: 3px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}

.agent-stat {
  @include mono-text;
  width: 110px;
  text-align: right;
  color: var(--text-dim);
  font-size: var(--text-xs);
  white-space: nowrap;
  flex-shrink: 0;
}

.sub-stat { font-size: var(--text-xs); }

.agent-footer {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-ghost);
}

// ═══ Call rows ═══
.call-list { padding: var(--space-2) var(--space-3); }

.call-item + .call-item {
  margin-top: 4px;
}

.call-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px 6px;
  border-radius: 0;
  font-size: var(--text-sm);
  transition: background 0.1s;
  cursor: pointer;

  &:hover { background: var(--bg-hover); }
  &.call-main {
    background: rgba(91, 156, 245, 0.16);
    border: 1px solid rgba(91, 156, 245, 0.25);
  }
  &.expanded { 
    background: var(--bg-surface); 
    border-bottom: 1px solid var(--border-dim);
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  }
}

.call-detail {
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  border-top: none;
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  margin: 0 6px 0 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.call-expand-enter-active,
.call-expand-leave-active {
  transition: max-height 0.2s ease, opacity 0.16s ease;
  overflow: hidden;
}

.call-expand-enter-from,
.call-expand-leave-to {
  max-height: 0;
  opacity: 0;
}

.call-expand-enter-to,
.call-expand-leave-from {
  max-height: 220px;
  opacity: 1;
}

.detail-section {
  display: flex;
  justify-content: space-between;
  font-size: var(--text-xs);
}

.detail-label {
  color: var(--text-dim);
}

.detail-value {
  @include mono-text;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.call-badge {
  @include mono-text;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 2px;
  background: var(--bg-raised);
  min-width: 52px;
  width: auto;
  text-align: center;
  flex-shrink: 0;
  color: var(--text-primary);
  white-space: nowrap;
}

.call-desc {
  @include truncate;
  @include sans-text;
  color: var(--text-secondary);
  flex: 1;
  font-size: var(--text-sm);

  &.main { color: var(--text-primary); }
}

.call-tok {
  @include mono-text;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  width: 60px;
  text-align: right;
  flex-shrink: 0;
}

.call-cost {
  @include mono-text;
  color: var(--accent-green);
  font-size: var(--text-xs);
  width: 50px;
  text-align: right;
  flex-shrink: 0;
}

// Model colors
.model-opus { color: #fb923c; }
.model-sonnet { color: var(--accent-blue); }
.model-haiku { color: #a78bfa; }
.model-gpt { color: #10b981; }
.model-gemini { color: var(--accent-cyan); }
.model-default { color: var(--text-dim); }

</style>
