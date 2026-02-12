<script setup lang="ts">
import { computed } from 'vue'
import { fmtTokens } from '@/utils/format'
import { CATEGORY_META } from '@/utils/messages'
import type { ProjectedEntry } from '@/api-types'
import type { DiffData } from '@/utils/timeline'

interface Props {
  diffData: DiffData | null
  currentEntry?: ProjectedEntry | null
  previousEntry?: ProjectedEntry | null
  showTapes?: boolean
  hideUnchanged?: boolean
  summaryMode?: 'combined' | 'split'
  combinedLabel?: string
  growthLabel?: string
  shrinkLabel?: string
  deltaTone?: 'good' | 'bad'
  showWhenEmpty?: boolean
  emptyText?: string
}

const props = withDefaults(defineProps<Props>(), {
  currentEntry: null,
  previousEntry: null,
  showTapes: false,
  hideUnchanged: false,
  summaryMode: 'split',
  combinedLabel: 'Drivers',
  growthLabel: 'Growth drivers',
  shrinkLabel: 'Shrink drivers',
  deltaTone: 'good',
  showWhenEmpty: false,
  emptyText: 'First turn — no previous context.',
})

const emit = defineEmits<{
  categoryClick: [category: string]
}>()

const visible = computed(() => !!props.diffData || props.showWhenEmpty)

const visibleDiffLines = computed(() => {
  const d = props.diffData
  if (!d) return []
  if (!props.hideUnchanged) return d.lines
  return d.lines.filter((line) => line.type !== 'same')
})

const hiddenSameCategories = computed(() => {
  const d = props.diffData
  const e = props.currentEntry
  if (!d || !e) return []
  const currMap = new Map<string, number>(e.composition.map((item) => [item.category, item.tokens]))
  return d.lines
    .filter((line) => line.type === 'same')
    .map((line) => ({
      category: line.category,
      label: CATEGORY_META[line.category]?.label ?? line.category,
      tokens: currMap.get(line.category) ?? 0,
    }))
    .sort((a, b) => b.tokens - a.tokens)
})

const hiddenSameTooltip = computed(() => {
  if (hiddenSameCategories.value.length === 0) return ''
  return hiddenSameCategories.value
    .map((item) => `${item.label}: ${fmtTokens(item.tokens)}`)
    .join('\n')
})

const deltaColor = computed(() => {
  const d = props.diffData
  if (!d) return 'var(--text-dim)'
  const isUp = d.delta >= 0
  if (props.deltaTone === 'bad') {
    return isUp ? 'var(--accent-red)' : 'var(--accent-green)'
  }
  return isUp ? 'var(--accent-green)' : 'var(--accent-red)'
})

const DIFF_HOT_THRESHOLD = 2000

function isHotDelta(delta: number): boolean {
  return Math.abs(delta) >= DIFF_HOT_THRESHOLD
}

function diffToneClass(delta: number, direction: 'up' | 'down'): string {
  if (!isHotDelta(delta)) return 'diff-tone-muted'
  return direction === 'up' ? 'diff-tone-up' : 'diff-tone-down'
}

function diffLineClass(line: DiffData['lines'][number]): string {
  if (line.type === 'same') return 'diff-tone-muted'
  return line.type === 'add'
    ? diffToneClass(line.delta, 'up')
    : diffToneClass(line.delta, 'down')
}

function onCategoryClick(category: string) {
  emit('categoryClick', category)
}
</script>

