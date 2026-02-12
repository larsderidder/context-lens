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

function healthClass(s: ConversationSummary): string {
  if (!s.healthScore) return 'health-none'
  switch (s.healthScore.rating) {
    case 'good': return 'health-good'
    case 'needs-work': return 'health-warn'
    case 'poor': return 'health-bad'
    default: return 'health-none'
  }
}

function tileTooltip(s: ConversationSummary): string {
  const model = shortModel(s.latestModel)
  const turns = s.entryCount + (s.entryCount === 1 ? ' turn' : ' turns')
  const cost = fmtCost(s.totalCost)
  const health = s.healthScore ? `\nHealth ${s.healthScore.overall}/100 (${s.healthScore.rating})` : ''
  const dir = s.workingDirectory ? `\n${s.workingDirectory}` : ''
  return `${s.source} · ${model}\n${turns} · ${cost}${health}${dir}`
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
      <svg class="grid-icon" width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        <rect x="0" y="0" width="6" height="6" rx="1" />
        <rect x="8" y="0" width="6" height="6" rx="1" />
        <rect x="0" y="8" width="6" height="6" rx="1" />
        <rect x="8" y="8" width="6" height="6" rx="1" />
      </svg>
    </button>

    <div class="rail-label">
      <span class="rail-label-text">Sessions</span>
      <span class="rail-label-count">{{ store.summaries.length }}</span>
    </div>

    <div class="rail-scroll">
      <button
        v-for="s in store.summaries"
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
        <span class="tile-turns">{{ s.entryCount }} t</span>
        <span class="tile-health" :class="healthClass(s)" />
      </button>
    </div>
  </nav>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.session-rail {
  width: 64px;
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
  width: 48px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
  flex-shrink: 0;

  &:hover {
    border-color: var(--border-mid);
    color: var(--text-primary);
    background: var(--bg-raised);
  }

  &:focus-visible { @include focus-ring; }
}

.grid-icon {
  display: block;
}

// ── Section label ──
.rail-label {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  padding: 6px 0 4px;
  flex-shrink: 0;
}

.rail-label-text {
  @include section-label;
  font-size: 8px;
  letter-spacing: 0.1em;
  color: var(--text-ghost);
}

.rail-label-count {
  @include mono-text;
  font-size: 9px;
  color: var(--text-muted);
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
  width: 50px;
  min-height: 46px;
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  border: 1.5px solid transparent;
  background: var(--bg-surface);
  transition: all 0.12s;
  position: relative;
  flex-shrink: 0;
  padding: 6px 3px 4px;

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

// ── Turn count ──
.tile-turns {
  @include mono-text;
  font-size: 9px;
  color: var(--text-muted);
  line-height: 1;
  letter-spacing: 0.02em;
}

// ── Health bar ──
.tile-health {
  width: 24px;
  height: 3px;
  border-radius: 2px;
  margin-top: 1px;
  background: var(--bg-raised);

  &.health-good { background: var(--accent-green); }
  &.health-warn { background: var(--accent-amber); }
  &.health-bad { background: var(--accent-red); }
  &.health-none { background: var(--border-mid); }
}

// ── Source badge colors (reuse from format.ts sourceBadgeClass) ──
.badge-claude { color: #fb923c; }
.badge-codex { color: #34d399; }
.badge-aider { color: var(--accent-blue); }
.badge-kimi { color: var(--accent-purple); }
.badge-pi { color: var(--accent-purple); }
.badge-unknown { color: var(--text-dim); }
</style>
