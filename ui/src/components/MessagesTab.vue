<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Splitpanes, Pane } from 'splitpanes'
import { useSessionStore } from '@/stores/session'
import { useExpandable } from '@/composables/useExpandable'
import { fmtTokens, shortModel } from '@/utils/format'
import { groupMessagesByCategory, buildToolNameMap, extractPreview, CATEGORY_META, classifyMessageRole, classifyEntries } from '@/utils/messages'
import type { ParsedMessage } from '@/api-types'
import DetailPane from '@/components/DetailPane.vue'
import TreeView from '@/components/TreeView.vue'
import type { TreeNode } from '@/components/TreeView.vue'

const messageScrollByKey = new Map<string, number>()

const store = useSessionStore()
const entry = computed(() => store.selectedEntry)
const session = computed(() => store.selectedSession)
const { isExpanded, toggle, expand } = useExpandable()
const msgListEl = ref<HTMLElement | null>(null)
const viewMode = ref<'current' | 'tree'>('current')

const detailOpen = ref(false)
const detailIndex = ref(0)
const selectedMsgKey = ref<string | null>(null)
const selectedMsgOrdinal = ref(1)

const toolNameMap = computed(() => {
  return buildToolNameMap(messages.value)
})

// Use full (uncompacted) messages when available, fall back to compacted
const messages = computed(() => {
  if (!entry.value) return []
  // Touch reactive version to recompute when detail loads
  void store.entryDetailVersion
  const detail = store.getEntryDetail(entry.value.id)
  if (detail?.messages?.length) return detail.messages
  return entry.value.contextInfo.messages || []
})

// True when we're showing compacted (truncated) messages because no detail file exists
const isCompactedFallback = computed(() => {
  if (!entry.value) return false
  void store.entryDetailVersion
  return !store.getEntryDetail(entry.value.id) && store.entryDetailLoading !== entry.value.id
})
// Note: store.entryDetailLoading is unwrapped by Pinia, so no .value needed

const categorized = computed(() => {
  return groupMessagesByCategory(messages.value)
})

const flatMessages = computed(() => {
  const result: { msg: ParsedMessage; origIdx: number }[] = []
  for (const group of categorized.value) {
    for (const item of group.items) result.push(item)
  }
  return result
})

