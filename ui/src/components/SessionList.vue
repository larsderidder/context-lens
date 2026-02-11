<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useExpandable } from '@/composables/useExpandable'
import { fmtTokens, fmtCost, fmtTime, shortModel, sourceBadgeClass, modelColorClass } from '@/utils/format'
import { classifyEntries } from '@/utils/messages'
import type { ConversationGroup, ConversationSummary, ProjectedEntry, ParsedMessage } from '@/api-types'

const store = useSessionStore()
const { isExpanded, toggle } = useExpandable()
const sortMode = ref<'recent' | 'priority'>('recent')
const copiedSessionId = ref<string | null>(null)
const sessionScrollEl = ref<HTMLElement | null>(null)
const sidebarScrollBySessionKey = new Map<string, number>()
const hasLoadedOnce = ref(false)
const pulsingSessionIds = ref<Set<string>>(new Set())

interface SessionPriorityMeta {
  risk: number
  normalizedCost: number
  score: number
  label: 'Critical' | 'Warning' | 'Healthy'
  toneClass: 'priority-critical' | 'priority-warning' | 'priority-healthy'
  tooltip: string
}

function getSummary(c: ConversationGroup): ConversationSummary | undefined {
  return store.summaries.find(s => s.id === c.id)
}

function sessionTotalCost(c: ConversationGroup): number {
  const s = getSummary(c)
  if (s) return s.totalCost
  return c.entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0)
}

function sessionTotalTokens(c: ConversationGroup): number {
  const s = getSummary(c)
  if (s) return s.latestTotalTokens
  if (c.entries.length === 0) return 0
  return c.entries[0].contextInfo.totalTokens
}

function sessionModel(c: ConversationGroup): string {
  const s = getSummary(c)
  if (s) return s.latestModel
  return c.entries[0]?.contextInfo.model ?? ''
}

function sessionTimestamp(c: ConversationGroup): string {
  const s = getSummary(c)
  if (s) return s.latestTimestamp
  return c.entries[0]?.timestamp ?? ''
}

function sessionEntryCount(c: ConversationGroup): number {
  const s = getSummary(c)
  if (s) return s.entryCount
  return c.entries.length
}

function sessionHealthScore(c: ConversationGroup) {
  const s = getSummary(c)
  if (s) return s.healthScore
  return c.entries[0]?.healthScore ?? null
}

function sessionContextLimit(c: ConversationGroup): number {
  const s = getSummary(c)
  if (s) return s.contextLimit
  return c.entries[0]?.contextLimit ?? 0
}

