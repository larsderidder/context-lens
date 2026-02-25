<script setup lang="ts">
import { useSessionStore } from '@/stores/session'
import { shortModel, fmtCost, sourceBadgeClass } from '@/utils/format'
import type { ConversationSummary } from '@/api-types'

const store = useSessionStore()

function selectSession(id: string) {
  store.selectSession(id)
  store.setView('inspector')
}

function goToDashboard() {
  store.setView('dashboard')
}

function tileTooltip(s: ConversationSummary): string {
  const model = shortModel(s.latestModel)
  const turns = s.entryCount + (s.entryCount === 1 ? ' turn' : ' turns')
  const cost = fmtCost(s.totalCost)
  const health = s.healthScore ? `\nHealth ${s.healthScore.overall}/100 (${s.healthScore.rating})` : ''
  const dir = s.workingDirectory ? `\n${s.workingDirectory}` : ''
  const tags = s.tags?.length ? `\nTags: ${s.tags.join(', ')}` : ''
  return `${s.source} · ${model}\n${turns} · ${cost}${health}${dir}${tags}`
}

function utilizationPct(s: ConversationSummary): number {
  if (!s.contextLimit) return 0
  return Math.min(100, Math.round((s.latestTotalTokens / s.contextLimit) * 100))
}

function utilizationClass(s: ConversationSummary): string {
  const pct = utilizationPct(s)
  if (pct >= 80) return 'high'
  if (pct >= 60) return 'mid'
  return 'low'
}

/** Floating-vue tooltip options: show instantly, positioned right of rail */
const tipOpts = { delay: { show: 50, hide: 0 }, placement: 'right' as const }
</script>

<template>
  <nav class="session-rail" aria-label="Sessions">
    <button
      class="rail-back"
      v-tooltip="{ content: 'Dashboard', ...tipOpts }"
      @click="goToDashboard"
    >
      <i class="i-carbon-grid grid-icon" />
    </button>
    <span class="rail-label">SESSIONS</span>

    <div class="rail-scroll">
      <button
        v-for="s in store.filteredSummaries"
        :key="s.id"
        class="rail-tile"
        :class="{
          active: s.id === store.selectedSessionId,
          pulse: store.recentlyUpdated.has(s.id),
        }"
        v-tooltip="{ content: tileTooltip(s), ...tipOpts }"
        @click="selectSession(s.id)"
      >
        <span class="tile-source" :class="sourceBadgeClass(s.source)">
          {{ s.source || '?' }}
        </span>
        <span class="tile-meta">{{ s.entryCount }}t</span>
        <span class="tile-util" :class="utilizationClass(s)">{{ utilizationPct(s) }}%</span>
        <!-- Tag indicator -->
        <span v-if="s.tags?.length" class="tile-tags">
          <span
            v-for="(tag, i) in s.tags.slice(0, 3)"
            :key="tag"
            class="tile-tag-dot"
            :class="store.getTagColorClass(i)"
            :title="tag"
          />
          <span v-if="s.tags.length > 3" class="tile-tag-more">+</span>
        </span>
      </button>
    </div>
  </nav>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.session-rail {
  width: 78px;
  background: var(--bg-field);
  border-right: 1px solid var(--border-dim);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6px 0;
  gap: 2px;
  flex-shrink: 0;
  overflow: hidden;
}

// ── Back button ──
.rail-back {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-surface);
  border: 2px solid var(--border-mid);
  border-radius: 50%;
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s, transform 0.15s;
  flex-shrink: 0;
  margin-bottom: 6px;

  &:hover {
    border-color: var(--accent-blue);
    color: var(--accent-blue);
    background: var(--accent-blue-dim);
    transform: translateX(-2px);
  }

  &:focus-visible { @include focus-ring; }
}

.rail-label {
  font-size: 8px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-ghost);
  margin: 3px 0 4px;
}

.grid-icon {
  display: block;
  font-size: 18px;
}

// ── Scrollable tile list ──
.rail-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 0 0 4px;
  width: 100%;
  @include scrollbar-thin;

  &::-webkit-scrollbar { width: 3px; }
}

// ── Session tile ──
.rail-tile {
  width: 62px;
  min-height: 50px;
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  border: 1.5px solid transparent;
  background: var(--bg-surface);
  transition: background 0.12s, border-color 0.12s;
  flex-shrink: 0;
  padding: 5px 5px 4px;

  &:hover {
    background: var(--bg-raised);
    border-color: var(--border-mid);
  }

  &.active {
    border-color: var(--accent-blue);
    background: var(--accent-blue-dim);
  }

  &.pulse {
    animation: tile-pulse 1.5s ease-out;
  }

  &:focus-visible { @include focus-ring; }
}

@keyframes tile-pulse {
  0% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0.5); }
  40% { box-shadow: 0 0 0 4px rgba(14, 165, 233, 0.15); }
  100% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0); }
}

// ── Source label (colored) ──
.tile-source {
  @include mono-text;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.03em;
  line-height: 1;
  @include truncate;
  max-width: 44px;
  text-align: center;
}

// ── Tile metadata ──
.tile-meta {
  @include mono-text;
  font-size: 9px;
  color: var(--text-muted);
  line-height: 1;
}

.tile-util {
  @include mono-text;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 2px;

  &.low {
    color: var(--accent-blue);
    background: var(--accent-blue-dim);
  }

  &.mid {
    color: var(--accent-amber);
    background: var(--accent-amber-dim);
  }

  &.high {
    color: var(--accent-red);
    background: var(--accent-red-dim);
  }
}

// ── Source badge colors (reuse from format.ts sourceBadgeClass) ──
.badge-claude { color: #fb923c; }
.badge-codex { color: #34d399; }
.badge-aider { color: var(--accent-blue); }
.badge-opencode { color: #8b5cf6; }
.badge-kimi { color: var(--accent-purple); }
.badge-pi { color: var(--accent-purple); }
.badge-gemini { color: #4a90e2; }
.badge-unknown { color: var(--text-dim); }

// ── Tag indicators ──
.tile-tags {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex-wrap: wrap;
  max-width: 54px;
  margin-top: 2px;
}

.tile-tag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;

  // Position-based tag colors
  &.tag-color-0 { background: var(--accent-blue); }
  &.tag-color-1 { background: var(--accent-green); }
  &.tag-color-2 { background: var(--accent-amber); }
  &.tag-color-3 { background: var(--accent-purple); }
  &.tag-color-4 { background: var(--accent-red); }
  &.tag-color-5 { background: #06b6d4; }
  &.tag-color-6 { background: #ec4899; }
  &.tag-color-7 { background: #84cc16; }
}

.tile-tag-more {
  font-size: 7px;
  color: var(--text-muted);
  line-height: 1;
}

// ── Accessibility: respect reduced motion ──
@media (prefers-reduced-motion: reduce) {
  .rail-tile { transition-duration: 0.01ms !important; }
}
</style>
