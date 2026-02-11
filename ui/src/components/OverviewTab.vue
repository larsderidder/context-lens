<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { hierarchy, treemap as d3Treemap } from 'd3-hierarchy'
import { useSessionStore } from '@/stores/session'
import { useExpandable } from '@/composables/useExpandable'
import { fmtTokens, fmtCost, fmtPct, fmtDuration, healthColor, shortModel, modelColorClass } from '@/utils/format'
import { classifyEntries, classifyMessageRole, extractCallSummary, CATEGORY_META, SIMPLE_GROUPS, SIMPLE_META, buildToolNameMap } from '@/utils/messages'
import { computeRecommendations } from '@/utils/recommendations'
import type { ProjectedEntry } from '@/api-types'

const store = useSessionStore()
const { isExpanded, toggle } = useExpandable()

const entry = computed(() => store.selectedEntry)
const session = computed(() => store.selectedSession)
const treemapMode = ref<'detailed' | 'simple'>('detailed')
const treemapDrillKey = ref<string | null>(null)

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
  const total = e.usage.inputTokens
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

const simpleComposition = computed((): { key: string; label: string; color: string; tokens: number }[] => {
  const comp = entry.value?.composition || []
  const result: { key: string; label: string; color: string; tokens: number }[] = []
  for (const [gk, cats] of Object.entries(SIMPLE_GROUPS)) {
    let tokens = 0
    for (const cat of cats) {
      const found = comp.find(c => c.category === cat)
      if (found) tokens += found.tokens
    }
    if (tokens > 0) {
      const meta = SIMPLE_META[gk]
      result.push({ key: gk, label: meta.label, color: meta.color, tokens })
    }
  }
  return result
})

interface TreemapNode {
  key: string
  label: string
  color: string
  tokens: number
  category?: string
  toolName?: string
}

interface TreemapLayoutNode extends TreemapNode {
  x: number
  y: number
  w: number
  h: number
  pct: number
}

interface TreemapHierarchyDatum extends TreemapNode {
  children?: TreemapHierarchyDatum[]
}

const topLevelTreemapNodes = computed((): TreemapNode[] => {
  const e = entry.value
  if (!e) return []
  return e.composition
    .filter((item) => item.tokens > 0)
    .map((item) => ({
      key: item.category,
      label: CATEGORY_META[item.category]?.label ?? item.category,
      color: CATEGORY_META[item.category]?.color ?? '#4b5563',
      tokens: item.tokens,
      category: item.category,
    }))
})

function toolResultColor(index: number): string {
  const palette = ['#10b981', '#34d399', '#14b8a6', '#2dd4bf', '#059669', '#06b6d4', '#0ea5e9']
  return palette[index % palette.length]
}

const toolResultTreemapNodes = computed((): TreemapNode[] => {
  const e = entry.value
  if (!e) return []
  const msgs = e.contextInfo.messages || []
  const toolNameMap = buildToolNameMap(msgs)
  const toolTokens = new Map<string, number>()

  for (const msg of msgs) {
    if (classifyMessageRole(msg) !== 'tool_results') continue
    const blocks = (msg.contentBlocks || []).filter((block) => block.type === 'tool_result')
    if (blocks.length === 0) continue
    const split = (msg.tokens || 0) / blocks.length
    for (const block of blocks) {
      const toolId = block.tool_use_id || 'unknown'
      const toolName = toolNameMap[toolId] || `tool:${toolId.slice(0, 8)}`
      toolTokens.set(toolName, (toolTokens.get(toolName) || 0) + split)
    }
  }

  return Array.from(toolTokens.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([tool, tokens], index) => ({
      key: `tool-${tool}-${index}`,
      label: tool,
      color: toolResultColor(index),
      tokens: Math.max(1, Math.round(tokens)),
      category: 'tool_results',
      toolName: tool,
    }))
})

const activeDetailedTreemapNodes = computed((): TreemapNode[] => {
  if (treemapDrillKey.value === 'tool_results' && toolResultTreemapNodes.value.length > 0) {
    return toolResultTreemapNodes.value
  }
  return topLevelTreemapNodes.value
})

const detailedLegendNodes = computed(() => activeDetailedTreemapNodes.value.slice(0, 8))

function buildTreemapLayout(nodes: TreemapNode[]): TreemapLayoutNode[] {
  if (nodes.length === 0) return []
  const total = nodes.reduce((sum, node) => sum + node.tokens, 0)
  const root = hierarchy<TreemapHierarchyDatum>({
    key: 'root',
    label: 'root',
    color: '#000000',
    tokens: 0,
    children: nodes,
  }).sum((node) => (node.children && node.children.length > 0 ? 0 : Math.max(0, node.tokens || 0)))

  const laidOut = d3Treemap<TreemapHierarchyDatum>()
    .size([100, 100])
    .paddingInner(1)
    .round(true)(root)

  return laidOut.leaves().map((leaf) => {
    const node = leaf.data
    return {
      key: node.key,
      label: node.label,
      color: node.color,
      tokens: node.tokens,
      category: node.category,
      x: leaf.x0,
      y: leaf.y0,
      w: leaf.x1 - leaf.x0,
      h: leaf.y1 - leaf.y0,
      pct: total > 0 ? (node.tokens / total) * 100 : 0,
    }
  })
}

