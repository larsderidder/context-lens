<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Splitpanes, Pane } from 'splitpanes'
import { useSessionStore } from '@/stores/session'
import { useExpandable } from '@/composables/useExpandable'
import { fmtTokens } from '@/utils/format'
import { groupMessagesByCategory, buildToolNameMap, extractPreview, CATEGORY_META, classifyMessageRole, classifyEntries } from '@/utils/messages'
import { makeRelative, shortFileName } from '@/utils/files'
import type { ParsedMessage, ToolUseBlock } from '@/api-types'
import DetailPane from '@/components/DetailPane.vue'

const store = useSessionStore()
const entry = computed(() => store.selectedEntry)
const session = computed(() => store.selectedSession)
const { isExpanded, toggle, expand } = useExpandable()
const msgListEl = ref<HTMLElement | null>(null)
const viewMode = ref<'chrono' | 'category'>('chrono')

const detailOpen = ref(false)
const detailIndex = ref(0)
const selectedMsgKey = ref<string | null>(null)
const selectedMsgOrdinal = ref(1)

const toolNameMap = computed(() => {
  return buildToolNameMap(messages.value)
})

// Whether the session has any subagent entries (to conditionally show the Main/All toggle)
const hasSubAgentEntries = computed(() => {
  const s = session.value
  if (!s || s.entries.length <= 1) return false
  const classified = classifyEntries([...s.entries].reverse())
  return classified.some((item) => !item.isMain)
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

// Latest (live) entry's messages, used to show "future" messages grayed out
const latestEntry = computed(() => {
  if (!session.value || session.value.entries.length === 0) return null
  return session.value.entries[0] // entries are newest-first
})

const latestMessages = computed((): ParsedMessage[] => {
  if (!latestEntry.value) return []
  void store.entryDetailVersion
  const detail = store.getEntryDetail(latestEntry.value.id)
  if (detail?.messages?.length) return detail.messages
  return latestEntry.value.contextInfo.messages || []
})

// How many messages are in the selected (possibly pinned) entry's context
const selectedMessageCount = computed(() => messages.value.length)

// Are we viewing an older turn (pinned) where the latest has more messages?
const hasFutureMessages = computed(() => {
  if (store.selectionMode !== 'pinned') return false
  return latestMessages.value.length > selectedMessageCount.value
})

// Combined chrono messages: selected entry's messages + future messages from latest
const chronoAllMessages = computed(() => {
  if (!hasFutureMessages.value) {
    return messages.value.map((msg, i) => ({ msg, origIdx: i, future: false }))
  }
  const result: { msg: ParsedMessage; origIdx: number; future: boolean }[] = []
  // Current turn's messages (in context)
  for (let i = 0; i < messages.value.length; i++) {
    result.push({ msg: messages.value[i], origIdx: i, future: false })
  }
  // Future messages from the latest entry (beyond the selected turn's context)
  for (let i = messages.value.length; i < latestMessages.value.length; i++) {
    result.push({ msg: latestMessages.value[i], origIdx: i, future: true })
  }
  return result
})

// Detect turn boundaries in the message list.
// A turn boundary is where a new user message appears after assistant output,
// signaling the start of a new conversational turn.
const chronoTurnBoundaries = computed(() => {
  const msgs = chronoAllMessages.value
  const boundaries = new Set<number>()
  // Mark index 0 as the start of turn 1
  if (msgs.length > 0) boundaries.add(0)
  let seenAssistant = false
  for (let i = 0; i < msgs.length; i++) {
    const role = msgs[i].msg.role
    if (role === 'assistant') {
      seenAssistant = true
    } else if (role === 'user' && seenAssistant) {
      boundaries.add(i)
      seenAssistant = false
    }
  }
  return boundaries
})

// Global turn number of the selected entry (1-based), derived from the session's
// full entry list so that post-compaction turns don't reset to "Turn 1".
// In "all" mode, every entry (including subagent) counts as a turn.
const globalTurnNumber = computed(() => {
  const s = session.value
  const e = entry.value
  if (!s || !e) return 1
  // entries are newest-first; reverse for chronological order
  const classified = classifyEntries([...s.entries].reverse())
  const showAll = store.messagesMode === 'all'
  let idx = 0
  for (const item of classified) {
    if (showAll || item.isMain) idx++
    if (item.entry.id === e.id) return idx
  }
  return 1
})

// How many user/assistant turns belong to the *selected* entry (exclude future messages).
const localTurnCount = computed(() => {
  const msgCount = selectedMessageCount.value
  let count = 0
  for (const idx of chronoTurnBoundaries.value) {
    if (idx < msgCount) count++
  }
  return count
})

// Offset: global turn number minus local turn count gives how many turns
// were compacted away before the first visible message.
const turnOffset = computed(() => Math.max(0, globalTurnNumber.value - localTurnCount.value))

// Map from message index to turn number
const chronoTurnNumbers = computed(() => {
  const map = new Map<number, number>()
  let turnNum = turnOffset.value
  for (const idx of chronoTurnBoundaries.value) {
    turnNum++
    map.set(idx, turnNum)
  }
  return map
})

const categorized = computed(() => {
  return groupMessagesByCategory(messages.value)
})

const flatMessages = computed(() => {
  if (viewMode.value === 'chrono') return chronoMessages.value
  const result: { msg: ParsedMessage; origIdx: number }[] = []
  for (const group of categorized.value) {
    for (const item of group.items) result.push(item)
  }
  return result
})

// Chronological: messages in context order for DetailPane navigation
const chronoMessages = computed(() => {
  // Only include non-future messages for detail pane navigation
  return messages.value.map((msg, i) => ({ msg, origIdx: i }))
})

// Cumulative token sums for the chrono gutter (only for in-context messages)
const chronoCumTokens = computed(() => {
  const sums: number[] = []
  let running = 0
  for (const item of chronoAllMessages.value) {
    if (!item.future) {
      running += item.msg.tokens || 0
    }
    sums.push(running)
  }
  return sums
})

// Authoritative total for the entire context window (system + tools + messages).
// Used as the denominator for all percentage calculations so numbers match
// the Overview tab, DetailPane, and utilization displays.
const contextTotalTokens = computed(() => entry.value?.contextInfo.totalTokens ?? 0)

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

const focusedToolName = computed(() => store.messageFocusTool)
const focusedCategory = computed(() => store.messageFocusCategory)
const focusedFile = computed(() => store.messageFocusFile)

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

function onMessagesKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && detailOpen.value) {
    closeDetail()
    e.preventDefault()
    e.stopPropagation()
  }
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
  if (flatIdx >= 0) {
    // In category view, expand the category that contains this message
    if (viewMode.value === 'category') {
      const msg = messages.value[origIdx]
      if (msg) {
        const category = classifyMessageRole(msg)
        expand(category)
      }
    }
    openDetail(flatIdx)
  }
}