<template>
  <section v-if="visible" class="panel panel--secondary">
    <div class="panel-head">
      <span class="panel-title">Context Diff</span>
      <template v-if="diffData">
        <span class="panel-sub">Turn {{ diffData.prevTurnNum }} → {{ diffData.currTurnNum }}</span>
        <span class="diff-delta" :style="{ color: deltaColor }">
          {{ diffData.delta >= 0 ? '+' : '' }}{{ fmtTokens(diffData.delta) }}
        </span>
      </template>
    </div>

    <div class="panel-body diff-body">
      <template v-if="diffData">
        <div v-if="showTapes && currentEntry && previousEntry" class="diff-tapes">
          <div class="diff-tape-row">
            <span class="diff-tape-label">T{{ diffData.prevTurnNum }}</span>
            <div class="diff-tape-track">
              <div
                v-for="seg in previousEntry.composition"
                :key="'prev-' + seg.category"
                class="diff-tape-seg"
                :style="{ flex: seg.tokens, background: CATEGORY_META[seg.category]?.color ?? '#475569' }"
              />
            </div>
            <span class="diff-tape-val">{{ fmtTokens(previousEntry.contextInfo.totalTokens) }}</span>
          </div>
          <div class="diff-tape-row">
            <span class="diff-tape-label">T{{ diffData.currTurnNum }}</span>
            <div class="diff-tape-track">
              <div
                v-for="seg in currentEntry.composition"
                :key="'curr-' + seg.category"
                class="diff-tape-seg"
                :style="{ flex: seg.tokens, background: CATEGORY_META[seg.category]?.color ?? '#475569' }"
              />
            </div>
            <span class="diff-tape-val">{{ fmtTokens(currentEntry.contextInfo.totalTokens) }}</span>
          </div>
        </div>

        <div
          v-if="diffData.topIncreases.length > 0 || diffData.topDecreases.length > 0"
          class="diff-summary-row"
        >
          <template v-if="summaryMode === 'combined'">
            <div class="diff-summary-group">
              <span class="diff-summary-label">{{ combinedLabel }}</span>
              <button
                v-for="inc in diffData.topIncreases"
                :key="'inc-' + inc.group"
                class="diff-summary-chip"
                :class="diffToneClass(inc.delta, 'up')"
                @click="onCategoryClick(inc.category)"
              >
                {{ inc.label }} +{{ fmtTokens(inc.delta) }}
              </button>
              <button
                v-for="dec in diffData.topDecreases"
                :key="'dec-' + dec.group"
                class="diff-summary-chip"
                :class="diffToneClass(dec.delta, 'down')"
                @click="onCategoryClick(dec.category)"
              >
                {{ dec.label }} {{ fmtTokens(dec.delta) }}
              </button>
            </div>
          </template>
          <template v-else>
            <div class="diff-summary-group" v-if="diffData.topIncreases.length > 0">
              <span class="diff-summary-label">{{ growthLabel }}</span>
              <button
                v-for="inc in diffData.topIncreases"
                :key="'inc-' + inc.group"
                class="diff-summary-chip"
                :class="diffToneClass(inc.delta, 'up')"
                @click="onCategoryClick(inc.category)"
              >
                {{ inc.label }} +{{ fmtTokens(inc.delta) }}
              </button>
            </div>
            <div class="diff-summary-group" v-if="diffData.topDecreases.length > 0">
              <span class="diff-summary-label">{{ shrinkLabel }}</span>
              <button
                v-for="dec in diffData.topDecreases"
                :key="'dec-' + dec.group"
                class="diff-summary-chip"
                :class="diffToneClass(dec.delta, 'down')"
                @click="onCategoryClick(dec.category)"
              >
                {{ dec.label }} {{ fmtTokens(dec.delta) }}
              </button>
            </div>
          </template>
        </div>

        <div v-if="hideUnchanged && hiddenSameCategories.length > 0" class="diff-hidden-wrap">
          <span class="diff-hidden-note" v-tooltip="hiddenSameTooltip">
            {{ hiddenSameCategories.length }} unchanged {{ hiddenSameCategories.length === 1 ? 'category' : 'categories' }} hidden
          </span>
        </div>

        <button
          v-for="(line, i) in visibleDiffLines"
          :key="'line-' + i"
          class="diff-line"
          :class="['diff-' + line.type, diffLineClass(line)]"
          @click="onCategoryClick(line.category)"
        >
          {{ line.text }}
        </button>
      </template>
      <template v-else>
        <span class="diff-empty">{{ emptyText }}</span>
      </template>
    </div>
  </section>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.panel {
  @include panel;
}

.panel--secondary {
  background: var(--bg-field);
  border-color: rgba(51, 51, 51, 0.75);
}

.panel-head {
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-dim);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--bg-surface);
}

.panel-title {
  @include section-label;
}

.panel-sub {
  font-size: var(--text-xs);
  color: var(--text-dim);
}

.panel-body {
  padding: var(--space-3) var(--space-4);
}

.diff-delta {
  margin-left: auto;
  @include mono-text;
  font-size: var(--text-sm);
  font-weight: 600;
}

.diff-body {
  display: flex;
  flex-direction: column;
}

.diff-tapes {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--space-2);
}

.diff-tape-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.diff-tape-label {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);
  width: 28px;
  flex-shrink: 0;
}

.diff-tape-track {
  flex: 1;
  height: 6px;
  display: flex;
  border-radius: 2px;
  overflow: hidden;
  background: var(--bg-raised);
  gap: 1px;
}

.diff-tape-seg {
  height: 100%;
  min-width: 1px;
}

.diff-tape-val {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  width: 50px;
  text-align: right;
  flex-shrink: 0;
}

.diff-summary-row {
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  padding: var(--space-2);
  margin-bottom: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.diff-summary-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.diff-summary-label {
  font-size: var(--text-xs);
  color: var(--text-ghost);
}

.diff-summary-chip {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  cursor: pointer;
  background: none;
  transition: filter 0.12s;

  &:hover { filter: brightness(1.3); }
}

.diff-tone-up {
  color: var(--accent-amber);
  background: rgba(245, 158, 11, 0.08);
  border-color: rgba(245, 158, 11, 0.25);
}

.diff-tone-down {
  color: var(--accent-green);
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.25);
}

.diff-tone-muted {
  color: var(--text-dim);
  background: rgba(71, 85, 105, 0.10);
  border-color: rgba(71, 85, 105, 0.22);
}

.diff-hidden-wrap {
  position: relative;
  width: fit-content;
  margin-bottom: var(--space-2);
}

.diff-hidden-note {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);
  cursor: help;
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}

.diff-line {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  margin-bottom: 1px;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  cursor: pointer;
  display: block;
  transition: filter 0.12s;

  &:hover { filter: brightness(1.3); }
}

.diff-add,
.diff-remove,
.diff-same {
  border: 1px solid transparent;
}
.diff-empty { @include mono-text; color: var(--text-ghost); font-size: var(--text-xs); }
</style>
