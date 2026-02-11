<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Splitpanes, Pane } from 'splitpanes'
import { useSessionStore } from '@/stores/session'
import { useExpandable } from '@/composables/useExpandable'
import { fmtTokens } from '@/utils/format'
import { groupMessagesByCategory, buildToolNameMap, extractPreview, CATEGORY_META, classifyMessageRole } from '@/utils/messages'
import type { ParsedMessage } from '@/api-types'
import DetailPane from '@/components/DetailPane.vue'

const messageScrollByKey = new Map<string, number>()

const store = useSessionStore()
const entry = computed(() => store.selectedEntry)
const { isExpanded, toggle, expand } = useExpandable()
const msgListEl = ref<HTMLElement | null>(null)

const detailOpen = ref(false)
const detailIndex = ref(0)
const selectedMsgKey = ref<string | null>(null)
const selectedMsgOrdinal = ref(1)

const toolNameMap = computed(() => {
  if (!entry.value) return {}
  return buildToolNameMap(entry.value.contextInfo.messages || [])
})

const categorized = computed(() => {
  if (!entry.value) return []
  return groupMessagesByCategory(entry.value.contextInfo.messages || [])
})

const flatMessages = computed(() => {
  const result: { msg: ParsedMessage; origIdx: number }[] = []
  for (const group of categorized.value) {
    for (const item of group.items) result.push(item)
  }
  return result
})

const totalMsgTokens = computed(() => {
  if (!entry.value) return 0
  return (entry.value.contextInfo.messages || []).reduce((s, m) => s + (m.tokens || 0), 0)
})

const heaviestMessages = computed(() => {
  const ranked: { origIdx: number; category: string; preview: string; tokens: number }[] = []
  for (const group of categorized.value) {
    for (const item of group.items) {
      ranked.push({
        origIdx: item.origIdx,
        category: group.category,
        preview: extractPreview(item.msg, toolNameMap.value) || '(empty)',
        tokens: item.msg.tokens || 0,
      })
    }
  }
  return ranked
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)
})

const messageScrollKey = computed(() => `${store.selectedSessionId || '__no_session__'}:messages`)
const focusedToolName = computed(() => store.messageFocusTool)
const focusedCategory = computed(() => store.messageFocusCategory)

const focusCategory = computed(() => {
  const requested = store.messageFocusCategory
  if (!requested) return null

  const present = new Set(categorized.value.map((g) => g.category))
  if (present.has(requested)) return requested

  const fallbackOrder: Record<string, string[]> = {
    assistant_text: ['tool_calls', 'thinking', 'assistant_text', 'user_text'],
    tool_definitions: ['tool_calls', 'tool_results', 'system_injections'],
    system_prompt: ['system_injections', 'assistant_text', 'user_text'],
    images: ['user_text', 'assistant_text', 'tool_results'],
    cache_markers: ['tool_results', 'assistant_text', 'user_text'],
    other: ['assistant_text', 'user_text', 'tool_results'],
  }

  for (const candidate of fallbackOrder[requested] || []) {
    if (present.has(candidate)) return candidate
  }
  return categorized.value[0]?.category ?? null
})

const hasCategoryFallback = computed(() => {
  return !!focusedCategory.value && !!focusCategory.value && focusedCategory.value !== focusCategory.value
})

function openDetail(flatIdx: number) {
  detailIndex.value = flatIdx
  syncSelectionSignature(flatIdx)
  detailOpen.value = true
}

function closeDetail() {
  detailOpen.value = false
}

function messageKey(msg: ParsedMessage): string {
  const first = (msg.contentBlocks || [])[0]
  if (!first) return `${msg.role}|${msg.tokens || 0}|${msg.content?.slice(0, 160) || ''}`
  if (first.type === 'tool_result') {
    const content = typeof first.content === 'string' ? first.content : JSON.stringify(first.content || '')
    return `${msg.role}|${msg.tokens || 0}|tool_result|${first.tool_use_id || ''}|${content.slice(0, 160)}`
  }
  if (first.type === 'tool_use') {
    return `${msg.role}|${msg.tokens || 0}|tool_use|${first.id || ''}|${first.name || ''}|${JSON.stringify(first.input || {}).slice(0, 120)}`
  }
  const anyFirst = first as unknown as Record<string, unknown>
  const text = String((anyFirst.text as string) || (anyFirst.thinking as string) || '').slice(0, 160)
  return `${msg.role}|${msg.tokens || 0}|${String(anyFirst.type || 'other')}|${text}`
}