const detailedTreemapLayout = computed(() => buildTreemapLayout(activeDetailedTreemapNodes.value))

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

function handleDetailedTreemapItemClick(item: TreemapLayoutNode) {
  if (treemapDrillKey.value === null && item.category === 'tool_results' && toolResultTreemapNodes.value.length > 1) {
    treemapDrillKey.value = 'tool_results'
    return
  }
  if (treemapDrillKey.value === 'tool_results' && item.toolName) {
    jumpToMessagesTool(item.toolName)
    return
  }
  jumpToMessagesCategory(item.category || 'tool_results')
}

function onSimpleTreemapClick(groupKey: string) {
  const e = entry.value
  if (!e) return
  const cats = SIMPLE_GROUPS[groupKey] || []
  if (cats.length === 0) return

  let target = cats[0]
  let maxTokens = -1
  for (const cat of cats) {
    const found = e.composition.find((item) => item.category === cat)
    const tok = found?.tokens ?? 0
    if (tok > maxTokens) {
      maxTokens = tok
      target = cat
    }
  }
  jumpToMessagesCategory(target)
}

function resetTreemapDrill() {
  treemapDrillKey.value = null
}

watch(
  () => entry.value?.id,
  () => {
    treemapDrillKey.value = null
  },
)

function modelBarColor(model: string): string {
  if (/opus/i.test(model)) return '#fb923c'
  if (/sonnet/i.test(model)) return '#60a5fa'
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
    <section class="panel" v-if="entry.composition.length > 0">
      <div class="panel-head">
        <span class="panel-title">Composition</span>
        <span class="panel-sub">Turn {{ turnNum }} · {{ fmtTokens(entry.composition.reduce((s, c) => s + c.tokens, 0)) }}</span>
        <button
          v-if="treemapMode === 'detailed' && treemapDrillKey"
          class="treemap-back"
          @click="resetTreemapDrill"
        >
          Back to categories
        </button>
        <div class="mode-toggle">
          <button :class="{ on: treemapMode === 'detailed' }" @click="treemapMode = 'detailed'">Detail</button>
          <button :class="{ on: treemapMode === 'simple' }" @click="treemapMode = 'simple'">Simple</button>
        </div>
      </div>
      <div class="panel-body">
        <!-- Detailed -->
        <div v-if="treemapMode === 'detailed'" class="treemap">
          <button
            v-for="item in detailedTreemapLayout"
            :key="item.key"
            class="tm-block tm-block-2d"
            :style="{
              left: item.x + '%',
              top: item.y + '%',
              width: item.w + '%',
              height: item.h + '%',
              background: item.color,
            }"
            v-tooltip="`${item.label}: ${item.tokens.toLocaleString()} (${item.pct.toFixed(1)}%)`"
            @click="handleDetailedTreemapItemClick(item)"
          >
            <template v-if="item.w >= 14 && item.h >= 12">
              <span class="tm-label">{{ item.label }}</span>
              <span class="tm-val">{{ fmtTokens(item.tokens) }}</span>
            </template>
          </button>
        </div>
        <!-- Simple -->
        <div v-else class="treemap">
          <div
            v-for="g in simpleComposition" :key="g.key"
            class="tm-block" :style="{ flex: g.tokens, background: g.color }"
            v-tooltip="`${g.label}: ${g.tokens.toLocaleString()}`"
            @click="onSimpleTreemapClick(g.key)"
          >
            <span class="tm-label">{{ g.label }}</span>
            <span class="tm-val">{{ fmtTokens(g.tokens) }}</span>
          </div>
        </div>
        <!-- Legend -->
        <div class="legend">
          <template v-if="treemapMode === 'detailed'">
            <span v-for="item in detailedLegendNodes" :key="`legend-${item.key}`" class="legend-item">
              <span class="legend-dot" :style="{ background: item.color }" />
              {{ item.label }}
            </span>
            <span
              v-if="activeDetailedTreemapNodes.length > detailedLegendNodes.length"
              class="legend-item"
            >
              +{{ activeDetailedTreemapNodes.length - detailedLegendNodes.length }} more
            </span>
          </template>
          <template v-else>
            <span v-for="g in simpleComposition" :key="g.key" class="legend-item">
              <span class="legend-dot" :style="{ background: g.color }" />
              {{ g.label }}
            </span>
          </template>
        </div>
      </div>
    </section>

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
    <section class="panel" v-if="entry.healthScore || recommendations.length > 0">
      <div class="panel-head">
        <span class="panel-title">Findings</span>
        <span class="finding-count" v-if="recommendations.length">{{ recommendations.length }}</span>
        <span v-if="entry.healthScore" class="health-score-inline" :style="{ color: healthColor(entry.healthScore.rating) }">
          {{ entry.healthScore.overall }}/100
        </span>
      </div>
      <!-- Audit chips -->
      <div v-if="entry.healthScore" class="audit-row">
        <span v-for="audit in entry.healthScore.audits" :key="audit.id" class="audit-chip"
          :class="audit.score >= 90 ? 'audit-good' : audit.score >= 50 ? 'audit-warn' : 'audit-bad'"
          v-tooltip="auditTooltip(audit)">
          {{ audit.name }} <b>{{ audit.score }}</b>
        </span>
      </div>
      <!-- Recommendations -->
      <div v-if="recommendations.length > 0" class="panel-body rec-list">
        <div v-for="(r, i) in recommendations" :key="i" class="rec">
          <span class="rec-dot" :class="`sev-${r.severity}`" />
          <div class="rec-content">
            <div class="rec-title">{{ r.title }}</div>
            <div class="rec-detail">{{ r.detail }}</div>
          </div>
          <span class="rec-impact" :class="`sev-${r.severity}`">{{ r.impact }}</span>
        </div>
      </div>
    </section>
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
  border-radius: var(--radius-sm);
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
  text-align: center;
  padding: var(--space-3) var(--space-2);
  background: var(--bg-surface);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-md);
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
  height: 3px;
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

