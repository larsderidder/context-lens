<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, computed } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useSSE } from '@/composables/useSSE'
import AppToolbar from '@/components/AppToolbar.vue'
import DashboardView from '@/components/DashboardView.vue'
import InspectorPanel from '@/components/InspectorPanel.vue'
import SessionRail from '@/components/SessionRail.vue'
import EmptyState from '@/components/EmptyState.vue'

const store = useSessionStore()
const syncingFromHash = ref(false)
const appReady = ref(false)
const HASH_SESSIONS = '#sessions'
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

function parseSessionIdFromHash(hash: string): string | null {
  const match = hash.match(/^#session\/(.+)$/)
  if (!match) return null
  const decoded = decodeURIComponent(match[1]).trim()
  return decoded || null
}

async function applyHashRoute() {
  syncingFromHash.value = true
  try {
    const hash = window.location.hash || ''
    const sessionId = parseSessionIdFromHash(hash)

    if (sessionId) {
      const exists = store.summaries.some(s => s.id === sessionId)
      if (!exists) {
        store.setView('dashboard')
        return
      }
      await store.selectSession(sessionId)
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
  const desired = store.view === 'inspector' && store.selectedSessionId
    ? `#session/${encodeURIComponent(store.selectedSessionId)}`
    : HASH_SESSIONS
  if (window.location.hash !== desired) {
    window.location.hash = desired
  }
}

function onHashChange() {
  applyHashRoute()
}

watch(
  () => [store.view, store.selectedSessionId] as const,
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
        <Transition :name="viewTransitionName" mode="out-in">
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
  transition: transform 0.22s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              opacity 0.18s ease;
}

.view-slide-forward-enter-from {
  transform: translateX(100%);
  opacity: 0;
}

.view-slide-forward-leave-to {
  transform: translateX(-20%);
  opacity: 0;
}

// Back: Inspector → Dashboard (dashboard zooms/fades in, inspector slides out right)
.view-slide-back-enter-active {
  transition: transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              opacity 0.2s ease;
}

.view-slide-back-leave-active {
  transition: transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              opacity 0.18s ease;
}

.view-slide-back-enter-from {
  transform: scale(0.96);
  opacity: 0;
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
