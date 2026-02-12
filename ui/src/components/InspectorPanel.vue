<script setup lang="ts">
import { useSessionStore } from '@/stores/session'
import type { InspectorTab } from '@/stores/session'
import OverviewTab from '@/components/OverviewTab.vue'
import MessagesTab from '@/components/MessagesTab.vue'
import TimelineTab from '@/components/TimelineTab.vue'
import TurnScrubber from '@/components/TurnScrubber.vue'

const store = useSessionStore()

const tabs: { id: InspectorTab; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'i-carbon-dashboard' },
  { id: 'messages', label: 'Messages', icon: 'i-carbon-chat' },
  { id: 'timeline', label: 'Timeline', icon: 'i-carbon-activity' },
]

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    store.setView('dashboard')
  }
}
</script>

<template>
  <div class="inspector" @keydown="onKeydown" tabindex="-1">
    <!-- Scrubber above tabs: global temporal context -->
    <TurnScrubber />

    <!-- Tab bar -->
    <div class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab-btn"
        :class="{ active: store.inspectorTab === tab.id }"
        @click="store.setInspectorTab(tab.id)"
      >
        <i :class="tab.icon" />
        {{ tab.label }}
      </button>
    </div>

    <!-- Tab content -->
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
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-deep);
}

.tab-bar {
  display: flex;
  background: var(--bg-field);
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
  display: flex;
  align-items: center;
  gap: 6px;

  i { font-size: 14px; }

  &:hover { color: var(--text-secondary); }

  &.active {
    color: var(--accent-blue);
    border-bottom-color: var(--accent-blue);
  }

  &:focus-visible { @include focus-ring; }
}

.tab-content {
  width: 100%;
  min-width: 0;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  @include scrollbar-thin;
}
</style>
