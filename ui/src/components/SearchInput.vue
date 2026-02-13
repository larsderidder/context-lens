<script setup lang="ts">
/**
 * Inline search/filter input.
 *
 * Follows the vue-devtools VueInput pattern: flat style, left icon,
 * optional clear button, subtle focus animation on the bottom edge.
 */
import { ref, watchEffect } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  autoFocus?: boolean
}>(), {
  placeholder: 'Search…',
  autoFocus: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const focused = ref(false)
const inputRef = ref<HTMLInputElement>()

function clear() {
  emit('update:modelValue', '')
  inputRef.value?.focus()
}

function onEscape() {
  if (props.modelValue) {
    emit('update:modelValue', '')
  } else {
    inputRef.value?.blur()
  }
}

watchEffect(() => {
  if (props.autoFocus) {
    inputRef.value?.focus()
  }
})
</script>

<template>
  <div
    class="search-input-root"
    :class="{ focused, active: modelValue.length > 0 }"
    @click="inputRef?.focus()"
  >
    <i class="i-carbon-search search-input-icon" />
    <input
      ref="inputRef"
      :value="modelValue"
      type="text"
      class="search-input-field"
      :placeholder="placeholder"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @focus="focused = true"
      @blur="focused = false"
      @keydown.escape="onEscape"
    />
    <button
      v-if="modelValue.length > 0"
      class="search-input-clear"
      tabindex="-1"
      title="Clear"
      @click.stop="clear"
    ><i class="i-carbon-close" /></button>

    <!-- Focus accent bar (vue-devtools style) -->
    <div class="search-input-accent" />
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.search-input-root {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  padding: 0 8px;
  height: 26px;
  min-width: 100px;
  max-width: 280px;
  flex: 1;
  overflow: hidden;
  cursor: text;
  transition: border-color 0.15s, background 0.15s;

  &:hover { border-color: var(--border-mid); }

  &.focused {
    border-color: var(--accent-blue);
    background: var(--bg-field);
  }

  &.active:not(.focused) {
    border-color: rgba(14, 165, 233, 0.35);
  }
}

.search-input-icon {
  font-size: 12px;
  color: var(--text-ghost);
  flex-shrink: 0;
  transition: color 0.15s;

  .search-input-root.focused &,
  .search-input-root.active & {
    color: var(--accent-blue);
  }
}

.search-input-field {
  @include mono-text;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  background: none;
  border: none;
  outline: none;
  width: 100%;
  padding: 0;
  line-height: 24px;

  &::placeholder {
    color: var(--text-ghost);
    font-weight: 400;
  }
}

.search-input-clear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: var(--bg-raised);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  font-size: 10px;
  transition: color 0.1s, background 0.1s;

  &:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }
}

// Bottom accent line, mimicking vue-devtools VueInput focus animation
.search-input-accent {
  position: absolute;
  bottom: 0;
  left: 50%;
  right: 50%;
  height: 1.5px;
  background: var(--accent-blue);
  opacity: 0;
  pointer-events: none;
  transition: left 0.2s ease, right 0.2s ease, opacity 0.2s ease;

  .search-input-root.focused & {
    left: 0;
    right: 0;
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .search-input-accent { transition: none; }
}
</style>
