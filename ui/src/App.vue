<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, computed } from 'vue'
import { useSessionStore } from '@/stores/session'
import type { InspectorTab } from '@/stores/session'
import { useSSE } from '@/composables/useSSE'
import { classifyEntries } from '@/utils/messages'
import AppToolbar from '@/components/AppToolbar.vue'
import DashboardView from '@/components/DashboardView.vue'
import InspectorPanel from '@/components/InspectorPanel.vue'
import SessionRail from '@/components/SessionRail.vue'
import EmptyState from '@/components/EmptyState.vue'
import type { ConversationGroup, ProjectedEntry } from '@/api-types'

const store = useSessionStore()
const syncingFromHash = ref(false)
const appReady = ref(false)
const HASH_SESSIONS = '#sessions'
const INSPECTOR_TABS: readonly InspectorTab[] = ['overview', 'messages', 'timeline']
let refreshInterval: ReturnType<typeof setInterval> | null = null

// Track navigation direction for slide transitions
const lastView = ref<'dashboard' | 'inspector' | 'empty' | null>(null)
const viewTransitionName = computed(() => {
  const current = store.view
  const previous = lastView.value
  
  // No previous state = instant (initial render or page load)
  if (previous === null) {
    return 'view-instant'
  }
  
  // Dashboard → Inspector = slide forward (inspector slides in from right)
  if (previous === 'dashboard' && current === 'inspector') {
    return 'view-slide-forward'
  }
  // Inspector → Dashboard = slide back (dashboard zooms in, inspector out to right)
  if (previous === 'inspector' && current === 'dashboard') {
    return 'view-slide-back'
  }
  // Default: no transition (same view or unknown transition)
  return 'view-instant'
})

watch(() => store.view, (newView, oldView) => {
  // Track previous view for transition direction
  if (lastView.value !== null) {
    lastView.value = oldView
  } else {
    // First run: set to current so next change has a baseline
    lastView.value = newView
  }
})

const { connected } = useSSE('/api/events', (event) => {
  store.handleSSEEvent(event)
})

watch(connected, (val) => {
  store.connected = val
})

interface ParsedHashRoute {
  sessionId: string | null
  tab: InspectorTab | null
  turn: number | null
}

function parseHashRoute(hash: string): ParsedHashRoute {
  const match = hash.match(/^#session\/([^?]+)(?:\?(.*))?$/)
  if (!match) return { sessionId: null, tab: null, turn: null }

  const decoded = decodeURIComponent(match[1]).trim()
  const sessionId = decoded || null
  if (!sessionId) return { sessionId: null, tab: null, turn: null }

  const params = new URLSearchParams(match[2] ?? '')

  const tabRaw = params.get('tab')
  const tab = tabRaw && INSPECTOR_TABS.includes(tabRaw as InspectorTab)
    ? (tabRaw as InspectorTab)
    : null

  const turnRaw = params.get('turn')
  const parsedTurn = turnRaw ? Number.parseInt(turnRaw, 10) : NaN
  const turn = Number.isFinite(parsedTurn) && parsedTurn > 0 ? parsedTurn : null

  return { sessionId, tab, turn }
}

function getMainEntriesOldestFirst(session: ConversationGroup): ProjectedEntry[] {
  return classifyEntries([...session.entries].reverse())
    .filter((item) => item.isMain)
    .map((item) => item.entry)
}

function selectedNonLatestTurnNumber(): number | null {
  if (store.selectionMode !== 'pinned') return null
  const session = store.selectedSession
  if (!session) return null
  const mainEntries = getMainEntriesOldestFirst(session)
  if (mainEntries.length === 0) return null
  const selectedId = store.selectedEntryId
  if (selectedId == null) return null
  const turnIndex = mainEntries.findIndex((entry) => entry.id === selectedId)
  if (turnIndex < 0) return null
  const turnNumber = turnIndex + 1
  return turnNumber < mainEntries.length ? turnNumber : null
}

async function applyHashRoute() {
  syncingFromHash.value = true
  try {
    const hash = window.location.hash || ''
    const { sessionId, tab, turn } = parseHashRoute(hash)

    if (sessionId) {
      const exists = store.summaries.some(s => s.id === sessionId)
      if (!exists) {
        store.setView('dashboard')
        return
      }
      await store.selectSession(sessionId)
      if (tab) {
        store.setInspectorTab(tab)
      }
      if (turn != null && store.selectedSession) {
        const mainEntries = getMainEntriesOldestFirst(store.selectedSession)
        if (mainEntries.length > 0) {
          const clamped = Math.min(Math.max(turn, 1), mainEntries.length)
          if (clamped < mainEntries.length) {
            store.pinEntry(mainEntries[clamped - 1].id)
          } else {
            store.followLive()
          }
        } else {
          store.followLive()
        }
      } else {
        store.followLive()
      }
      store.setView('inspector')
      return
    }

    store.setView('dashboard')
  } finally {
    syncingFromHash.value = false
  }
}

function syncHashFromStore() {
  if (syncingFromHash.value) return
  let desired = HASH_SESSIONS
  if (store.view === 'inspector' && store.selectedSessionId) {
    const params = new URLSearchParams()
    params.set('tab', store.inspectorTab)
    const nonLatestTurn = selectedNonLatestTurnNumber()
    if (nonLatestTurn != null) {
      params.set('turn', String(nonLatestTurn))
    }
    const query = params.toString()
    desired = `#session/${encodeURIComponent(store.selectedSessionId)}${query ? `?${query}` : ''}`
  }
  if (window.location.hash !== desired) {
    window.location.hash = desired
  }
}

function onHashChange() {
  applyHashRoute()
}

watch(
  () => [
    store.view,
    store.selectedSessionId,
    store.inspectorTab,
    store.selectionMode,
    store.selectedEntryId,
    store.selectedSession?.entries.length,
  ] as const,
  () => {
    syncHashFromStore()
  },
)

onMounted(async () => {
  try {
    store.initializeDensity()
    await store.load()
    if (!window.location.hash) {
      window.location.hash = HASH_SESSIONS
    }
    await applyHashRoute()
    window.addEventListener('hashchange', onHashChange)

    // Periodic refresh to catch any missed SSE events or handle disconnections
    refreshInterval = setInterval(() => {
      if (!document.hidden) {
        store.load()
      }
    }, 5000) // Refresh every 5 seconds when tab is visible
  } finally {
    appReady.value = true
  }
})

onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange)
  if (refreshInterval) {
    clearInterval(refreshInterval)
    refreshInterval = null
  }
})
</script>