const totalMsgTokens = computed(() => {
  return messages.value.reduce((s, m) => s + (m.tokens || 0), 0)
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

const treeNodes = computed<TreeNode[]>(() => {
  if (!session.value) return []
  const ordered = classifyEntries([...session.value.entries].reverse())
  const selectedId = store.selectedEntry?.id ?? null
  let selectedMainId: number | null = null
  if (selectedId != null) {
    for (const item of ordered) {
      if (item.isMain) selectedMainId = item.entry.id
      if (item.entry.id === selectedId) break
    }
  }
  const mainRows: TreeNode[] = []
  let turnCounter = 0
  for (let i = 0; i < ordered.length; i++) {
    const item = ordered[i]
    if (!item.isMain) continue
    turnCounter += 1

    let subagentCalls = 0
    for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[j].isMain) break
      subagentCalls += 1
    }

    const groups = groupMessagesByCategory(item.entry.contextInfo.messages || [])
    const turnLabel = `Turn ${turnCounter} · ${shortModel(item.entry.contextInfo.model)}`
    const turnMeta = subagentCalls > 0
      ? `${fmtTokens(item.entry.contextInfo.totalTokens)} · ${subagentCalls} sub`
      : fmtTokens(item.entry.contextInfo.totalTokens)

    mainRows.push({
      id: `turn-${item.entry.id}`,
      label: turnLabel,
      meta: turnMeta,
      selectable: false,
      children: groups.map((group) => ({
        id: `turn-${item.entry.id}-cat-${group.category}`,
        label: (CATEGORY_META[group.category] || { label: group.category }).label,
        meta: `${group.items.length} · ${fmtTokens(group.tokens)}`,
        color: (CATEGORY_META[group.category] || { color: '#4b5563' }).color,
        selectable: false,
        children: group.items.map((msgItem) => ({
          id: `turn-${item.entry.id}-msg-${msgItem.origIdx}`,
          label: extractPreview(msgItem.msg, toolNameMap.value) || '(empty)',
          meta: fmtTokens(msgItem.msg.tokens || 0),
          selectable: true,
          payload: { entryId: item.entry.id, origIdx: msgItem.origIdx },
        })),
      })),
    })
  }
  // Latest turn first in tree navigation.
  const latestFirst = mainRows.reverse()
  if (store.selectionMode === 'pinned' && selectedMainId != null) {
    return latestFirst.filter((node) => node.id === `turn-${selectedMainId}`)
  }
  return latestFirst
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
  // Focus by message index (e.g. from security alert findings)
  const focusIdx = store.messageFocusIndex
  if (focusIdx != null) {
    // Retry loop: the tab/data may not be ready on the first tick
    for (let attempt = 0; attempt < 4; attempt++) {
      await nextTick()
      // Find which category contains this message
      for (const group of categorized.value) {
        const match = group.items.find(item => item.origIdx === focusIdx)
        if (match) {
          expand(group.category)
          await nextTick()
          await nextTick()
          openDetailByOrigIndex(focusIdx)
          await nextTick()
          const root = msgListEl.value
          if (root) {
            const rows = Array.from(root.querySelectorAll('.msg-row')) as HTMLElement[]
            const target = rows.find(row => row.classList.contains('selected'))
            if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
          return
        }
      }
    }
    return
  }

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

async function openFromTree(turnEntryId: number, origIdx: number) {
  store.pinEntry(turnEntryId)
  store.focusMessageByIndex(origIdx)
  await nextTick()
  openDetailByOrigIndex(origIdx)
}

function handleTreeSelect(node: TreeNode) {
  const entryId = Number(node.payload?.entryId)
  const origIdx = Number(node.payload?.origIdx)
  if (!Number.isFinite(entryId) || !Number.isFinite(origIdx)) return
  openFromTree(entryId, origIdx)
}

function handleTreeToggle(id: string) {
  toggle(id)
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
  async () => {
    await applyMessageFocus()
    if (store.messageFocusIndex !== null) {
      await nextTick()
      openDetailByOrigIndex(store.messageFocusIndex)
    }
  },
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

// Fetch full (uncompacted) entry detail when the selected entry changes
watch(
  () => entry.value?.id,
  async (entryId) => {
    if (entryId != null) {
      await store.loadEntryDetail(entryId)
    }
  },
  { immediate: true },
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
          <div class="message-view-toggle">
            <button :class="{ on: viewMode === 'current' }" @click="viewMode = 'current'">Current Context</button>
            <button :class="{ on: viewMode === 'tree' }" @click="viewMode = 'tree'">Session Tree</button>
          </div>

          <template v-if="viewMode === 'current'">
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
          </template>

          <template v-else>
            <div class="scope-note">
              {{ store.selectionMode === 'pinned'
                ? 'Tree scoped to pinned turn.'
                : 'Tree scoped to session (latest turn first).' }}
            </div>
            <div class="tree-wrap">
              <TreeView
                :nodes="treeNodes"
                :is-expanded="isExpanded"
                @toggle="handleTreeToggle"
                @select="handleTreeSelect"
              />
            </div>
          </template>
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

.message-view-toggle {
  display: inline-flex;
  margin: 0 var(--space-4) var(--space-3);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  overflow: hidden;

  button {
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: var(--bg-raised);
    border: none;
    padding: 4px 10px;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;

    & + button {
      border-left: 1px solid var(--border-dim);
    }

    &:hover {
      color: var(--text-secondary);
      background: var(--bg-hover);
    }

    &.on {
      color: var(--accent-blue);
      background: var(--accent-blue-dim);
    }
  }
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

.compacted-notice {
  margin: var(--space-2) var(--space-4);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--accent-amber-dim);
  color: var(--accent-amber);
  font-size: var(--text-xs);
  @include mono-text;
}

.scope-note {
  margin: 0 var(--space-4) var(--space-2);
  color: var(--text-ghost);
  font-size: var(--text-xs);
}

.tree-wrap {
  margin: 0 var(--space-3) var(--space-2);
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
  max-width: 450px;
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