function clamp01(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

const maxSessionCost = computed(() => {
  let max = 0
  for (const c of store.filteredConversations) {
    max = Math.max(max, sessionTotalCost(c))
  }
  return max
})

function getSessionPriorityMeta(c: ConversationGroup): SessionPriorityMeta {
  const health = sessionHealthScore(c)
  const healthRisk = health ? clamp01((100 - health.overall) / 100) : null
  const limit = sessionContextLimit(c)
  const utilizationRisk = limit ? clamp01(sessionTotalTokens(c) / limit) : 0
  const risk = healthRisk === null
    ? utilizationRisk
    : clamp01((healthRisk * 0.7) + (utilizationRisk * 0.3))

  const normalizedCost = maxSessionCost.value > 0
    ? clamp01(sessionTotalCost(c) / maxSessionCost.value)
    : 0
  const score = clamp01((risk * 0.7) + (normalizedCost * 0.3))

  let label: SessionPriorityMeta['label'] = 'Healthy'
  let toneClass: SessionPriorityMeta['toneClass'] = 'priority-healthy'
  if (score >= 0.7) {
    label = 'Critical'
    toneClass = 'priority-critical'
  } else if (score >= 0.45) {
    label = 'Warning'
    toneClass = 'priority-warning'
  }

  const tooltip = `Priority ${Math.round(score * 100)} = 0.7×risk(${Math.round(risk * 100)}) + 0.3×cost(${Math.round(normalizedCost * 100)}).`
  return { risk, normalizedCost, score, label, toneClass, tooltip }
}

const sessionPriorityMap = computed(() => {
  const map = new Map<string, SessionPriorityMeta>()
  for (const c of store.filteredConversations) {
    map.set(c.id, getSessionPriorityMeta(c))
  }
  return map
})

const sortedConversations = computed(() => {
  if (sortMode.value !== 'priority') return store.filteredConversations
  return [...store.filteredConversations].sort((a, b) => {
    const aScore = sessionPriorityMap.value.get(a.id)?.score ?? 0
    const bScore = sessionPriorityMap.value.get(b.id)?.score ?? 0
    if (bScore !== aScore) return bScore - aScore
    const aTime = a.entries[0]?.timestamp ? new Date(a.entries[0].timestamp).getTime() : 0
    const bTime = b.entries[0]?.timestamp ? new Date(b.entries[0].timestamp).getTime() : 0
    return bTime - aTime
  })
})

function sessionPriority(c: ConversationGroup): SessionPriorityMeta {
  return sessionPriorityMap.value.get(c.id) ?? {
    risk: 0,
    normalizedCost: 0,
    score: 0,
    label: 'Healthy',
    toneClass: 'priority-healthy',
    tooltip: 'Priority unavailable.',
  }
}

function handleSessionClick(c: ConversationGroup) {
  if (store.selectedSessionId === c.id) {
    store.selectTurn(0)
    toggle(c.id)
  } else {
    store.selectSession(c.id)
  }
}

function handleTurnClick(event: Event, sessionId: string, turnIndex: number) {
  event.stopPropagation()
  store.selectSession(sessionId)
  store.selectTurn(turnIndex)
}

function handleDelete(event: Event, id: string) {
  event.stopPropagation()
  store.deleteSession(id)
}

async function handleCopySessionId(event: Event, id: string) {
  event.stopPropagation()
  try {
    await navigator.clipboard.writeText(id)
    copiedSessionId.value = id
    setTimeout(() => {
      if (copiedSessionId.value === id) copiedSessionId.value = null
    }, 1400)
  } catch {
    copiedSessionId.value = null
  }
}

function buildToolNameMap(msgs: ParsedMessage[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const m of msgs) {
    for (const b of (m.contentBlocks || [])) {
      if (b.type === 'tool_use' && b.id && b.name) map[b.id] = b.name
    }
  }
  return map
}

function plainTextSummary(s: string, max = 40): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  // Suppress JSON-like strings (starts with [ or {)
  if (clean.startsWith('[') || clean.startsWith('{')) return ''
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

function callSummary(e: ProjectedEntry): string {
  const msgs = e.contextInfo.messages
  if (!msgs || msgs.length === 0) return ''

  const toolNameMap = buildToolNameMap(msgs)

  // Prefer latest tool call name with key parameter.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const blocks = msgs[i].contentBlocks || []
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.name) {
        const name = b.name
        // Show key parameter for common tools
        if (b.input && typeof b.input === 'object') {
          const inp = b.input as Record<string, any>
          if (name === 'bash' && inp.command) {
            const cmd = String(inp.command).replace(/\s+/g, ' ').trim()
            return `${name}: ${cmd.slice(0, 30)}${cmd.length > 30 ? '…' : ''}`
          }
          if ((name === 'read' || name === 'edit' || name === 'write') && inp.path) {
            const parts = String(inp.path).split('/')
            const filename = parts[parts.length - 1] || inp.path
            return `${name}: ${filename}`
          }
        }
        return name
      }
      if (b.type === 'tool_result' && b.tool_use_id && toolNameMap[b.tool_use_id]) {
        return toolNameMap[b.tool_use_id]
      }
    }
  }

  // Fallback: latest user plain text only.
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && msgs[i].content) {
      const text = plainTextSummary(msgs[i].content)
      if (text) return text
    }
  }
  return ''
}

function displayEntries(entries: ProjectedEntry[]): { entry: ProjectedEntry; isMain: boolean; originalIndex: number }[] {
  return classifyEntries(entries)
    .map((item, index) => ({ ...item, originalIndex: index }))
    .reverse()
}

function compactWorkingDir(path: string | null | undefined): string {
  if (!path) return ''
  if (/^\/home\/[^/]+(\/|$)/.test(path)) {
    return path.replace(/^\/home\/[^/]+/, '~')
  }
  if (/^\/Users\/[^/]+(\/|$)/.test(path)) {
    return path.replace(/^\/Users\/[^/]+/, '~')
  }
  return path
}