function syncSelectionSignature(index: number) {
  const item = flatMessages.value[index]
  if (!item) return
  const key = messageKey(item.msg)
  selectedMsgKey.value = key

  let ordinal = 0
  for (let i = 0; i <= index; i++) {
    if (messageKey(flatMessages.value[i].msg) === key) ordinal += 1
  }
  selectedMsgOrdinal.value = Math.max(1, ordinal)
}

function findIndexBySelectionSignature(): number {
  const key = selectedMsgKey.value
  if (!key) return -1
  let seen = 0
  for (let i = 0; i < flatMessages.value.length; i++) {
    if (messageKey(flatMessages.value[i].msg) === key) {
      seen += 1
      if (seen === selectedMsgOrdinal.value) return i
    }
  }
  return -1
}

function onDetailNavigate(idx: number) {
  detailIndex.value = idx
  syncSelectionSignature(idx)
}

function flatIndexOf(catIdx: number, itemIdx: number): number {
  let idx = 0
  for (let c = 0; c < categorized.value.length; c++) {
    if (c === catIdx) return idx + itemIdx
    idx += categorized.value[c].items.length
  }
  return 0
}

function openDetailByOrigIndex(origIdx: number) {
  const flatIdx = flatMessages.value.findIndex((item) => item.origIdx === origIdx)
  if (flatIdx >= 0) openDetail(flatIdx)
}

function toolResultName(msg: ParsedMessage): string | null {
  if (classifyMessageRole(msg) !== 'tool_results') return null
  for (const block of msg.contentBlocks || []) {
    if (block.type === 'tool_result') {
      return (block.tool_use_id && toolNameMap.value[block.tool_use_id]) || null
    }
  }
  return null
}

function rowClassForToolFocus(msg: ParsedMessage): Record<string, boolean> {
  const focused = focusedToolName.value
  if (!focused) return {}
  const tname = toolResultName(msg)
  if (!tname) return { 'tool-muted': true }
  const left = tname.trim().toLowerCase()
  const right = focused.trim().toLowerCase()
  return {
    'tool-focused': left === right,
    'tool-muted': left !== right,
  }
}

async function applyMessageFocus() {
  const category = focusCategory.value
  if (!category) return

  let root: HTMLElement | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    await nextTick()
    root = msgListEl.value
    if (!root) continue

    expand(category)
    await nextTick()
    const groupEl = root.querySelector(`[data-category="${category}"]`) as HTMLElement | null
    if (groupEl) {
      groupEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
      break
    }
  }
  if (!root) return

  const focusTool = store.messageFocusTool
  if (focusTool) {
    const rows = Array.from(root.querySelectorAll('.msg-row')) as HTMLElement[]
    const target = focusTool.trim().toLowerCase()
    const firstMatch = rows.find((row) => (row.getAttribute('data-tool-name') || '').trim().toLowerCase() === target)
    if (firstMatch) firstMatch.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
}

function clearToolFilter() {
  store.focusMessageCategory(focusCategory.value || store.messageFocusCategory || 'tool_results')
}

function handleMsgListScroll() {
  if (!msgListEl.value) return
  messageScrollByKey.set(messageScrollKey.value, msgListEl.value.scrollTop)
}

function restoreMsgListScroll(key: string) {
  nextTick(() => {
    if (!msgListEl.value) return
    msgListEl.value.scrollTop = messageScrollByKey.get(key) ?? 0
  })
}

watch(
  messageScrollKey,
  (newKey, oldKey) => {
    if (oldKey && msgListEl.value) {
      messageScrollByKey.set(oldKey, msgListEl.value.scrollTop)
    }
    restoreMsgListScroll(newKey)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (!msgListEl.value) return
  messageScrollByKey.set(messageScrollKey.value, msgListEl.value.scrollTop)
})

watch(
  () => store.messageFocusToken,
  async () => { await applyMessageFocus() },
  { immediate: true },
)

watch(
  () => store.inspectorTab,
  async (tab) => {
    if (tab === 'messages') await applyMessageFocus()
  },
)

watch(
  () => categorized.value.length,
  async () => {
    if (store.inspectorTab === 'messages' && store.messageFocusCategory) {
      await applyMessageFocus()
    }
  },
)