function chronoCategoryColor(msg: ParsedMessage): string {
  const cat = classifyMessageRole(msg)
  return (CATEGORY_META[cat] || { color: '#4b5563' }).color
}

function chronoCategoryLabel(msg: ParsedMessage): string {
  const cat = classifyMessageRole(msg)
  return (CATEGORY_META[cat] || { label: cat }).label
}

// Navigate to the turn that contains a future message (by its index in latestMessages)
function jumpToFutureMessage(msgIndex: number) {
  if (!session.value) return
  // Entries are newest-first. Find the earliest entry whose message count includes this index.
  const entries = session.value.entries
  // Walk from oldest to newest (reverse order) and find the first entry
  // whose message count is greater than msgIndex.
  let targetEntry: typeof entries[0] | null = null
  for (let i = entries.length - 1; i >= 0; i--) {
    const msgCount = entries[i].contextInfo.messages?.length ?? 0
    if (msgCount > msgIndex) {
      targetEntry = entries[i]
      break
    }
  }
  if (!targetEntry) {
    // Fall back to the latest entry
    targetEntry = entries[0]
  }
  store.pinEntry(targetEntry.id)
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
  // Snapshot focus state and clear immediately so it acts as a one-shot request.
  // This prevents stale focus from replaying on turn changes.
  const snapshotCategory = focusCategory.value
  const snapshotIndex = store.messageFocusIndex
  const snapshotOpenDetail = store.messageFocusOpenDetail
  const snapshotTool = store.messageFocusTool
  const snapshotFile = store.messageFocusFile
  store.clearMessageFocus()

  // Focus by message index (e.g. from security alert findings)
  const focusIdx = snapshotIndex
  if (focusIdx != null) {
    // In chrono mode, origIdx maps directly to position
    if (viewMode.value === 'chrono') {
      for (let attempt = 0; attempt < 4; attempt++) {
        await nextTick()
        openDetailByOrigIndex(focusIdx)
        await nextTick()
        const root = msgListEl.value
        if (root) {
          const rows = Array.from(root.querySelectorAll('.chrono-row')) as HTMLElement[]
          const target = rows.find(row => row.classList.contains('selected'))
          if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); return }
        }
      }
      return
    }
    // Category mode: retry loop
    for (let attempt = 0; attempt < 4; attempt++) {
      await nextTick()
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

  // Focus by file path: switch to chrono mode and apply file filter highlighting.
  // The reactive `focusedFile` drives the row dimming; we re-set it here
  // because clearMessageFocus() already wiped it above.
  if (snapshotFile) {
    store.messageFocusFile = snapshotFile
    viewMode.value = 'chrono'
    await nextTick()

    // Build the set of related message indices for this file
    const msgs = messages.value
    const fileToolIds = new Set<string>()
    for (const msg of msgs) {
      if (!msg.contentBlocks) continue
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_use') {
          const tb = block as ToolUseBlock
          const fp = extractToolFilePath(tb)
          if (fp === snapshotFile) fileToolIds.add(tb.id)
        }
      }
    }

    // Find the first tool_result for this file and scroll to it
    let firstRelatedIdx = -1
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      if (!msg.contentBlocks) continue
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_result' && fileToolIds.has(block.tool_use_id)) {
          firstRelatedIdx = i
          break
        }
        if (block.type === 'tool_use') {
          const tb = block as ToolUseBlock
          const fp = extractToolFilePath(tb)
          if (fp === snapshotFile && firstRelatedIdx < 0) {
            firstRelatedIdx = i
            break
          }
        }
      }
      if (firstRelatedIdx >= 0) break
    }

    if (firstRelatedIdx >= 0) {
      for (let attempt = 0; attempt < 4; attempt++) {
        await nextTick()
        const root = msgListEl.value
        if (!root) continue
        const rows = Array.from(root.querySelectorAll('.chrono-row')) as HTMLElement[]
        if (rows[firstRelatedIdx]) {
          rows[firstRelatedIdx].scrollIntoView({ block: 'center', behavior: 'smooth' })
          return
        }
      }
    }
    return
  }

  const category = snapshotCategory
  if (!category) return

  const shouldOpenDetail = snapshotOpenDetail

  // If openDetail is requested, switch to chrono mode and open the detail pane
  // Otherwise, switch to category mode to show all messages of that type
  if (shouldOpenDetail) {
    viewMode.value = 'chrono'
  } else {
    viewMode.value = 'category'
  }

  // In chrono mode, scroll to the latest message of the focused category
  if (viewMode.value === 'chrono') {
    for (let attempt = 0; attempt < 4; attempt++) {
      await nextTick()
      const root = msgListEl.value
      if (!root) continue
      const rows = Array.from(root.querySelectorAll('.chrono-row')) as HTMLElement[]
      // Find latest (last) row whose origIdx matches a message in the target category
      let lastMatchIdx = -1
      for (let i = messages.value.length - 1; i >= 0; i--) {
        if (classifyMessageRole(messages.value[i]) === category) {
          lastMatchIdx = i
          break
        }
      }
      if (lastMatchIdx >= 0 && rows[lastMatchIdx]) {
        rows[lastMatchIdx].scrollIntoView({ block: 'center', behavior: 'smooth' })
        // If openDetail is requested, open the detail pane for this message
        if (shouldOpenDetail) {
          await nextTick()
          openDetailByOrigIndex(lastMatchIdx)
        }
        return
      }
    }
    return
  }

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

  const focusTool = snapshotTool
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