function sidebarScrollKey(sessionId: string | null | undefined): string {
  return sessionId || '__no_session__'
}

function handleSessionScroll() {
  if (!sessionScrollEl.value) return
  sidebarScrollBySessionKey.set(sidebarScrollKey(store.selectedSessionId), sessionScrollEl.value.scrollTop)
}

function restoreSessionScroll(sessionId: string | null | undefined) {
  nextTick(() => {
    if (!sessionScrollEl.value) return
    const key = sidebarScrollKey(sessionId)
    sessionScrollEl.value.scrollTop = sidebarScrollBySessionKey.get(key) ?? 0
  })
}

function triggerSessionPulse(id: string) {
  const next = new Set(pulsingSessionIds.value)
  next.add(id)
  pulsingSessionIds.value = next
  setTimeout(() => {
    const clear = new Set(pulsingSessionIds.value)
    clear.delete(id)
    pulsingSessionIds.value = clear
  }, 2200)
}

watch(
  () => store.selectedSessionId,
  (newId, oldId) => {
    if (sessionScrollEl.value && oldId !== undefined) {
      sidebarScrollBySessionKey.set(sidebarScrollKey(oldId), sessionScrollEl.value.scrollTop)
    }
    restoreSessionScroll(newId)
  },
  { immediate: true },
)

watch(
  () => store.summaries.map((s) => ({
    id: s.id,
    count: s.entryCount,
  })),
  (next, prev) => {
    if (!hasLoadedOnce.value) {
      hasLoadedOnce.value = true
      return
    }

    const prevMap = new Map((prev || []).map((item) => [item.id, item]))
    for (const item of next) {
      const old = prevMap.get(item.id)
      if (!old) continue
      if (old.count !== item.count) {
        triggerSessionPulse(item.id)
      }
    }
  },
)
</script>

<template>
  <div class="sidebar">
    <div class="sidebar-label">
      <span>Sessions</span>
      <select v-model="sortMode" class="sort-control" aria-label="Sort sessions">
        <option value="recent">Recent</option>
        <option value="priority">Priority</option>
      </select>
    </div>

    <div v-if="store.filteredConversations.length === 0" class="sidebar-empty">
      <span>Waiting for requests…</span>
    </div>

    <div ref="sessionScrollEl" class="session-scroll" @scroll.passive="handleSessionScroll">
      <div
        v-for="c in sortedConversations"
        :key="c.id"
        class="session-item"
        :class="{ active: c.id === store.selectedSessionId, pulse: pulsingSessionIds.has(c.id) }"
        @click="handleSessionClick(c)"
      >
        <div class="session-head">
          <span class="dot" :class="c.id === store.selectedSessionId ? 'dot-live' : 'dot-idle'" />
          <span class="badge" :class="sourceBadgeClass(c.source)">{{ c.source || '?' }}</span>
          <span class="session-model" :class="modelColorClass(sessionModel(c))">
            {{ shortModel(sessionModel(c)) }}
          </span>
          <button
            class="priority-badge"
            :class="sessionPriority(c).toneClass"
            type="button"
            :aria-label="sessionPriority(c).tooltip"
            v-tooltip="sessionPriority(c).tooltip"
            @click.stop
          >
            {{ sessionPriority(c).label }}
          </button>
          <button
            class="session-delete"
            type="button"
            aria-label="Delete session"
            @click="handleDelete($event, c.id)"
            v-tooltip="'Delete session'"
          >
            ×
          </button>
        </div>

        <div class="session-meta">
          <span>{{ sessionEntryCount(c) }} turns</span>
          <span class="mono">{{ fmtTokens(sessionTotalTokens(c)) }}</span>
          <span class="cost mono">{{ fmtCost(sessionTotalCost(c)) }}</span>
          <span v-if="sessionTimestamp(c)" class="mono">{{ fmtTime(sessionTimestamp(c)) }}</span>
        </div>

        <div v-if="c.workingDirectory" class="working-dir" :title="c.workingDirectory">
          {{ compactWorkingDir(c.workingDirectory) }}
        </div>

        <div class="session-id-row" :title="c.id">
          <span class="session-id-label">ID</span>
          <button
            class="session-id"
            :class="{ copied: copiedSessionId === c.id }"
            type="button"
            :aria-label="`Copy session ID ${c.id}`"
            @click="handleCopySessionId($event, c.id)"
          >
            <span class="mono">{{ c.id }}</span>
          </button>
          <span v-if="copiedSessionId === c.id" class="session-id-copied">Copied</span>
        </div>

        <!-- Turn list -->
        <div class="turn-group" :class="{ expanded: c.id === store.selectedSessionId && isExpanded(c.id) }">
          <div v-if="c.id === store.selectedSessionId && c.entries.length === 0 && store.loadingSession === c.id" class="tg-loading">
            Loading…
          </div>
          <template v-for="item in displayEntries(c.entries)" :key="item.entry.id">
            <div
              v-if="item.isMain"
              class="tg-item"
              :class="{ active: c.id === store.selectedSessionId && store.selectedTurnIndex === item.originalIndex }"
              @click="handleTurnClick($event, c.id, item.originalIndex)"
            >
              <span class="tg-num">{{ classifyEntries(c.entries).filter((x, i) => x.isMain && i <= item.originalIndex).length }}</span>
              <span class="tg-model" :class="modelColorClass(item.entry.contextInfo.model)">
                {{ shortModel(item.entry.contextInfo.model) }}
              </span>
              <span class="tg-desc">
                {{ callSummary(item.entry) || `Turn ${item.originalIndex + 1}` }}
              </span>
              <span class="tg-tokens">{{ fmtTokens(item.entry.contextInfo.totalTokens) }}</span>
            </div>
            <div v-else class="tg-sub">
              <span class="tg-sub-dot" />
              <span>{{ shortModel(item.entry.contextInfo.model) }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="sidebar-footer" v-if="store.conversations.length > 0">
      <div class="footer-row">
        <span>Sessions</span>
        <span>{{ store.filteredConversations.length }}</span>
      </div>
      <div class="footer-row">
        <span>Total</span>
        <span class="cost">{{ fmtCost(store.totalCost) }}</span>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.sidebar {
  background: var(--bg-field);
  border-right: 1px solid var(--border-dim);
  height: 100%;
  display: flex;
  flex-direction: column;
}

.sidebar-label {
  @include section-label;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--border-dim);
  flex-shrink: 0;
}

