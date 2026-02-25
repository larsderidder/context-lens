<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useSessionStore } from '@/stores/session'
import { fmtCost, shortModel, sourceBadgeClass } from '@/utils/format'
import { getExportUrl } from '@/api'
import TagEditor from '@/components/TagEditor.vue'

const showTagEditor = ref(false)
const toolbarTagsEl = ref<HTMLElement>()

function toggleTagEditor() {
  showTagEditor.value = !showTagEditor.value
  if (showTagEditor.value) {
    store.loadTags()
  }
}

function closeTagEditor() {
  showTagEditor.value = false
}

function onDocClick(e: MouseEvent) {
  if (showTagEditor.value && toolbarTagsEl.value && !toolbarTagsEl.value.contains(e.target as Node)) {
    closeTagEditor()
  }
}

onMounted(() => document.addEventListener('click', onDocClick, true))
onUnmounted(() => document.removeEventListener('click', onDocClick, true))

// Close tag editor when switching sessions
watch(() => store.selectedSessionId, () => { showTagEditor.value = false })

const store = useSessionStore()
const showExportMenu = ref(false)
const showResetMenu = ref(false)
const sessionIdCopied = ref(false)

const isInspector = computed(() => store.view === 'inspector' && !!store.selectedSession)

const session = computed(() => store.selectedSession)
const hasRequests = computed(() => store.totalRequests > 0)
const canRemoveSession = computed(() => isInspector.value && !!store.selectedSessionId)

const summary = computed(() => {
  const id = store.selectedSessionId
  if (!id) return null
  return store.summaries.find(s => s.id === id) ?? null
})

function compactDir(path: string | null | undefined): string {
  if (!path) return ''
  let p = path
  if (/^\/home\/[^/]+(\/|$)/.test(p)) p = p.replace(/^\/home\/[^/]+/, '~')
  else if (/^\/Users\/[^/]+(\/|$)/.test(p)) p = p.replace(/^\/Users\/[^/]+/, '~')
  const parts = p.split('/')
  if (parts.length > 3) return parts.slice(-3).join('/')
  return p
}

const selectedSessionId = computed(() => store.selectedSessionId ?? '')

function safeFilenamePart(input: string): string {
  return String(input || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown'
}

function buildExportFilename(
  format: 'lhar' | 'lhar.json',
  conversationId: string | undefined,
): string {
  const ext = format === 'lhar' ? 'lhar' : 'lhar.json'
  const sessionPart = `session-${safeFilenamePart(conversationId || 'all')}`
  const privacyPart = 'privacy-standard'
  return `context-lens-export-${sessionPart}-${privacyPart}.${ext}`
}

async function downloadWithFilename(url: string, filename: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

async function handleExport(format: 'lhar' | 'lhar.json', scope: 'all' | 'session') {
  const convoId = scope === 'session' ? store.selectedSessionId ?? undefined : undefined
  const url = getExportUrl(format, convoId)
  const filename = buildExportFilename(format, convoId)
  try {
    await downloadWithFilename(url, filename)
  } catch {
    window.open(url, '_blank')
  }
  showExportMenu.value = false
}

function toggleExportMenu() {
  showExportMenu.value = !showExportMenu.value
  if (showExportMenu.value) showResetMenu.value = false
}

function toggleResetMenu() {
  showResetMenu.value = !showResetMenu.value
  if (showResetMenu.value) showExportMenu.value = false
}

function handleReset() {
  if (confirm('Clear all captured data?')) {
    store.reset()
  }
  showResetMenu.value = false
}

function handleRemoveSession() {
  const id = store.selectedSessionId
  if (!id || !canRemoveSession.value) return
  if (confirm('Remove this session?')) {
    store.deleteSession(id)
  }
  showResetMenu.value = false
}

function goBack() {
  store.setView('dashboard')
}

async function copySessionId() {
  const id = selectedSessionId.value
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
    sessionIdCopied.value = true
  } catch {}
  setTimeout(() => { sessionIdCopied.value = false }, 1400)
}

function sessionIdDisplay(id: string): string {
  if (id.length <= 18) return id
  return `${id.slice(0, 8)}…${id.slice(-8)}`
}

function sessionIdTitle(id: string): string {
  if (sessionIdCopied.value) return `Copied: ${id}`
  return `Session ID: ${id} (click to copy)`
}

function onSessionIdKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    copySessionId()
  }
}
</script>

