<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useSSE } from '@/composables/useSSE'
import AppToolbar from '@/components/AppToolbar.vue'
import DashboardView from '@/components/DashboardView.vue'
import InspectorPanel from '@/components/InspectorPanel.vue'
import SessionRail from '@/components/SessionRail.vue'
import EmptyState from '@/components/EmptyState.vue'

const store = useSessionStore()
const syncingFromHash = ref(false)
const HASH_SESSIONS = '#sessions'
let refreshInterval: ReturnType<typeof setInterval> | null = null

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
      <DashboardView v-if="store.view === 'dashboard'" />
      <div v-else-if="store.view === 'inspector' && store.selectedSession" class="inspector-layout">
        <SessionRail />
        <InspectorPanel />
      </div>
      <EmptyState v-else />
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
}

.inspector-layout {
  display: flex;
  height: 100%;
  min-height: 0;
}
</style>