onMounted(async () => {
  if (store.inspectorTab === 'messages' && store.messageFocusCategory) {
    await applyMessageFocus()
  }
})

watch(
  flatMessages,
  () => {
    if (!detailOpen.value) return
    const idx = findIndexBySelectionSignature()
    if (idx >= 0 && idx !== detailIndex.value) {
      detailIndex.value = idx
      return
    }
    if (detailIndex.value >= flatMessages.value.length) {
      detailIndex.value = Math.max(0, flatMessages.value.length - 1)
      syncSelectionSignature(detailIndex.value)
    }
  },
)
</script>

<template>
  <div v-if="entry" class="messages-tab">
    <Splitpanes class="default-theme" :push-other-panes="false">
      <Pane :min-size="25" :size="detailOpen ? 42 : 100">
        <div ref="msgListEl" class="msg-list" @scroll.passive="handleMsgListScroll">
          <div v-if="heaviestMessages.length > 0" class="heavy-strip">
            <div class="heavy-title">Top heavy messages</div>
            <div class="heavy-hint">Tip: use ↑/↓ in detail pane to move between messages, Esc to close.</div>
            <div class="heavy-actions">
              <button
                v-for="item in heaviestMessages"
                :key="item.origIdx"
                class="heavy-action"
                @click="openDetailByOrigIndex(item.origIdx)"
              >
                <span class="heavy-category">{{ (CATEGORY_META[item.category] || { label: item.category }).label }}</span>
                <span class="heavy-preview">{{ item.preview }}</span>
                <span class="heavy-tokens">{{ fmtTokens(item.tokens) }}</span>
              </button>
            </div>
          </div>

          <div v-if="focusedToolName || hasCategoryFallback" class="focus-strip">
            <span v-if="focusedToolName">
              Filtered tool: <b>{{ focusedToolName }}</b>
            </span>
            <span v-if="hasCategoryFallback">
              Showing <b>{{ (CATEGORY_META[focusCategory || ''] || { label: focusCategory }).label }}</b>
              for <b>{{ (CATEGORY_META[focusedCategory || ''] || { label: focusedCategory }).label }}</b>.
            </span>
            <button v-if="focusedToolName" class="focus-clear" @click.stop="clearToolFilter">Show all</button>
          </div>

          <div class="scope-note">
            Showing messages from the selected call context (newest first).
          </div>

          <div
            v-for="(group, catIdx) in categorized"
            :key="group.category"
            class="msg-group"
            :data-category="group.category"
          >
            <!-- Group header -->
            <div class="group-head" @click="toggle(group.category)">
              <span class="group-arrow">{{ (isExpanded(group.category) || focusCategory === group.category) ? '▾' : '▸' }}</span>
              <span class="group-dot" :style="{ background: (CATEGORY_META[group.category] || { color: '#4b5563' }).color }" />
              <span class="group-name">{{ (CATEGORY_META[group.category] || { label: group.category }).label }}</span>
              <span class="group-stats">
                {{ group.items.length }}
                <span class="group-sep">·</span>
                {{ fmtTokens(group.tokens) }}
                <span class="group-sep">·</span>
                {{ totalMsgTokens > 0 ? Math.round(group.tokens / totalMsgTokens * 100) : 0 }}%
              </span>
              <div class="group-bar-track">
                <div
                  class="group-bar-fill"
                  :style="{
                    width: (totalMsgTokens > 0 ? Math.round(group.tokens / totalMsgTokens * 100) : 0) + '%',
                    background: (CATEGORY_META[group.category] || { color: '#4b5563' }).color,
                  }"
                />
              </div>
            </div>

            <!-- Messages -->
            <div class="group-items" :class="{ open: isExpanded(group.category) || focusCategory === group.category }">
              <div
                v-for="(item, itemIdx) in group.items"
                :key="item.origIdx"
                class="msg-row"
                :class="[rowClassForToolFocus(item.msg), { selected: detailOpen && flatMessages[detailIndex]?.origIdx === item.origIdx }]"
                :data-tool-name="toolResultName(item.msg) || ''"
                @click="openDetail(flatIndexOf(catIdx, itemIdx))"
              >
                <span class="msg-role">{{ item.msg.role === 'user' ? '›' : item.msg.role === 'assistant' ? '‹' : '·' }}</span>
                <span class="msg-preview">{{ extractPreview(item.msg, toolNameMap) || '(empty)' }}</span>
                <span class="msg-tok" :class="{ hot: (item.msg.tokens || 0) > 2000 }">{{ fmtTokens(item.msg.tokens || 0) }}</span>
              </div>
            </div>
          </div>
        </div>
      </Pane>
      <Pane v-if="detailOpen" :min-size="25" :size="58">
        <DetailPane
          :entry="entry"
          :messages="flatMessages"
          :selected-index="detailIndex"
          @close="closeDetail"
          @navigate="onDetailNavigate"
        />
      </Pane>
    </Splitpanes>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.messages-tab {
  height: 100%;
}