<template>
  <header class="toolbar">
    <!-- ═══ Left: brand or back + session context ═══ -->
    <a class="toolbar-brand toolbar-brand-btn" href="#sessions" @click.prevent="goBack">
      <svg class="logo-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--accent-blue)" stroke-width="1" opacity="0.35" />
        <circle cx="9" cy="9" r="4" fill="none" stroke="var(--accent-blue)" stroke-width="1" opacity="0.6" />
        <circle cx="9" cy="9" r="1.5" fill="var(--accent-blue)" />
      </svg>
      <span class="brand-text">Context Lens</span>
    </a>

    <Transition name="session-ctx">
    <div v-if="isInspector && session" class="session-ctx">
      <span class="toolbar-sep"></span>

      <span class="session-badge" :class="sourceBadgeClass(session.source)">{{ session.source || '?' }}</span>
      <span class="session-model">{{ shortModel(summary?.latestModel ?? '') }}</span>
      <span v-if="session.workingDirectory" class="session-dir" :title="session.workingDirectory">
        {{ compactDir(session.workingDirectory) }}
      </span>
      <span class="toolbar-sep"></span>
      <span
        v-if="selectedSessionId"
        class="session-id"
        :class="{ copied: sessionIdCopied }"
        :title="sessionIdTitle(selectedSessionId)"
        role="button"
        tabindex="0"
        :aria-label="sessionIdTitle(selectedSessionId)"
        @click="copySessionId"
        @keydown="onSessionIdKeydown"
      >
        SID {{ sessionIdDisplay(selectedSessionId) }}
        <span v-if="sessionIdCopied" class="session-id-toast">Copied</span>
      </span>
      <span v-if="selectedSessionId" class="toolbar-sep"></span>
      <span class="session-stat">{{ summary?.entryCount ?? session.entries.length }} turns</span>
      <span class="session-stat cost">{{ fmtCost(summary?.totalCost ?? 0) }}</span>
      <span v-if="summary?.healthScore" class="session-stat">
        Latest health <span class="session-health" :class="{
          good: summary.healthScore.rating === 'good',
          warn: summary.healthScore.rating === 'needs-work',
          bad: summary.healthScore.rating === 'poor',
        }">{{ summary.healthScore.overall }}</span>
      </span>
      <span class="toolbar-sep"></span>
      <!-- Tags: compact pill summary, click to open full editor -->
      <div v-if="selectedSessionId" ref="toolbarTagsEl" class="toolbar-tags" @click.stop>
        <button
          class="tags-toggle"
          :class="{ active: showTagEditor, tagged: (session.tags ?? []).length > 0 }"
          :title="showTagEditor ? 'Close tag editor' : 'Edit tags'"
          @click="toggleTagEditor"
        >
          <i class="i-carbon-tag" />
          <template v-if="(session.tags ?? []).length === 0">
            Tags
          </template>
          <template v-else>
            <span
              v-for="(tag, i) in (session.tags ?? []).slice(0, 2)"
              :key="tag"
              class="toolbar-tag-pill"
              :class="`tag-color-${i % 8}`"
            >{{ tag }}</span>
            <span v-if="(session.tags ?? []).length > 2" class="toolbar-tag-overflow">
              +{{ (session.tags ?? []).length - 2 }}
            </span>
          </template>
        </button>

        <Transition name="tag-popover">
          <div v-if="showTagEditor" class="tag-popover">
            <TagEditor
              :conversation-id="selectedSessionId"
              :tags="session.tags ?? []"
            />
          </div>
        </Transition>
      </div>
    </div>
    </Transition>

    <template v-if="store.compareMode">
      <span class="toolbar-sep"></span>
      <span class="compare-label">
        <i class="i-carbon-compare" />
        Comparing {{ store.compareSessionIds.size }} sessions
      </span>
      <button class="compare-exit-btn" @click="store.exitCompare()">
        <i class="i-carbon-close" /> Exit
      </button>
    </template>

    <!-- ═══ Right: global controls ═══ -->
    <div class="toolbar-right">
      <span class="connection" :class="{ live: store.connected }">
        <span class="connection-dot" />
        {{ store.connected ? 'Live' : 'Offline' }}
      </span>

      <!-- Dashboard-mode stats -->
      <template v-if="!isInspector">
        <span class="toolbar-stat">
          {{ store.conversations.length }} session{{ store.conversations.length !== 1 ? 's' : '' }}
        </span>

        <span class="toolbar-stat">
          {{ store.totalRequests }} req{{ store.totalRequests !== 1 ? 's' : '' }}
        </span>

        <span class="toolbar-stat cost">
          {{ fmtCost(store.totalCost) }}
        </span>
      </template>

      <div v-if="hasRequests" class="toolbar-dropdown">
        <button class="toolbar-control" @click="toggleExportMenu">
          <i class="i-carbon-download" /> Export
        </button>
        <Transition name="dropdown">
          <div v-if="showExportMenu" class="dropdown-menu" @mouseleave="showExportMenu = false">
            <button class="dropdown-item" @click="handleExport('lhar.json', 'all')"><i class="i-carbon-document" /> All (.lhar.json)</button>
            <button class="dropdown-item" @click="handleExport('lhar', 'all')"><i class="i-carbon-document" /> All (.lhar)</button>
            <template v-if="store.selectedSessionId">
              <div class="dropdown-sep" />
              <button class="dropdown-item" @click="handleExport('lhar.json', 'session')"><i class="i-carbon-document" /> Session (.lhar.json)</button>
              <button class="dropdown-item" @click="handleExport('lhar', 'session')"><i class="i-carbon-document" /> Session (.lhar)</button>
            </template>
          </div>
        </Transition>
      </div>

      <div v-if="hasRequests" class="toolbar-dropdown">
        <button class="toolbar-control" @click="toggleResetMenu">
          <i class="i-carbon-overflow-menu-horizontal" /> Menu
        </button>
        <Transition name="dropdown">
          <div v-if="showResetMenu" class="dropdown-menu" @mouseleave="showResetMenu = false">
            <button class="dropdown-item dropdown-item--danger" @click="handleReset">
              <i class="i-carbon-trash-can" /> Reset all
            </button>
            <button
              class="dropdown-item dropdown-item--danger"
              :class="{ 'dropdown-item--disabled': !canRemoveSession }"
              :disabled="!canRemoveSession"
              @click="handleRemoveSession"
            >
              <i class="i-carbon-subtract-alt" /> Remove this session
            </button>
          </div>
        </Transition>
      </div>
    </div>
  </header>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