function clearFileFilter() {
  store.clearMessageFocus()
}

/**
 * Build a set of message indices that relate to the focused file path.
 * A message is related if it contains a tool_use targeting that file,
 * or a tool_result whose corresponding tool_use targeted that file.
 */
const fileRelatedMessageIndices = computed((): Set<number> => {
  const file = focusedFile.value
  if (!file) return new Set()

  const msgs = messages.value
  const indices = new Set<number>()

  // Build a map of tool_use IDs that target the focused file
  const fileToolIds = new Set<string>()
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]
    if (!msg.contentBlocks) continue
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_use') {
        const tb = block as ToolUseBlock
        const filePath = extractToolFilePath(tb)
        if (filePath === file) {
          fileToolIds.add(tb.id)
          indices.add(i)
        }
      }
    }
  }

  // Find tool_result messages whose tool_use_id matches
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]
    if (!msg.contentBlocks) continue
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result' && fileToolIds.has(block.tool_use_id)) {
        indices.add(i)
      }
    }
  }

  return indices
})

/**
 * Extract a normalized file path from a tool_use block, or null.
 * Applies makeRelative using the session's working directory so paths
 * match the relative format used by the file attribution panel.
 *
 * When input is empty (compacted entries), falls back to parsing
 * the parent message's content string.
 */
