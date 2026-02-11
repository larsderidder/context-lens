<script setup lang="ts">
import { useSessionStore } from '@/stores/session'
import { fmtCost } from '@/utils/format'

const store = useSessionStore()
</script>

<template>
  <footer class="status-bar">
    <span class="status-item" v-if="store.totalCost > 0">
      <span class="cost">{{ fmtCost(store.totalCost) }}</span>
    </span>
    <span class="status-sep" v-if="store.totalCost > 0" />
    <span class="status-item">
      {{ store.totalRequests }} req{{ store.totalRequests !== 1 ? 's' : '' }}
    </span>
    <span class="status-sep" />
    <span class="status-item">
      {{ store.conversations.length }} session{{ store.conversations.length !== 1 ? 's' : '' }}
    </span>
    <span class="status-right">
      <span class="status-dot" :class="{ live: store.connected }" />
      {{ store.connected ? 'Live' : 'Disconnected' }}
    </span>
  </footer>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.status-bar {
  background: var(--bg-surface);
  border-top: 1px solid var(--border-dim);
  display: flex;
  align-items: center;
  padding: 0 var(--space-3);
  gap: 0;
  @include mono-text;
  font-size: 9px;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.status-item {
  padding: 0 var(--space-2);
}

.status-sep {
  width: 1px;
  height: 10px;
  background: var(--border-dim);
}

.cost { color: var(--accent-green); font-weight: 600; }

.status-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 var(--space-2);
}

.status-dot {
  width: 4px;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--accent-red);
  transition: background 0.3s;

  &.live {
    background: var(--accent-green);
    box-shadow: 0 0 3px var(--accent-green);
  }
}
</style>
