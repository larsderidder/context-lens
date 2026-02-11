<script setup lang="ts">
import { useSessionStore } from '@/stores/session'
import type { InspectorTab } from '@/stores/session'
import OverviewTab from '@/components/OverviewTab.vue'
import MessagesTab from '@/components/MessagesTab.vue'
import TimelineTab from '@/components/TimelineTab.vue'

const store = useSessionStore()

const tabs: { id: InspectorTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'messages', label: 'Messages' },
  { id: 'timeline', label: 'Timeline' },
]
</script>

<template>
  <div class="inspector">
    <div class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab-btn"
        :class="{ active: store.inspectorTab === tab.id }"
        @click="store.setInspectorTab(tab.id)"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="tab-content">
      <OverviewTab v-if="store.inspectorTab === 'overview'" />
      <MessagesTab v-else-if="store.inspectorTab === 'messages'" />
      <TimelineTab v-else-if="store.inspectorTab === 'timeline'" />
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.inspector {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-deep);
}

.tab-bar {
  display: flex;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
  flex-shrink: 0;
}

.tab-btn {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-muted);
  padding: 10px 18px;
  cursor: pointer;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  transition: color 0.12s, border-color 0.12s;

  &:hover { color: var(--text-secondary); }

  &.active {
    color: var(--accent-blue);
    border-bottom-color: var(--accent-blue);
  }

  &:focus-visible { @include focus-ring; }
}

.tab-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  @include scrollbar-thin;
}
</style>