.msg-list {
  height: 100%;
  overflow-y: auto;
  padding: var(--space-3) 0;
  @include scrollbar-thin;
}

.heavy-strip {
  margin: 0 var(--space-4) var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
}

.heavy-title {
  @include section-label;
}

.heavy-hint {
  font-size: var(--text-xs);
  color: var(--text-ghost);
  margin: 3px 0 var(--space-2);
}

.heavy-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.focus-strip {
  margin: 0 var(--space-4) var(--space-2);
  padding: 6px 8px;
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-sm);
  background: rgba(22, 34, 56, 0.72);
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-dim);
  font-size: var(--text-sm);

  b {
    color: var(--text-secondary);
    font-weight: 600;
  }
}

.focus-clear {
  margin-left: auto;
  border: 1px solid var(--border-dim);
  background: var(--bg-raised);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  padding: 3px 8px;
  font-size: var(--text-xs);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;

  &:hover {
    border-color: var(--border-mid);
    background: var(--bg-hover);
  }
}

.scope-note {
  margin: 0 var(--space-4) var(--space-2);
  color: var(--text-ghost);
  font-size: var(--text-xs);
}

.heavy-action {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 1px solid var(--border-dim);
  background: var(--bg-raised);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: var(--text-xs);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
  justify-content: flex-start;

  &:hover {
    border-color: var(--border-mid);
    background: var(--bg-hover);
  }
}

.heavy-category {
  color: var(--text-muted);
  white-space: nowrap;
}

.heavy-preview {
  @include truncate;
  max-width: 280px;
  color: var(--text-dim);
}

.heavy-tokens {
  @include mono-text;
  color: var(--accent-amber);
  white-space: nowrap;
}

// ── Group ──
.msg-group {
  & + & { margin-top: 1px; }
}

.group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px var(--space-4);
  cursor: pointer;
  transition: background 0.1s;

  &:hover { background: var(--bg-hover); }
}

.group-arrow {
  color: var(--text-ghost);
  width: 10px;
  font-size: var(--text-xs);
  flex-shrink: 0;
}

.group-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.group-name {
  @include sans-text;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-secondary);
}

.group-stats {
  margin-left: auto;
  color: var(--text-ghost);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.group-sep { color: var(--border-mid); margin: 0 2px; }

.group-bar-track {
  width: 48px;
  height: 3px;
  background: var(--bg-raised);
  border-radius: 2px;
  overflow: hidden;
  margin-left: var(--space-2);
  flex-shrink: 0;
}

.group-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
}

// ── Items ──
.group-items {
  margin-left: 18px;
  border-left: 1px solid var(--border-dim);
  padding-left: var(--space-2);
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.2s ease-out;

  &.open {
    max-height: 8000px;
    transition: max-height 0.4s ease-in;
  }
}

.msg-row {
  @include data-row;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px var(--space-3);
  font-size: var(--text-sm);
  border-bottom: 1px solid rgba(28, 37, 53, 0.3);

  &:last-child { border-bottom: none; }

  &.tool-focused {
    background: rgba(52, 211, 153, 0.16);
    border-color: rgba(52, 211, 153, 0.36);
  }

  &.tool-muted {
    opacity: 0.28;
  }
}

.msg-role {
  @include mono-text;
  color: var(--text-ghost);
  width: 10px;
  font-size: var(--text-xs);
  flex-shrink: 0;
}

.msg-preview {
  @include truncate;
  @include sans-text;
  color: var(--text-dim);
  flex: 1;
  font-size: var(--text-sm);
}

.msg-tok {
  @include mono-text;
  color: var(--text-ghost);
  font-size: var(--text-xs);
  white-space: nowrap;
  flex-shrink: 0;

  &.hot { color: var(--accent-amber); }
}
</style>
