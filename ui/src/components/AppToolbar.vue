<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session'
import { fmtCost, shortModel, sourceBadgeClass } from '@/utils/format'
import { getExportUrl } from '@/api'
import { ref } from 'vue'

const store = useSessionStore()
const showExportMenu = ref(false)

const isInspector = computed(() => store.view === 'inspector' && !!store.selectedSession)

const session = computed(() => store.selectedSession)

const summary = computed(() => {
  if (!session.value) return null
  return store.summaries.find(s => s.id === session.value!.id) ?? null
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

function handleExport(format: 'lhar' | 'lhar.json', scope: 'all' | 'session') {
  const convoId = scope === 'session' ? store.selectedSessionId ?? undefined : undefined
  const url = getExportUrl(format, convoId)
  window.open(url, '_blank')
  showExportMenu.value = false
}

function handleReset() {
  if (confirm('Clear all captured data?')) {
    store.reset()
  }
}

function goBack() {
  store.setView('dashboard')
}
</script>

<template>
  <header class="toolbar">
    <!-- ═══ Left: brand or back + session context ═══ -->
    <template v-if="isInspector && session">
      <div class="toolbar-brand">
        <svg class="logo-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--accent-blue)" stroke-width="1" opacity="0.35" />
          <circle cx="9" cy="9" r="4" fill="none" stroke="var(--accent-blue)" stroke-width="1" opacity="0.6" />
          <circle cx="9" cy="9" r="1.5" fill="var(--accent-blue)" />
        </svg>
        <span class="brand-text">Context Lens</span>
      </div>

      <span class="toolbar-sep"></span>

      <span class="session-badge" :class="sourceBadgeClass(session.source)">{{ session.source || '?' }}</span>
      <span class="session-model">{{ shortModel(summary?.latestModel ?? '') }}</span>
      <span v-if="session.workingDirectory" class="session-dir" :title="session.workingDirectory">
        {{ compactDir(session.workingDirectory) }}
      </span>
      <span class="toolbar-sep"></span>
      <span class="session-stat">{{ summary?.entryCount ?? session.entries.length }} turns</span>
      <span class="session-stat cost">{{ fmtCost(summary?.totalCost ?? 0) }}</span>
      <span v-if="summary?.healthScore" class="session-stat">
        Health <span class="session-health" :class="{
          good: summary.healthScore.rating === 'good',
          warn: summary.healthScore.rating === 'needs-work',
          bad: summary.healthScore.rating === 'poor',
        }">{{ summary.healthScore.overall }}</span>
      </span>
    </template>

    <template v-else>
      <div class="toolbar-brand">
        <svg class="logo-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--accent-blue)" stroke-width="1" opacity="0.35" />
          <circle cx="9" cy="9" r="4" fill="none" stroke="var(--accent-blue)" stroke-width="1" opacity="0.6" />
          <circle cx="9" cy="9" r="1.5" fill="var(--accent-blue)" />
        </svg>
        <span class="brand-text">Context Lens</span>
      </div>
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

      <div class="toolbar-dropdown" v-if="store.totalRequests > 0">
        <button class="toolbar-control" @click="showExportMenu = !showExportMenu">
          Export
        </button>
        <Transition name="dropdown">
          <div v-if="showExportMenu" class="dropdown-menu" @mouseleave="showExportMenu = false">
            <button class="dropdown-item" @click="handleExport('lhar.json', 'all')">All (.lhar.json)</button>
            <button class="dropdown-item" @click="handleExport('lhar', 'all')">All (.lhar)</button>
            <template v-if="store.selectedSessionId">
              <div class="dropdown-sep" />
              <button class="dropdown-item" @click="handleExport('lhar.json', 'session')">Session (.lhar.json)</button>
              <button class="dropdown-item" @click="handleExport('lhar', 'session')">Session (.lhar)</button>
            </template>
          </div>
        </Transition>
      </div>

      <button
        v-if="store.totalRequests > 0"
        class="toolbar-control toolbar-control--danger"
        @click="handleReset"
      >
        Reset
      </button>
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
  display: block;
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

  &:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
}

.dropdown-enter-active { transition: opacity 0.12s, transform 0.12s; }
.dropdown-leave-active { transition: opacity 0.08s, transform 0.08s; }
.dropdown-enter-from,
.dropdown-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
