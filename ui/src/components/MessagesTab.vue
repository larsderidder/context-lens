<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Splitpanes, Pane } from 'splitpanes'
import { useSessionStore } from '@/stores/session'
import { useExpandable } from '@/composables/useExpandable'
import { fmtTokens } from '@/utils/format'
import { groupMessagesByCategory, buildToolNameMap, extractPreview, CATEGORY_META } from '@/utils/messages'
import type { ParsedMessage } from '@/api-types'
import DetailPane from '@/components/DetailPane.vue'

const messageScrollByKey = new Map<string, number>()

const store = useSessionStore()
const entry = computed(() => store.selectedEntry)
const { isExpanded, toggle } = useExpandable()
const msgListEl = ref<HTMLElement | null>(null)

const detailOpen = ref(false)
const detailIndex = ref(0)

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

function openDetail(flatIdx: number) {
  detailIndex.value = flatIdx
  detailOpen.value = true
}

function closeDetail() {
  detailOpen.value = false
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

          <div v-for="(group, catIdx) in categorized" :key="group.category" class="msg-group">
            <!-- Group header -->
            <div class="group-head" @click="toggle(group.category)">
              <span class="group-arrow">{{ isExpanded(group.category) ? '▾' : '▸' }}</span>
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
            <div class="group-items" :class="{ open: isExpanded(group.category) }">
              <div
                v-for="(item, itemIdx) in group.items"
                :key="item.origIdx"
                class="msg-row"
                :class="{ selected: detailOpen && flatMessages[detailIndex]?.origIdx === item.origIdx }"
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
          @navigate="(idx: number) => detailIndex = idx"
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
