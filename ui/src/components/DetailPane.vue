<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { ParsedMessage, ProjectedEntry } from '@/api-types'
import { fmtTokens } from '@/utils/format'
import { classifyMessageRole, CATEGORY_META, buildToolNameMap, extractFullText, msgToRawObject } from '@/utils/messages'

const props = defineProps<{
  entry: ProjectedEntry
  messages: { msg: ParsedMessage; origIdx: number }[]
  selectedIndex: number
}>()

const emit = defineEmits<{
  close: []
  navigate: [index: number]
}>()

const tab = ref<'rendered' | 'raw'>('rendered')
const showAll = ref(false)
const contentEl = ref<HTMLElement | null>(null)
const MAX_CHARS = 50000
const MAX_LINES = 500

const msg = computed(() => props.messages[props.selectedIndex]?.msg ?? null)
const toolNameMap = computed(() => buildToolNameMap(props.entry.contextInfo.messages || []))

const titleText = computed(() => {
  const m = msg.value
  if (!m) return ''
  const cat = classifyMessageRole(m)
  const meta = CATEGORY_META[cat] || { label: cat }
  let title = meta.label
  if (m.contentBlocks) {
    for (const b of m.contentBlocks) {
      if (b.type === 'tool_use') { title = `Tool Call — ${b.name || 'unknown'}`; break }
      if (b.type === 'tool_result') {
        const tn = b.tool_use_id ? toolNameMap.value[b.tool_use_id] : null
        title = `Tool Result${tn ? ' — ' + tn : ''}`
        break
      }
      const any = b as unknown as Record<string, unknown>
      if (any.type === 'thinking') { title = 'Thinking'; break }
    }
  }
  return title
})

const titleColor = computed(() => {
  if (!msg.value) return ''
  const cat = classifyMessageRole(msg.value)
  return (CATEGORY_META[cat] || { color: '#4b5563' }).color
})

const tokPct = computed(() => {
  if (!msg.value || !props.entry.contextInfo.totalTokens) return '0'
  return ((msg.value.tokens || 0) / props.entry.contextInfo.totalTokens * 100).toFixed(1)
})

const canPrev = computed(() => props.selectedIndex > 0)
const canNext = computed(() => props.selectedIndex < props.messages.length - 1)

watch(() => props.selectedIndex, () => {
  tab.value = 'rendered'
  showAll.value = false
  nextTick(() => { if (contentEl.value) contentEl.value.scrollTop = 0 })
})

function navigate(dir: number) {
  const newIdx = props.selectedIndex + dir
  if (newIdx >= 0 && newIdx < props.messages.length) emit('navigate', newIdx)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { emit('close'); e.preventDefault() }
  if (e.key === 'ArrowUp' || e.key === 'k') { navigate(-1); e.preventDefault() }
  if (e.key === 'ArrowDown' || e.key === 'j') { navigate(1); e.preventDefault() }
}

const copyLabel = ref('Copy')
async function handleCopy() {
  if (!msg.value) return
  const text = tab.value === 'raw'
    ? JSON.stringify(msgToRawObject(msg.value), null, 2)
    : extractFullText(msg.value)
  await navigator.clipboard.writeText(text)
  copyLabel.value = 'Copied!'
  setTimeout(() => { copyLabel.value = 'Copy' }, 1500)
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (showAll.value) return { text, truncated: false }
  if (text.length > MAX_CHARS) return { text: text.slice(0, MAX_CHARS), truncated: true }
  const lines = text.split('\n')
  if (lines.length > MAX_LINES) return { text: lines.slice(0, MAX_LINES).join('\n'), truncated: true }
  return { text, truncated: false }
}