.sort-control {
  font-size: var(--text-xs);
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  color: var(--text-dim);
  border-radius: var(--radius-sm);
  padding: 2px 6px;
}

.sidebar-empty {
  padding: 24px 14px;
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-align: center;
}

.session-scroll {
  flex: 1;
  overflow-y: auto;
  @include scrollbar-thin;
}

.session-item {
  position: relative;
  padding: 10px 14px;
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background 0.1s, border-color 0.1s;

  &:hover { background: var(--bg-surface); }

  &.active {
    background: var(--accent-blue-dim);
    border-left-color: var(--accent-blue);
  }

  & + & { border-top: 1px solid var(--border-dim); }

  &.pulse::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    bottom: 0;
    border: 1px solid rgba(226, 232, 240, 0.18);
    background: rgba(226, 232, 240, 0.035);
    box-shadow: inset 0 0 0 1px rgba(226, 232, 240, 0.06), 0 0 10px rgba(226, 232, 240, 0.12);
    animation: session-pulse-block 2.2s ease-out;
    border-radius: 2px;
    pointer-events: none;
  }

  &.pulse::before {
    content: '';
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: -1px;
    height: 1px;
    background: rgba(248, 250, 252, 0.58);
    box-shadow: 0 0 6px rgba(248, 250, 252, 0.3);
    animation: session-pulse-divider 2.2s ease-out;
    pointer-events: none;
  }
}

@keyframes session-pulse-block {
  0% { opacity: 0; transform: scale(1); }
  18% { opacity: 1; transform: scale(1.0035); }
  100% { opacity: 0; transform: scale(1); }
}

@keyframes session-pulse-divider {
  0% { opacity: 0; }
  20% { opacity: 1; }
  100% { opacity: 0; }
}

.session-head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.session-delete {
  margin-left: 0;
  font-size: 14px;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  background: none;
  border: none;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s;
  padding: 2px 4px;

  .session-item:hover & { opacity: 0.5; }
  &:hover { opacity: 1 !important; color: var(--accent-red); }
}