function extractToolFilePath(block: ToolUseBlock): string | null {
  const input = block.input
  const wd = store.selectedSession?.workingDirectory
  if (input && typeof input === 'object') {
    for (const key of ['file_path', 'path', 'filePath']) {
      const val = input[key]
      if (typeof val === 'string' && val.length > 0) {
        let result = val.replace(/\/+/g, '/')
        if (result.startsWith('./')) result = result.slice(2)
        if (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1)
        return makeRelative(result, wd)
      }
    }
  }
  return null
}

function rowClassForFileFocus(origIdx: number): Record<string, boolean> {
  const file = focusedFile.value
  if (!file) return {}
  const related = fileRelatedMessageIndices.value
  return {
    'file-focused': related.has(origIdx),
    'file-muted': !related.has(origIdx),
  }
}

const focusedFileShortName = computed(() => {
  const file = focusedFile.value
  if (!file) return ''
  return shortFileName(file)
})

watch(
  () => store.messageFocusToken,
  async () => {
    await applyMessageFocus()
  },
  { immediate: true },
)

watch(
  () => store.inspectorTab,
  async (tab) => {
    if (tab === 'messages') await applyMessageFocus()
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

// Also load the latest entry's detail when pinned (for future messages in chrono view)
watch(
  () => latestEntry.value?.id,
  async (latestId) => {
    if (latestId != null && latestId !== entry.value?.id) {
      await store.loadEntryDetail(latestId)
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
  <div v-if="entry" class="messages-tab" @keydown="onMessagesKeydown">
    <Splitpanes class="default-theme" :push-other-panes="false">
      <Pane :min-size="25" :size="detailOpen ? 42 : 100">
        <div ref="msgListEl" class="msg-list">
          <div class="msg-toolbar">
            <div class="message-view-toggle">
              <button :class="{ on: viewMode === 'chrono' }" @click="viewMode = 'chrono'">Chronological</button>
              <button :class="{ on: viewMode === 'category' }" @click="viewMode = 'category'">By Category</button>
            </div>
            <div v-if="hasSubAgentEntries && viewMode === 'chrono'" class="message-view-toggle agent-toggle">
              <button :class="{ on: store.messagesMode === 'main' }" @click="store.messagesMode = 'main'">Main</button>
              <button :class="{ on: store.messagesMode === 'all' }" @click="store.messagesMode = 'all'">All</button>
            </div>
          </div>

          <template v-if="viewMode === 'category'">
          <div v-if="heaviestMessages.length > 0" class="heavy-strip">
            <div class="heavy-title">Top heavy messages</div>
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

          <div
            v-for="(group, catIdx) in categorized"
            :key="group.category"
            class="msg-group"
            :data-category="group.category"
          >
            <!-- Group header -->
            <div class="group-head" @click="toggle(group.category)">
              <i class="group-arrow" :class="(isExpanded(group.category) || focusCategory === group.category) ? 'i-carbon-chevron-down' : 'i-carbon-chevron-right'" />
              <span class="group-dot" :style="{ background: (CATEGORY_META[group.category] || { color: '#4b5563' }).color }" />
              <span class="group-name">{{ (CATEGORY_META[group.category] || { label: group.category }).label }}</span>
              <span class="group-stats">
                {{ group.items.length }}
                <span class="group-sep">·</span>
                {{ fmtTokens(group.tokens) }}
                <span class="group-sep">·</span>
                {{ contextTotalTokens > 0 ? Math.round(group.tokens / contextTotalTokens * 100) : 0 }}%
              </span>
              <div class="group-bar-track">
                <div
                  class="group-bar-fill"
                  :style="{
                    width: (contextTotalTokens > 0 ? Math.round(group.tokens / contextTotalTokens * 100) : 0) + '%',
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

          <template v-else-if="viewMode === 'chrono'">
            <div v-if="focusedFile" class="focus-strip">
              <span>
                Filtered file: <b class="focus-file-name" v-tooltip="focusedFile">{{ focusedFileShortName }}</b>
                <span class="focus-file-count">({{ fileRelatedMessageIndices.size }} messages)</span>
              </span>
              <button class="focus-clear" @click.stop="clearFileFilter">Show all</button>
            </div>
            <div class="chrono-list">
              <template v-for="(item, i) in chronoAllMessages" :key="i">
                <!-- Turn boundary marker -->
                <div v-if="chronoTurnNumbers.has(i)" class="chrono-turn-marker" :class="{ future: item.future }">
                  <span class="chrono-turn-label">Turn {{ chronoTurnNumbers.get(i) }}</span>
                  <span class="chrono-turn-line" />
                </div>

                <!-- Future separator (shown once, at the boundary) -->
                <div v-if="item.future && i === selectedMessageCount" class="chrono-future-sep">
                  <span class="chrono-future-line" />
                  <span class="chrono-future-label">After this turn</span>
                  <span class="chrono-future-line" />
                </div>

                <div
                  class="chrono-row"
                  :class="[
                    rowClassForFileFocus(item.origIdx),
                    {
                      selected: !item.future && detailOpen && flatMessages[detailIndex]?.origIdx === item.origIdx,
                      future: item.future,
                    },
                  ]"
                  :style="{ '--cat-border': chronoCategoryColor(item.msg) }"
                  @click="item.future ? jumpToFutureMessage(item.origIdx) : openDetail(item.origIdx)"
                >
                  <span
                    class="chrono-gutter"
                    v-tooltip="item.future ? 'Click to jump to this turn' : `Cumulative: ${fmtTokens(chronoCumTokens[i])} of ${fmtTokens(contextTotalTokens)}`"
                  >
                    {{ item.future ? '' : fmtTokens(chronoCumTokens[i]) }}
                  </span>
                  <span class="chrono-cat-dot" :style="{ background: chronoCategoryColor(item.msg) }" />
                  <span class="chrono-type">{{ chronoCategoryLabel(item.msg) }}</span>
                  <span class="chrono-preview">{{ extractPreview(item.msg, toolNameMap) || '(empty)' }}</span>
                  <span class="chrono-tok" :class="{ hot: !item.future && (item.msg.tokens || 0) > 2000 }">{{ fmtTokens(item.msg.tokens || 0) }}</span>
                </div>
              </template>
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

.msg-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 var(--space-4) var(--space-3);
}

.message-view-toggle {
  display: inline-flex;
  margin: 0;
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
  margin-bottom: var(--space-2);
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
  font-size: 10px;
  flex-shrink: 0;
  transition: transform 0.12s ease;
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
  pointer-events: none;
}

.msg-preview {
  @include truncate;
  @include sans-text;
  color: var(--text-dim);
  flex: 1;
  font-size: var(--text-sm);
  pointer-events: none;
}

.msg-tok {
  @include mono-text;
  color: var(--text-ghost);
  font-size: var(--text-xs);
  white-space: nowrap;
  flex-shrink: 0;
  pointer-events: none;

  &.hot { color: var(--accent-amber); }
}

// ── Chronological view ──
.chrono-list {
  display: flex;
  flex-direction: column;
}

.chrono-row {
  @include data-row;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px var(--space-3) 4px 0;
  font-size: var(--text-sm);
  border-left: 3px solid var(--cat-border, var(--border-dim));
  border-bottom: 1px solid rgba(28, 37, 53, 0.25);
  margin-left: var(--space-2);

  &:last-child { border-bottom: none; }

  &.future {
    opacity: 0.3;

    &:hover { opacity: 0.5; }
  }

  &.file-focused {
    background: rgba(59, 130, 246, 0.14);
    border-left-color: var(--accent-blue);
  }

  &.file-muted {
    opacity: 0.22;
  }
}

.chrono-gutter {
  @include mono-text;
  font-size: 9px;
  color: var(--text-ghost);
  width: 42px;
  text-align: right;
  flex-shrink: 0;
  padding-left: var(--space-2);
  cursor: help;
  transition: color 0.12s;

  .chrono-row:hover:not(.future) & {
    color: var(--text-dim);
  }
}

.chrono-cat-dot {
  width: 6px;
  height: 6px;
  border-radius: 1px;
  flex-shrink: 0;
}

.chrono-type {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);
  width: 90px;
  flex-shrink: 0;
  @include truncate;
}

.chrono-preview {
  @include truncate;
  @include sans-text;
  color: var(--text-dim);
  flex: 1;
  font-size: var(--text-sm);
  pointer-events: none;
}

.chrono-tok {
  @include mono-text;
  color: var(--text-ghost);
  font-size: var(--text-xs);
  white-space: nowrap;
  flex-shrink: 0;
  pointer-events: none;

  &.hot { color: var(--accent-amber); }
}

// ── Turn boundary markers ──
.chrono-turn-marker {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-3) 2px;
  margin-left: var(--space-2);

  &.future { opacity: 0.3; }
}

.chrono-turn-label {
  @include mono-text;
  font-size: 9px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
  flex-shrink: 0;
}

.chrono-turn-line {
  flex: 1;
  height: 1px;
  background: var(--border-dim);
  min-width: 0;
}

// ── Future messages separator ──
.chrono-future-sep {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  margin-left: var(--space-2);
}

.chrono-future-line {
  flex: 1;
  height: 1px;
  background: var(--accent-amber);
  opacity: 0.3;
}

.chrono-future-label {
  @include mono-text;
  font-size: 9px;
  font-weight: 600;
  color: var(--accent-amber);
  opacity: 0.6;
  white-space: nowrap;
  flex-shrink: 0;
}

.focus-file-name {
  @include mono-text;
  color: var(--accent-blue);
  font-weight: 600;
  cursor: help;
}

.focus-file-count {
  color: var(--text-ghost);
  font-size: var(--text-xs);
}

</style>
