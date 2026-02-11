<script setup lang="ts">
import { useSessionStore } from '@/stores/session'
import type { DensityMode } from '@/stores/session'
import { fmtCost } from '@/utils/format'
import { getExportUrl } from '@/api'
import { ref } from 'vue'

const store = useSessionStore()
const showExportMenu = ref(false)

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

function changeDensity(mode: DensityMode) {
  store.setDensity(mode)
}
</script>

<template>
  <header class="toolbar">
    <div class="toolbar-brand">
      <svg class="logo-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--accent-blue)" stroke-width="1" opacity="0.35" />
        <circle cx="9" cy="9" r="4" fill="none" stroke="var(--accent-blue)" stroke-width="1" opacity="0.6" />
        <circle cx="9" cy="9" r="1.5" fill="var(--accent-blue)" />
      </svg>
      <span class="brand-text">Context Lens</span>
    </div>

    <div class="toolbar-right">
      <span class="connection" :class="{ live: store.connected }">
        <span class="connection-dot" />
        {{ store.connected ? 'Live' : 'Offline' }}
      </span>

      <span class="toolbar-stat">
        {{ store.conversations.length }} session{{ store.conversations.length !== 1 ? 's' : '' }}
      </span>

      <span class="toolbar-stat">
        {{ store.totalRequests }} req{{ store.totalRequests !== 1 ? 's' : '' }}
      </span>

      <span class="toolbar-stat cost">
        {{ fmtCost(store.totalCost) }}
      </span>

      <div class="density-toggle" role="group" aria-label="Density mode">
        <button
          class="density-btn"
          :class="{ active: store.density === 'comfortable' }"
          @click="changeDensity('comfortable')"
        >
          Comfortable
        </button>
        <button
          class="density-btn"
          :class="{ active: store.density === 'compact' }"
          @click="changeDensity('compact')"
        >
          Compact
        </button>
      </div>

      <select
        v-if="store.sources.length > 1"
        :value="store.sourceFilter"
        class="toolbar-control"
        @change="store.setSourceFilter(($event.target as HTMLSelectElement).value)"
      >
        <option value="">All sources</option>
        <option v-for="s in store.sources" :key="s" :value="s">{{ s }}</option>
      </select>

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
  gap: var(--space-4);
  z-index: 20;
}

.toolbar-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  user-select: none;
}

.brand-text {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: -0.01em;
}

.toolbar-right {
  margin-left: auto;
  display: flex;
  gap: var(--space-3);
  align-items: center;
}

.connection {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--text-xs);
  color: var(--text-muted);

  &.live { color: var(--text-dim); }
}

.connection-dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--accent-red);
  transition: background 0.3s, box-shadow 0.3s;

  .connection.live & {
    background: var(--accent-green);
    box-shadow: 0 0 4px var(--accent-green);
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

.toolbar-control--danger:hover {
  border-color: var(--accent-red);
  color: var(--accent-red);
}

.density-toggle {
  display: flex;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.density-btn {
  font-size: var(--text-xs);
  background: var(--bg-raised);
  border: none;
  color: var(--text-muted);
  padding: 4px 8px;
  cursor: pointer;

  & + & {
    border-left: 1px solid var(--border-dim);
  }

  &:hover {
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  &.active {
    color: var(--accent-blue);
    background: var(--accent-blue-dim);
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
