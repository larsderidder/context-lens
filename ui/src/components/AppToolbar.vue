<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSessionStore } from '@/stores/session'
import { fmtCost, shortModel, sourceBadgeClass } from '@/utils/format'
import { getExportUrl } from '@/api'

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
    <button class="toolbar-brand toolbar-brand-btn" @click="goBack">
      <svg class="logo-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--accent-blue)" stroke-width="1" opacity="0.35" />
        <circle cx="9" cy="9" r="4" fill="none" stroke="var(--accent-blue)" stroke-width="1" opacity="0.6" />
        <circle cx="9" cy="9" r="1.5" fill="var(--accent-blue)" />
      </svg>
      <span class="brand-text">Context Lens</span>
    </button>

    <template v-if="isInspector && session">
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
.badge-kimi { background: rgba(167, 139, 250, 0.15); color: var(--accent-purple); }
.badge-pi { background: rgba(167, 139, 250, 0.15); color: var(--accent-purple); }
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
</style>
