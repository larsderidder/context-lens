<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Splitpanes, Pane } from 'splitpanes'
import 'splitpanes/dist/splitpanes.css'
import { useSessionStore } from '@/stores/session'
import { useSSE } from '@/composables/useSSE'
import AppToolbar from '@/components/AppToolbar.vue'
import SessionList from '@/components/SessionList.vue'
import InspectorPanel from '@/components/InspectorPanel.vue'
import EmptyState from '@/components/EmptyState.vue'

const store = useSessionStore()
const splitpanesReady = ref(false)

const { connected } = useSSE('/api/events', (event) => {
  store.handleSSEEvent(event)
})

watch(connected, (val) => {
  store.connected = val
})

onMounted(() => {
  store.initializeDensity()
  store.load()
  requestAnimationFrame(() => {
    splitpanesReady.value = true
  })
})
</script>

<template>
  <div class="app">
    <AppToolbar />

    <div class="app-body">
      <Splitpanes v-show="splitpanesReady" class="default-theme">
        <Pane :size="18" :min-size="12" :max-size="30">
          <SessionList />
        </Pane>
        <Pane :min-size="30">
          <InspectorPanel v-if="store.selectedSession" />
          <EmptyState v-else />
        </Pane>
      </Splitpanes>
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
</style>
