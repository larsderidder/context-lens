<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { hierarchy, treemap as d3Treemap } from 'd3-hierarchy'
import { fmtTokens } from '@/utils/format'
import { CATEGORY_META, SIMPLE_GROUPS, SIMPLE_META, buildToolNameMap, classifyMessageRole } from '@/utils/messages'
import type { ProjectedEntry } from '@/api-types'

interface Props {
  entry: ProjectedEntry
  turnNum: number
}

const props = defineProps<Props>()

const emit = defineEmits<{
  categoryClick: [category: string]
  toolClick: [toolName: string]
}>()

const treemapMode = ref<'detailed' | 'simple'>('detailed')
const treemapDrillKey = ref<string | null>(null)

const simpleComposition = computed((): { key: string; label: string; color: string; tokens: number }[] => {
  const comp = props.entry?.composition || []
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
  const e = props.entry
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
  const palette = ['#10b981', '#34d399', '#14b8a6', '#2dd4bf', '#10b981', '#06b6d4', '#0ea5e9']
  return palette[index % palette.length]
}

const toolResultTreemapNodes = computed((): TreemapNode[] => {
  const e = props.entry
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

const DETAILED_LEGEND_CAP = 5
const detailedLegendNodes = computed(() => activeDetailedTreemapNodes.value.slice(0, DETAILED_LEGEND_CAP))
const hiddenDetailedLegendNodes = computed(() => activeDetailedTreemapNodes.value.slice(DETAILED_LEGEND_CAP))
const hiddenDetailedLegendTooltip = computed(() =>
  hiddenDetailedLegendNodes.value
    .map((item) => `${item.label}: ${legendPct(item.tokens)}`)
    .join('\n'),
)

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

function handleDetailedTreemapItemClick(item: TreemapLayoutNode) {
  if (treemapDrillKey.value === null && item.category === 'tool_results' && toolResultTreemapNodes.value.length > 1) {
    treemapDrillKey.value = 'tool_results'
    return
  }
  if (treemapDrillKey.value === 'tool_results' && item.toolName) {
    emit('toolClick', item.toolName)
    return
  }
  emit('categoryClick', item.category || 'tool_results')
}

function onSimpleTreemapClick(groupKey: string) {
  const e = props.entry
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
  emit('categoryClick', target)
}

function resetTreemapDrill() {
  treemapDrillKey.value = null
}

const totalTokens = computed(() => props.entry?.composition?.reduce((s, c) => s + c.tokens, 0) ?? 0)

function legendPct(tokens: number): string {
  if (totalTokens.value === 0) return ''
  return Math.round(tokens / totalTokens.value * 100) + '%'
}

watch(
  () => props.entry?.id,
  () => {
    treemapDrillKey.value = null
  },
)
</script>

<template>
  <section class="panel panel--hero" v-if="entry.composition.length > 0">
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
          <template v-if="item.w >= 18 && item.h >= 16">
            <span class="tm-label">{{ item.label }}</span>
            <span class="tm-val">{{ fmtTokens(item.tokens) }}</span>
          </template>
          <template v-else-if="item.w >= 12 && item.h >= 12">
            <span class="tm-label-compact">{{ item.label.slice(0, 8) }}{{ item.label.length > 8 ? '…' : '' }}</span>
          </template>
          <template v-else-if="item.w >= 8 && item.h >= 8">
            <span class="tm-pct">{{ Math.round(item.pct) }}%</span>
          </template>
        </button>
      </div>
      <!-- Simple -->
      <div v-else class="treemap treemap-simple">
        <div
          v-for="g in simpleComposition" :key="g.key"
          class="tm-block tm-block-simple"
          :class="{ 'tm-block-narrow': (g.tokens / entry.composition.reduce((s, c) => s + c.tokens, 0)) < 0.15 }"
          :style="{ flex: g.tokens, background: g.color }"
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
            {{ item.label }} <span class="legend-pct">{{ legendPct(item.tokens) }}</span>
          </span>
          <span
            v-if="activeDetailedTreemapNodes.length > detailedLegendNodes.length"
            class="legend-item"
            v-tooltip="hiddenDetailedLegendTooltip"
          >
            +{{ activeDetailedTreemapNodes.length - detailedLegendNodes.length }} more
          </span>
        </template>
        <template v-else>
          <span v-for="g in simpleComposition" :key="g.key" class="legend-item">
            <span class="legend-dot" :style="{ background: g.color }" />
            {{ g.label }} <span class="legend-pct">{{ legendPct(g.tokens) }}</span>
          </span>
        </template>
      </div>
    </div>
  </section>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.panel {
  @include panel;
}

.panel--hero {
  border-color: var(--border-mid);
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

.mode-toggle {
  display: flex;
  margin-left: auto;
  border: 1px solid var(--border-dim);
  border-radius: 0;
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
  border-radius: 0;
  cursor: pointer;

  &:hover {
    border-color: var(--border-mid);
    color: var(--text-primary);
    background: var(--bg-hover);
  }
}

.treemap {
  height: 140px;
  border-radius: 0;
  overflow: hidden;
  position: relative;
  background: var(--bg-raised);
}

.treemap-simple {
  display: flex;
  gap: 1px;
}

.tm-block-simple {
  border: 1px solid rgba(0, 0, 0, 0.15);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.1);
}

.tm-block-narrow {
  .tm-label { writing-mode: vertical-rl; text-orientation: mixed; }
  .tm-val { writing-mode: vertical-rl; text-orientation: mixed; }
}

.tm-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: filter 0.15s, transform 0.15s, box-shadow 0.15s;
  min-width: 0;

  &:hover {
    filter: brightness(1.25);
    transform: scale(1.02);
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.3), 0 2px 6px rgba(0, 0, 0, 0.3);
    z-index: 10;
  }
}

.tm-block-2d {
  position: absolute;
  border: 1px solid rgba(0, 0, 0, 0.15);
  padding: 2px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.1);

  // Add subtle crosshatch to very small blocks
  &::before {
    content: '';
    position: absolute;
    inset: 0;
    opacity: 0;
    background-image:
      repeating-linear-gradient(
        45deg,
        rgba(255, 255, 255, 0.05) 0px,
        rgba(255, 255, 255, 0.05) 1px,
        transparent 1px,
        transparent 3px
      );
    pointer-events: none;
  }

  // Show pattern on very small blocks where text won't fit
  &:not(:has(.tm-label)):not(:has(.tm-label-compact)):not(:has(.tm-pct))::before {
    opacity: 1;
  }
}

.tm-label {
  @include mono-text;
  font-size: var(--text-xs);
  font-weight: 600;
  color: rgba(255, 255, 255, 0.95);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  @include truncate;
  max-width: 100%;
  padding: 0 4px;
}

.tm-label-compact {
  @include mono-text;
  font-size: 10px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.95);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  @include truncate;
  max-width: 100%;
  padding: 0 2px;
}

.tm-pct {
  @include mono-text;
  font-size: 10px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.95);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}

.tm-val {
  @include mono-text;
  font-size: var(--text-xs);
  color: rgba(255, 255, 255, 0.7);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}

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
  width: 6px;
  height: 6px;
  border-radius: 2px;
  flex-shrink: 0;
}

.legend-pct {
  @include mono-text;
  color: var(--text-ghost);
}

</style>