// ═══ Mode toggle ═══
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

.treemap-back {
  font-size: var(--text-xs);
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  color: var(--text-secondary);
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;

  &:hover {
    border-color: var(--border-mid);
    color: var(--text-primary);
    background: var(--bg-hover);
  }
}

// ═══ Treemap ═══
.treemap {
  height: 78px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  position: relative;
  background: var(--bg-raised);
}

.treemap:not(.treemap-2d) {
  display: flex;
  gap: 1px;
}

.tm-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: filter 0.15s;
  min-width: 0;

  &:hover { filter: brightness(1.25); }
}

.tm-block-2d {
  position: absolute;
  border: none;
  padding: 2px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.tm-label {
  @include mono-text;
  font-size: var(--text-xs);
  font-weight: 500;
  color: rgba(255, 255, 255, 0.88);
  @include truncate;
  max-width: 100%;
  padding: 0 4px;
}

.tm-val {
  @include mono-text;
  font-size: var(--text-xs);
  color: rgba(255, 255, 255, 0.5);
}

// Category colors
.cat-system_prompt { background: #2563eb; }
.cat-tool_definitions { background: #db2777; }
.cat-tool_results { background: #059669; }
.cat-system_injections { background: #6366f1; }
.cat-thinking { background: #8b5cf6; }
.cat-assistant_text { background: #d97706; }
.cat-user_text { background: #10b981; }
.cat-tool_calls { background: #ec4899; }
.cat-images { background: #4b5563; }
.cat-cache_markers { background: #6b7280; }
.cat-other { background: #4b5563; }

.legend {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-2);
  flex-wrap: wrap;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--text-dim);
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
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
  border-radius: var(--radius-sm);
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
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 2px;
  background: var(--bg-raised);
  min-width: 58px;
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
.model-sonnet { color: #60a5fa; }
.model-haiku { color: #a78bfa; }
.model-gpt { color: #10b981; }
.model-gemini { color: #22d3ee; }
.model-default { color: var(--text-dim); }

// ═══ Findings ═══
.finding-count {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 1px 5px;
  border-radius: var(--radius-full);
  background: var(--accent-blue-dim);
  color: var(--accent-blue);
}

.health-score-inline {
  margin-left: auto;
  @include mono-text;
  font-size: var(--text-sm);
  font-weight: 700;
}

.audit-row {
  padding: var(--space-2) var(--space-4);
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border-dim);
}

.audit-chip {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 2px 7px;
  border-radius: var(--radius-full);
  cursor: default;

  b { font-weight: 700; margin-left: 2px; }

  &.audit-good { background: rgba(16, 185, 129, 0.08); color: #6ee7b7; b { color: #10b981; } }
  &.audit-warn { background: rgba(245, 158, 11, 0.08); color: #fbbf24; b { color: #f59e0b; } }
  &.audit-bad { background: rgba(239, 68, 68, 0.08); color: #fca5a5; b { color: #ef4444; } }
}

.rec-list { padding: var(--space-3) var(--space-4); }

.rec {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-dim);

  &:last-child { border-bottom: none; padding-bottom: 0; }
  &:first-child { padding-top: 0; }
}

.rec-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  margin-top: 5px;
  flex-shrink: 0;

  &.sev-high { background: var(--accent-red); box-shadow: 0 0 4px var(--accent-red); }
  &.sev-med { background: var(--accent-amber); box-shadow: 0 0 4px var(--accent-amber); }
  &.sev-low { background: var(--accent-green); }
}

.rec-content { flex: 1; min-width: 0; }

.rec-title {
  @include sans-text;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-secondary);
}

.rec-detail {
  @include sans-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  margin-top: 3px;
  line-height: 1.5;
}

.rec-impact {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  white-space: nowrap;
  flex-shrink: 0;
  margin-top: 2px;

  &.sev-high { background: var(--accent-red-dim); color: var(--accent-red); }
  &.sev-med { background: var(--accent-amber-dim); color: var(--accent-amber); }
  &.sev-low { background: var(--accent-green-dim); color: var(--accent-green); }
}
</style>
