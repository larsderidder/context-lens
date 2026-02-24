<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useSessionStore } from '@/stores/session'

const props = defineProps<{
  conversationId: string
  tags: string[]
}>()

const store = useSessionStore()
const isEditing = ref(false)
const inputValue = ref('')
const inputRef = ref<HTMLInputElement>()
const selectedIndex = ref(-1)

const allTagNames = computed(() => store.allTags.map(t => t.name))
const availableTags = computed(() => {
  const current = new Set(props.tags)
  return allTagNames.value.filter(t => !current.has(t))
})

const filteredSuggestions = computed(() => {
  const query = inputValue.value.trim().toLowerCase()
  if (!query) return availableTags.value.slice(0, 5)
  return availableTags.value
    .filter(t => t.includes(query))
    .slice(0, 5)
})

const inputNormalized = computed(() => inputValue.value.trim().toLowerCase())

const showCreateOption = computed(() => {
  if (!inputNormalized.value) return false
  // Don't show "Create" if it already exists in this session or in suggestions
  if (props.tags.includes(inputNormalized.value)) return false
  if (filteredSuggestions.value.includes(inputNormalized.value)) return false
  return true
})

const showSuggestions = computed(() =>
  isEditing.value && (filteredSuggestions.value.length > 0 || showCreateOption.value)
)

watch(isEditing, (editing) => {
  if (editing) {
    store.loadTags()
    nextTick(() => inputRef.value?.focus())
  } else {
    inputValue.value = ''
    selectedIndex.value = -1
  }
})

const suggestionCount = computed(() =>
  filteredSuggestions.value.length + (showCreateOption.value ? 1 : 0)
)

function startEditing() {
  isEditing.value = true
}

function stopEditing() {
  isEditing.value = false
}

async function addTag(tag: string) {
  const normalized = tag.trim().toLowerCase()
  if (!normalized) return
  if (props.tags.includes(normalized)) {
    inputValue.value = ''
    return
  }
  await store.addTagToSession(props.conversationId, normalized)
  inputValue.value = ''
  selectedIndex.value = -1
}

async function removeTag(tag: string) {
  await store.removeTagFromSession(props.conversationId, tag)
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    if (selectedIndex.value >= 0 && selectedIndex.value < filteredSuggestions.value.length) {
      addTag(filteredSuggestions.value[selectedIndex.value])
    } else if (inputValue.value.trim()) {
      addTag(inputValue.value)
    }
  } else if (e.key === 'Escape') {
    stopEditing()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, suggestionCount.value - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, -1)
  } else if (e.key === 'Backspace' && !inputValue.value && props.tags.length > 0) {
    removeTag(props.tags[props.tags.length - 1])
  }
}

function onBlur() {
  // Delay to allow clicking on suggestions
  setTimeout(() => {
    if (!inputValue.value.trim()) {
      stopEditing()
    }
  }, 150)
}
</script>

<template>
  <div class="tag-editor">
    <div class="tag-list">
      <span
        v-for="(tag, i) in tags"
        :key="tag"
        class="tag-pill"
        :class="`tag-color-${i % 8}`"
      >
        {{ tag }}
        <button
          class="tag-remove"
          title="Remove tag"
          @click.stop="removeTag(tag)"
        >
          <i class="i-carbon-close" />
        </button>
      </span>

      <button
        v-if="!isEditing"
        class="add-btn"
        title="Add tag"
        @click="startEditing"
      >
        <i class="i-carbon-add" />
      </button>

      <div v-else class="input-wrap">
        <input
          ref="inputRef"
          v-model="inputValue"
          type="text"
          class="tag-input"
          placeholder="tag..."
          @keydown="onInputKeydown"
          @blur="onBlur"
        />
        <div v-if="showSuggestions" class="suggestions">
          <div
            v-for="(suggestion, i) in filteredSuggestions"
            :key="suggestion"
            class="suggestion"
            :class="{ selected: i === selectedIndex }"
            @mousedown.prevent="addTag(suggestion)"
          >
            {{ suggestion }}
          </div>
          <div
            v-if="showCreateOption"
            class="suggestion new-tag"
            :class="{ selected: selectedIndex === filteredSuggestions.length }"
            @mousedown.prevent="addTag(inputValue)"
          >
            Create "{{ inputNormalized }}"
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.tag-editor {
  display: flex;
  align-items: center;
}

.tag-list {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.tag-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  font-size: 11px;
  border-radius: var(--radius-sm);
  text-transform: lowercase;
  background: var(--bg-raised);
  color: var(--text-secondary);
}

.tag-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  padding: 0;
  margin-left: 2px;
  background: none;
  border: none;
  border-radius: 2px;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  font-size: 8px;

  &:hover {
    opacity: 1;
    background: rgba(0, 0, 0, 0.1);
  }
}

.add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  background: var(--bg-raised);
  border: 1px dashed var(--border-mid);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 10px;

  &:hover {
    border-color: var(--accent-blue);
    color: var(--accent-blue);
    background: var(--accent-blue-dim);
  }
}

.input-wrap {
  position: relative;
}

.tag-input {
  @include mono-text;
  width: 80px;
  padding: 2px 6px;
  font-size: 11px;
  background: var(--bg-field);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  outline: none;

  &:focus {
    border-color: var(--accent-blue);
  }

  &::placeholder {
    color: var(--text-ghost);
  }
}

.suggestions {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  min-width: 120px;
  max-height: 150px;
  overflow-y: auto;
  background: var(--bg-raised);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-sm);
  padding: 2px;
  z-index: 100;
  box-shadow: var(--shadow-lg);
}

.suggestion {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  text-transform: lowercase;

  &:hover,
  &.selected {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  &.new-tag {
    color: var(--accent-blue);
    border-top: 1px solid var(--border-dim);
    margin-top: 2px;
    padding-top: 4px;
  }
}

// Position-based tag colors (index 0-7, cycles)
// Using pill style: dim background + matching text
.tag-color-0 { background: var(--accent-blue-dim);          color: var(--accent-blue); }
.tag-color-1 { background: rgba(16,  185, 129, 0.15);       color: var(--accent-green); }
.tag-color-2 { background: var(--accent-amber-dim);         color: var(--accent-amber); }
.tag-color-3 { background: rgba(139,  92, 246, 0.15);       color: var(--accent-purple); }
.tag-color-4 { background: var(--accent-red-dim);           color: var(--accent-red); }
.tag-color-5 { background: rgba(  6, 182, 212, 0.15);       color: #06b6d4; }
.tag-color-6 { background: rgba(236,  72, 153, 0.15);       color: #ec4899; }
.tag-color-7 { background: rgba(132, 204,  22, 0.15);       color: #84cc16; }
</style>
