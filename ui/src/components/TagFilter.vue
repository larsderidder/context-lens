<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const showDropdown = ref(false)

const hasTags = computed(() => store.allTags.length > 0)
const activeTag = computed(() => store.tagFilter)

const buttonLabel = computed(() => {
  if (activeTag.value) return `Tag: ${activeTag.value}`
  return 'Tag'
})

function selectTag(tag: string) {
  store.setTagFilter(tag)
  showDropdown.value = false
}

function clearFilter() {
  store.clearTagFilter()
  showDropdown.value = false
}

function toggleDropdown() {
  showDropdown.value = !showDropdown.value
  if (showDropdown.value) {
    store.loadTags()
  }
}
</script>

<template>
  <div class="tag-filter">
    <button
      class="filter-btn"
      :class="{ active: activeTag }"
      @click="toggleDropdown"
    >
      {{ buttonLabel }}
      <i class="i-carbon-chevron-down dropdown-icon" :class="{ open: showDropdown }" />
    </button>

    <Transition name="dropdown">
      <div v-if="showDropdown" class="dropdown-menu" @mouseleave="showDropdown = false">
        <div v-if="store.loadingTags" class="dropdown-loading">
          Loading...
        </div>
        <template v-else-if="hasTags">
          <button
            class="dropdown-item"
            :class="{ active: !activeTag }"
            @click="clearFilter"
          >
            <span class="all-label">All sessions</span>
          </button>
          <div class="dropdown-sep" />
          <button
            v-for="(tag, i) in store.allTags"
            :key="tag.name"
            class="dropdown-item"
            :class="{ active: activeTag === tag.name }"
            @click="selectTag(tag.name)"
          >
            <span class="tag-dot" :class="store.getTagColorClass(i)" />
            <span class="tag-name">{{ tag.name }}</span>
            <span class="tag-count">{{ tag.count }}</span>
          </button>
        </template>
        <div v-else class="dropdown-empty">
          No tags yet
        </div>
      </div>
    </Transition>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.tag-filter {
  position: relative;
}

.filter-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: var(--text-xs);
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;

  &:hover {
    border-color: var(--border-mid);
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  &.active {
    border-color: var(--accent-blue);
    color: var(--accent-blue);
    background: var(--accent-blue-dim);
  }

  &:focus-visible { @include focus-ring; }
}

.dropdown-icon {
  font-size: 10px;
  transition: transform 0.15s;

  &.open {
    transform: rotate(180deg);
  }
}

.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 160px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--bg-raised);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-md);
  padding: var(--space-1);
  z-index: 30;
  box-shadow: var(--shadow-lg);
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
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

  &.active {
    background: var(--accent-blue-dim);
    color: var(--accent-blue);
  }
}

.all-label {
  flex: 1;
}

.tag-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tag-name {
  flex: 1;
  text-transform: lowercase;
}

.tag-count {
  color: var(--text-muted);
  font-size: 10px;
}

.dropdown-sep {
  height: 1px;
  background: var(--border-dim);
  margin: var(--space-1) 0;
}

.dropdown-loading,
.dropdown-empty {
  padding: 10px;
  font-size: var(--text-xs);
  color: var(--text-muted);
  text-align: center;
}

// Position-based tag colors
.tag-dot {
  &.tag-color-0 { background: var(--accent-blue); }
  &.tag-color-1 { background: var(--accent-green); }
  &.tag-color-2 { background: var(--accent-amber); }
  &.tag-color-3 { background: var(--accent-purple); }
  &.tag-color-4 { background: var(--accent-red); }
  &.tag-color-5 { background: #06b6d4; }
  &.tag-color-6 { background: #ec4899; }
  &.tag-color-7 { background: #84cc16; }
}

// Transition
.dropdown-enter-active { transition: opacity 0.12s, transform 0.12s; }
.dropdown-leave-active { transition: opacity 0.08s, transform 0.08s; }
.dropdown-enter-from,
.dropdown-leave-to { opacity: 0; transform: translateY(-4px); }

// Accessibility
@media (prefers-reduced-motion: reduce) {
  .dropdown-enter-active,
  .dropdown-leave-active { transition: none; }
}
</style>
