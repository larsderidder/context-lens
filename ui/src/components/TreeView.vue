<script setup lang="ts">
import { computed } from 'vue'

export interface TreeNode {
  id: string
  label: string
  meta?: string
  color?: string
  selected?: boolean
  selectable?: boolean
  payload?: Record<string, unknown>
  children?: TreeNode[]
}

const props = withDefaults(defineProps<{
  nodes: TreeNode[]
  depth?: number
  isExpanded?: (id: string) => boolean
}>(), {
  depth: 0,
})

const emit = defineEmits<{
  toggle: [id: string]
  select: [node: TreeNode]
}>()

function hasChildren(node: TreeNode): boolean {
  return !!node.children && node.children.length > 0
}

function expanded(node: TreeNode): boolean {
  return props.isExpanded ? props.isExpanded(node.id) : false
}

function onToggle(id: string) {
  emit('toggle', id)
}

function onSelect(node: TreeNode) {
  emit('select', node)
}

const depthPadding = computed(() => `${(props.depth || 0) * 14 + 6}px`)
</script>

<template>
  <div class="tree-level" :style="{ '--pad-left': depthPadding }">
    <div
      v-for="node in nodes"
      :key="node.id"
      class="tree-node"
      :class="{ selected: !!node.selected }"
    >
      <div class="tree-row">
        <button
          v-if="hasChildren(node)"
          class="tree-caret"
          type="button"
          :aria-label="expanded(node) ? 'Collapse' : 'Expand'"
          @click.stop="onToggle(node.id)"
        >
          {{ expanded(node) ? '▾' : '▸' }}
        </button>
        <span v-else class="tree-caret-placeholder" />
        <span v-if="node.color" class="tree-dot" :style="{ background: node.color }" />
        <button
          class="tree-main"
          :class="{ selectable: node.selectable !== false }"
          type="button"
          @click="node.selectable === false ? onToggle(node.id) : onSelect(node)"
        >
          <span class="tree-label">{{ node.label }}</span>
          <span v-if="node.meta" class="tree-meta">{{ node.meta }}</span>
        </button>
      </div>

      <div v-if="hasChildren(node) && expanded(node)" class="tree-children">
        <TreeView
          :nodes="node.children!"
          :depth="(depth || 0) + 1"
          :is-expanded="isExpanded"
          @toggle="onToggle"
          @select="onSelect"
        />
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tree-level {
  position: relative;
}

.tree-node {
  position: relative;
}

.tree-row {
  display: flex;
  align-items: center;
  padding-left: var(--pad-left);
  min-height: 24px;
}

.tree-caret,
.tree-caret-placeholder {
  width: 14px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-xs);
  color: var(--text-ghost);
  flex-shrink: 0;
}

.tree-caret {
  border: none;
  background: none;
  cursor: pointer;
  padding: 0;
}

.tree-dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  margin-right: 6px;
  flex-shrink: 0;
}

.tree-main {
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-dim);
  width: 100%;
  min-width: 0;
  padding: 2px 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  cursor: default;

  &.selectable {
    cursor: pointer;
  }

  &:hover {
    background: var(--bg-hover);
    border-color: rgba(71, 85, 105, 0.45);
  }
}

.tree-label {
  font-size: var(--text-sm);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-meta {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--text-ghost);
  white-space: nowrap;
  font-family: var(--font-mono);
}

.tree-node.selected > .tree-row .tree-main {
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(14, 165, 233, 0.35);
  color: var(--text-secondary);
}

.tree-children {
  position: relative;
}

.tree-children::before {
  content: '';
  position: absolute;
  left: calc(var(--pad-left) + 8px);
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(51, 65, 85, 0.55);
}
</style>