<template>
  <div class="app">
    <AppToolbar />
    <div class="app-body">
      <div v-if="!appReady" class="app-loading">
        <div class="loading-spinner"></div>
      </div>
      <template v-else>
      <!-- Session rail: transitions in/out with inspector view -->
      <Transition name="rail-slide">
        <SessionRail v-if="store.view === 'inspector'" />
      </Transition>
      
      <!-- Main content area with transitions -->
      <div class="main-content">
        <Transition :name="viewTransitionName">
          <DashboardView v-if="store.view === 'dashboard'" key="dashboard" />
          <div v-else-if="store.view === 'inspector'" key="inspector" class="inspector-content">
            <InspectorPanel v-if="store.selectedSession" />
            <div v-else class="loading-placeholder">
              <div class="loading-spinner"></div>
            </div>
          </div>
          <EmptyState v-else key="empty" />
        </Transition>
      </div>
      </template>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.app {
  display: grid;
  grid-template-rows: 44px 1fr;
  height: 100vh;
  overflow: hidden;
}

.app-body {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: row;
}

.app-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-deep);
}

.main-content {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.inspector-content {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.loading-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-deep);
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-dim);
  border-top-color: var(--accent-blue);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

// ── View transitions: directional slides ──

// Forward: Dashboard → Inspector (inspector slides in from right)
.view-slide-forward-enter-active {
  transition: transform 0.28s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              opacity 0.22s ease;
}

.view-slide-forward-leave-active {
  display: none;
}

.view-slide-forward-enter-from {
  transform: translateX(100%);
  opacity: 0;
}

// Back: Inspector → Dashboard (inspector slides out right, dashboard appears instantly underneath)
.view-slide-back-enter-active {
  transition: none;
}

.view-slide-back-leave-active {
  position: absolute;
  inset: 0;
  z-index: 1;
  transition: transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              opacity 0.18s ease;
}

.view-slide-back-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

// Instant (no animation for other transitions)
.view-instant-enter-active,
.view-instant-leave-active {
  transition: none;
}

// ── SessionRail slide transition ──
.rail-slide-enter-active {
  transition: transform 0.28s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              opacity 0.22s ease;
}

.rail-slide-leave-active {
  transition: transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              opacity 0.2s ease;
}

.rail-slide-enter-from {
  transform: translateX(-100%);
  opacity: 0;
}

.rail-slide-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}

// Respect reduced motion preference
@media (prefers-reduced-motion: reduce) {
  .view-slide-forward-enter-active,
  .view-slide-forward-leave-active,
  .view-slide-back-enter-active,
  .view-slide-back-leave-active,
  .rail-slide-enter-active,
  .rail-slide-leave-active {
    transition-duration: 0.01ms !important;
  }
}
</style>