// ── Session context fade-in ──
.session-ctx {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.session-ctx-enter-active {
  transition: opacity 0.2s ease 0.12s;
}

.session-ctx-leave-active {
  transition: opacity 0.1s ease;
  // Keep it from taking space during leave so layout doesn't jump
  position: absolute;
  pointer-events: none;
}

.session-ctx-enter-from,
.session-ctx-leave-to {
  opacity: 0;
}

.toolbar {
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
  display: flex;
  align-items: center;
  padding: 0 var(--space-4);
  gap: var(--space-2);
  z-index: 20;
  height: 44px;
}

.toolbar-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  user-select: none;
  flex-shrink: 0;
}

.toolbar-brand-btn {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  text-decoration: none;

  &:hover .brand-text { color: var(--accent-blue); }
  &:focus-visible { @include focus-ring; }
}

.brand-text {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

// ── Separator ──
.toolbar-sep {
  width: 1px;
  height: 16px;
  background: var(--border-dim);
  margin: 0 var(--space-1);
  flex-shrink: 0;
}

// ── Session context (inspector mode) ──
.session-badge {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 2px 5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  border-radius: var(--radius-sm);
  line-height: 1.4;
  flex-shrink: 0;
}

// Badge colors
.badge-claude { background: rgba(251, 146, 60, 0.15); color: #fb923c; }
.badge-codex { background: rgba(52, 211, 153, 0.15); color: #34d399; }
.badge-aider { background: rgba(14, 165, 233, 0.15); color: var(--accent-blue); }
.badge-opencode { background: rgba(139, 92, 246, 0.15); color: #8b5cf6; }
.badge-kimi { background: rgba(167, 139, 250, 0.15); color: var(--accent-purple); }
.badge-pi { background: rgba(167, 139, 250, 0.15); color: var(--accent-purple); }
.badge-gemini { background: rgba(74, 144, 226, 0.15); color: #4a90e2; }
.badge-unknown { background: var(--bg-raised); color: var(--text-dim); }

.session-model {
  @include mono-text;
  font-size: var(--text-sm);
  color: var(--text-dim);
  flex-shrink: 0;
}

.session-dir {
  @include mono-text;
  @include truncate;
  font-size: var(--text-sm);
  color: var(--text-muted);
  max-width: 220px;
}

.session-stat {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);
  flex-shrink: 0;

  &.cost { color: var(--accent-green); }
}

.session-health {
  font-weight: 700;
  &.good { color: var(--accent-green); }
  &.warn { color: var(--accent-amber); }
  &.bad { color: var(--accent-red); }
}

.session-id {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  transition: color 0.12s;
  text-decoration: underline dotted transparent;
  text-underline-offset: 2px;
  user-select: all;
  position: relative;

  &:hover {
    color: var(--text-secondary);
    text-decoration-color: var(--text-ghost);
  }

  &.copied {
    color: var(--accent-green);
    text-decoration-color: rgba(16, 185, 129, 0.5);
  }

  &:focus-visible { @include focus-ring; }
}

.session-id-toast {
  position: absolute;
  top: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  @include mono-text;
  font-size: 10px;
  line-height: 1;
  color: var(--text-primary);
  background: var(--bg-raised);
  border: 1px solid rgba(16, 185, 129, 0.35);
  border-radius: var(--radius-sm);
  padding: 3px 5px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 5;
}

// ── Tags in toolbar ──
.toolbar-tags {
  position: relative;
  flex-shrink: 0;
}

.tags-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  font-size: var(--text-xs);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.12s, background 0.12s;
  white-space: nowrap;

  &:hover {
    color: var(--text-secondary);
    background: var(--bg-raised);
  }

  // When active (popover open), show a subtle highlight
  &.active {
    color: var(--accent-blue);
    background: var(--accent-blue-dim);
    outline: none;
  }

  &:focus-visible {
    @include focus-ring;
  }

  // When tags are present the icon is dimmer — the pills carry the identity
  &.tagged .i-carbon-tag {
    opacity: 0.45;
  }
}

.toolbar-tag-pill {
  @include mono-text;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 2px;
  text-transform: lowercase;
  background: var(--bg-raised);
  color: var(--text-secondary);

  &.tag-color-0 { background: var(--accent-blue-dim);          color: var(--accent-blue); }
  &.tag-color-1 { background: rgba(16,  185, 129, 0.15);       color: var(--accent-green); }
  &.tag-color-2 { background: var(--accent-amber-dim);         color: var(--accent-amber); }
  &.tag-color-3 { background: rgba(139,  92, 246, 0.15);       color: var(--accent-purple); }
  &.tag-color-4 { background: var(--accent-red-dim);           color: var(--accent-red); }
  &.tag-color-5 { background: rgba(  6, 182, 212, 0.15);       color: #06b6d4; }
  &.tag-color-6 { background: rgba(236,  72, 153, 0.15);       color: #ec4899; }
  &.tag-color-7 { background: rgba(132, 204,  22, 0.15);       color: #84cc16; }
}

.toolbar-tag-overflow {
  font-size: 10px;
  color: var(--text-muted);
}

.tag-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  background: var(--bg-raised);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  z-index: 50;
  box-shadow: var(--shadow-lg);
  min-width: 200px;
}

.tag-popover-enter-active { transition: opacity 0.12s, transform 0.1s; }
.tag-popover-leave-active { transition: opacity 0.08s, transform 0.08s; }
.tag-popover-enter-from,
.tag-popover-leave-to { opacity: 0; transform: translateY(-4px); }

// ── Right side ──
.toolbar-right {
  margin-left: auto;
  display: flex;
  gap: var(--space-3);
  align-items: center;
  flex-shrink: 0;
}

.connection {
  display: flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-muted);

  &.live { color: var(--text-dim); }
}

.connection-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent-red);
  transition: background 0.3s, box-shadow 0.3s;

  .connection.live & {
    background: var(--accent-green);
    box-shadow: 0 0 5px var(--accent-green);
  }
}

.toolbar-stat {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);

  &.cost { color: var(--accent-green); font-weight: 600; }
}

.toolbar-control {
  font-size: var(--text-xs);
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  color: var(--text-secondary);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 4px;

  i { font-size: 12px; }

  &:hover {
    border-color: var(--border-mid);
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  &:focus-visible { @include focus-ring; }
}

.toolbar-control--danger {
  &:hover {
    border-color: var(--accent-red);
    color: var(--accent-red);
  }
}

.toolbar-dropdown { position: relative; }

.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  background: var(--bg-raised);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-md);
  padding: var(--space-1);
  z-index: 30;
  min-width: 170px;
  box-shadow: var(--shadow-lg);
}

.dropdown-sep {
  height: 1px;
  background: var(--border-dim);
  margin: var(--space-1) 0;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  transition: background 0.1s, color 0.1s;

  i { font-size: 12px; color: var(--text-muted); }

  &:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  &:disabled {
    cursor: default;
  }
}

.dropdown-item--danger {
  &:hover {
    color: var(--accent-red);
  }
}

.dropdown-item--disabled {
  color: var(--text-ghost);

  i {
    color: var(--text-ghost);
  }

  &:hover {
    background: none;
    color: var(--text-ghost);
  }
}

.dropdown-enter-active { transition: opacity 0.12s, transform 0.12s; }
.dropdown-leave-active { transition: opacity 0.08s, transform 0.08s; }
.dropdown-enter-from,
.dropdown-leave-to { opacity: 0; transform: translateY(-4px); }

// ── Compare mode ──
.compare-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-sm);
  color: var(--accent-blue);
  white-space: nowrap;
}

.compare-exit-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-muted);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: color 0.1s, border-color 0.1s;

  &:hover {
    color: var(--text-secondary);
    border-color: var(--border-mid);
  }
}
</style>