function getRenderedBlocks(): { type: string; label: string; labelClass: string; content: string; isJson: boolean }[] {
  const m = msg.value
  if (!m) return []
  const blocks = m.contentBlocks
  if (blocks && blocks.length > 0) {
    return blocks.map(b => {
      if (b.type === 'tool_use') {
        const params = b.input ? JSON.stringify(b.input, null, 2) : '{}'
        return { type: 'tool_use', label: `tool_use: ${b.name || '?'}`, labelClass: 'lbl-tool-use', content: params, isJson: true }
      }
      if (b.type === 'tool_result') {
        const tn = b.tool_use_id ? toolNameMap.value[b.tool_use_id] : null
        const rc = typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2)
        return { type: 'tool_result', label: `tool_result${tn ? ': ' + tn : ''}`, labelClass: 'lbl-tool-result', content: rc, isJson: false }
      }
      const any = b as unknown as Record<string, unknown>
      if (any.type === 'thinking') {
        return { type: 'thinking', label: 'thinking', labelClass: 'lbl-thinking', content: (any.thinking as string) || (any.text as string) || '', isJson: false }
      }
      if (b.type === 'text' || b.type === 'input_text') {
        return { type: b.type, label: b.type, labelClass: 'lbl-text', content: b.text || '', isJson: false }
      }
      if (b.type === 'image') {
        return { type: 'image', label: 'image', labelClass: 'lbl-image', content: '[Image content]', isJson: false }
      }
      return { type: 'unknown', label: 'block', labelClass: 'lbl-text', content: `[Unknown block type: ${(b as any).type || 'unspecified'}]`, isJson: false }
    })
  }
  return [{ type: 'text', label: '', labelClass: '', content: m.content || '', isJson: false }]
}

const metaPairs = computed((): [string, string][] => {
  const m = msg.value
  if (!m) return []
  const pairs: [string, string][] = [
    ['Role', m.role],
    ['Tokens', fmtTokens(m.tokens || 0)],
    ['% context', tokPct.value + '%'],
    ['Model', props.entry.contextInfo.model || '?'],
  ]
  if (m.contentBlocks) {
    for (const b of m.contentBlocks) {
      if (b.type === 'tool_use') {
        pairs.push(['tool_use_id', b.id || '?'])
        pairs.push(['tool_name', b.name || '?'])
      }
      if (b.type === 'tool_result' && b.tool_use_id) {
        pairs.push(['tool_use_id', b.tool_use_id])
        const tn = toolNameMap.value[b.tool_use_id]
        if (tn) pairs.push(['tool_name', tn])
      }
    }
  }
  pairs.push(['Position', `${props.selectedIndex + 1} / ${props.messages.length}`])
  return pairs
})
</script>

<template>
  <div class="detail" tabindex="0" @keydown="handleKeydown">
    <!-- ── Header ── -->
    <div class="detail-header">
      <div class="header-top">
        <button class="close-btn" @click="$emit('close')" v-tooltip="'Close (Esc)'">
          <i class="i-carbon-close" />
        </button>
        <span class="detail-title" :style="{ color: titleColor }">{{ titleText }}</span>
        <button class="copy-btn" :class="{ copied: copyLabel === 'Copied!' }" @click="handleCopy">
          <i class="i-carbon-copy" />
          {{ copyLabel }}
        </button>
        <div class="nav-btns">
          <button :disabled="!canPrev" @click="navigate(-1)" v-tooltip="'↑ Previous'">↑</button>
          <button :disabled="!canNext" @click="navigate(1)" v-tooltip="'↓ Next'">↓</button>
        </div>
      </div>
      <div class="header-meta" v-if="msg">
        <span><b>{{ msg.role }}</b></span>
        <span>{{ fmtTokens(msg.tokens || 0) }} tok</span>
        <span>{{ tokPct }}%</span>
        <span>{{ selectedIndex + 1 }}/{{ messages.length }}</span>
      </div>
    </div>

    <!-- ── Tabs ── -->
    <div class="detail-tabs">
      <button :class="{ on: tab === 'rendered' }" @click="tab = 'rendered'">Rendered</button>
      <button :class="{ on: tab === 'raw' }" @click="tab = 'raw'">Raw</button>
    </div>

    <!-- ── Content ── -->
    <div ref="contentEl" class="detail-body">
      <template v-if="tab === 'rendered' && msg">
        <template v-for="(block, i) in getRenderedBlocks()" :key="i">
          <hr v-if="i > 0" class="block-sep" />
          <div v-if="block.label" class="block-label" :class="block.labelClass">{{ block.label }}</div>
          <pre class="block-content">{{ truncate(block.content).text }}</pre>
          <button v-if="truncate(block.content).truncated" class="show-more" @click="showAll = true">
            Show full content…
          </button>
        </template>
      </template>
      <template v-else-if="tab === 'raw' && msg">
        <pre class="block-content">{{ JSON.stringify(msgToRawObject(msg), null, 2) }}</pre>
      </template>
    </div>

    <!-- ── Footer meta ── -->
    <div class="detail-footer">
      <template v-for="([label, val]) in metaPairs" :key="label">
        <span class="meta-key">{{ label }}</span>
        <span class="meta-val" :title="val">{{ val }}</span>
      </template>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.detail {
  height: 100%;
  background: var(--bg-field);
  border-left: 1px solid var(--border-dim);
  display: flex;
  flex-direction: column;
  outline: none;
}