.session-model {
  @include mono-text;
  @include truncate;
  font-size: var(--text-sm);
}

.priority-badge {
  @include mono-text;
  margin-left: auto;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  line-height: 1.6;
  border: 1px solid transparent;
  cursor: help;
  background: transparent;
}

.priority-critical {
  color: #fca5a5;
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
}

.priority-warning {
  color: #fcd34d;
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.3);
}

.priority-healthy {
  color: #86efac;
  background: rgba(16, 185, 129, 0.1);
  border-color: rgba(16, 185, 129, 0.3);
}

.session-meta {
  display: flex;
  gap: 10px;
  margin-top: 5px;
  padding-left: 13px;
  font-size: var(--text-xs);
  color: var(--text-dim);

  .mono { @include mono-text; }
  .cost { color: var(--accent-green); }
}

.working-dir {
  @include mono-text;
  @include truncate;
  font-size: var(--text-sm);
  color: var(--text-dim);
  margin-top: 4px;
  padding-left: 13px;
}

.session-id-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  padding-left: 13px;
  min-width: 0;
}

.session-id-label {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-ghost);
}

.session-id {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  flex: 1;
  background: none;
  border: none;
  padding: 0;
  text-align: left;
  cursor: pointer;
  @include truncate;
  font-size: var(--text-xs);
  color: var(--text-muted);
  transition: color 0.15s;

  &:hover {
    color: var(--text-primary);
  }

  &.copied {
    color: var(--accent-green);
  }
}

.session-id-copied {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--accent-green);
  flex-shrink: 0;
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}

.dot-live {
  background: var(--accent-blue);
  box-shadow: 0 0 5px var(--accent-blue);
}

.dot-idle { background: var(--text-ghost); }

.badge { @include badge(var(--bg-raised), var(--text-dim)); }
.badge-claude { @include badge(rgba(251, 146, 60, 0.10), #fb923c); }
.badge-codex { @include badge(rgba(52, 211, 153, 0.10), #34d399); }
.badge-aider { @include badge(rgba(96, 165, 250, 0.10), #60a5fa); }
.badge-kimi { @include badge(rgba(167, 139, 250, 0.10), #a78bfa); }
.badge-unknown { @include badge(var(--bg-raised), var(--text-dim)); }

.model-opus { color: #fb923c; }
.model-sonnet { color: #60a5fa; }
.model-haiku { color: #a78bfa; }
.model-gpt { color: #10b981; }
.model-gemini { color: #22d3ee; }
.model-default { color: var(--text-dim); }

.turn-group {
  margin-left: 13px;
  border-left: 1px solid var(--border-dim);
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.25s ease-out;

  &.expanded {
    max-height: 300px;
    overflow-y: auto;
    @include scrollbar-thin;
    transition: max-height 0.3s ease-in;
  }
}

.tg-loading {
  padding: 8px 10px;
  font-size: var(--text-xs);
  color: var(--text-ghost);
  @include mono-text;
}

.tg-item {
  @include data-row;
  padding: 5px 10px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--text-sm);
  min-height: 28px;
}

.tg-num {
  @include mono-text;
  color: var(--text-ghost);
  width: 14px;
  text-align: right;
  font-size: var(--text-xs);
}

.tg-model {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 1px 4px;
  border-radius: 2px;
  background: var(--bg-raised);
}

.tg-desc {
  @include truncate;
  color: var(--text-secondary);
  flex: 1;
  font-size: var(--text-sm);
}

.tg-tokens {
  @include mono-text;
  margin-left: auto;
  color: var(--text-ghost);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.tg-sub {
  display: flex;
  gap: 4px;
  padding: 3px 10px 3px 36px;
  font-size: var(--text-xs);
  color: var(--text-muted);
  align-items: center;
}

.tg-sub-dot {
  width: 4px;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--accent-purple);
  opacity: 0.5;
}

.sidebar-footer {
  padding: 10px 14px;
  border-top: 1px solid var(--border-dim);
  margin-top: auto;
  background: var(--bg-surface);
  flex-shrink: 0;
}

.footer-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: var(--text-sm);

  span:first-child { color: var(--text-dim); }
  span:last-child { color: var(--text-secondary); font-weight: 500; }

  .cost { color: var(--accent-green); }
}
</style>