// ── Header ──
.detail-header {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-dim);
  flex-shrink: 0;
}

.header-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.close-btn {
  @include mono-text;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: none;
  border: none;
  display: flex;
  align-items: center;
  transition: color 0.1s, background 0.1s;
  flex-shrink: 0;

  &:hover { color: var(--text-primary); background: var(--bg-hover); }
}

.detail-title {
  @include truncate;
  font-size: var(--text-sm);
  font-weight: 600;
  flex: 1;
}

.copy-btn {
  @include mono-text;
  font-size: 9px;
  color: var(--text-muted);
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 3px;
  transition: color 0.12s, border-color 0.12s;
  flex-shrink: 0;

  &:hover { color: var(--accent-blue); border-color: var(--accent-blue); }
  &.copied { color: var(--accent-green); border-color: var(--accent-green); }

  i { font-size: 10px; }
}

.nav-btns {
  display: flex;
  gap: 2px;
  flex-shrink: 0;

  button {
    @include mono-text;
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.1s, border-color 0.1s;

    &:hover:not(:disabled) { color: var(--accent-blue); border-color: var(--accent-blue); }
    &:disabled { opacity: 0.25; cursor: default; }
  }
}

.header-meta {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);
  margin-top: 5px;
  display: flex;
  gap: var(--space-3);

  b { color: var(--text-secondary); font-weight: 600; }
}

// ── Tabs ──
.detail-tabs {
  display: flex;
  border-bottom: 1px solid var(--border-dim);
  flex-shrink: 0;

  button {
    font-size: var(--text-xs);
    color: var(--text-muted);
    padding: 7px var(--space-4);
    cursor: pointer;
    border: none;
    border-bottom: 2px solid transparent;
    background: none;
    transition: color 0.1s, border-color 0.1s;

    &:hover { color: var(--text-secondary); }
    &.on { color: var(--accent-blue); border-bottom-color: var(--accent-blue); }
  }
}

// ── Body ──
.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  @include scrollbar-thin;
}

.block-sep {
  border: none;
  border-top: 1px solid var(--border-dim);
  margin: var(--space-3) 0;
}

.block-label {
  display: inline-block;
  @include mono-text;
  font-size: 8px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 1px 6px;
  border-radius: 2px;
  margin-bottom: 6px;

  &.lbl-tool-use { background: rgba(244, 114, 182, 0.10); color: #f472b6; }
  &.lbl-tool-result { background: rgba(16, 185, 129, 0.10); color: #10b981; }
  &.lbl-thinking { background: rgba(167, 139, 250, 0.10); color: #a78bfa; }
  &.lbl-text { background: rgba(251, 191, 36, 0.08); color: #fbbf24; }
  &.lbl-image { background: rgba(75, 85, 99, 0.15); color: #9ca3af; }
}

.block-content {
  @include mono-text;
  font-size: var(--text-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  margin: 0;
}

.show-more {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--accent-blue);
  cursor: pointer;
  padding: 4px 0;
  background: none;
  border: none;
  transition: color 0.1s;

  &:hover { color: var(--text-primary); }
}

// ── Footer ──
.detail-footer {
  border-top: 1px solid var(--border-dim);
  padding: var(--space-2) var(--space-4);
  flex-shrink: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px var(--space-4);
  @include mono-text;
  font-size: 9px;
}

.meta-key { color: var(--text-ghost); }
.meta-val {
  @include truncate;
  color: var(--text-dim);
  text-align: right;
}
</style>
