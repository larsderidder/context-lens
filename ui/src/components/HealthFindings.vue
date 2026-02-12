<script setup lang="ts">
import type { ProjectedEntry } from '@/api-types'
import type { Recommendation } from '@/utils/recommendations'

interface Props {
  entry: ProjectedEntry
  recommendations: Recommendation[]
  auditTooltip: (audit: { id: string; name: string; description: string }) => string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  recommendationClick: [rec: { messageIndex?: number; highlight?: string }]
}>()

function handleRecClick(rec: { messageIndex?: number; highlight?: string }) {
  if (rec.messageIndex == null) return
  emit('recommendationClick', rec)
}
</script>

<template>
  <section class="panel panel--primary" v-if="entry.healthScore || recommendations.length > 0">
    <div class="panel-head">
      <span class="panel-title">Findings</span>
      <span class="finding-count" v-if="recommendations.length">{{ recommendations.length }}</span>
    </div>
    <!-- Audit chips -->
    <div v-if="entry.healthScore" class="audit-row">
      <span v-for="audit in entry.healthScore.audits" :key="audit.id" class="audit-chip"
        :class="audit.score >= 90 ? 'audit-good' : audit.score >= 50 ? 'audit-warn' : 'audit-bad'"
        v-tooltip="auditTooltip(audit)">
        {{ audit.name }} <b>{{ audit.score }}</b>
      </span>
    </div>
    <!-- Recommendations -->
    <div v-if="recommendations.length > 0" class="panel-body rec-list" :class="{ 'rec-list--scroll': recommendations.length > 3 }">
      <div v-for="(r, i) in recommendations" :key="i"
        class="rec"
        :class="{ 'rec-clickable': r.messageIndex != null }"
        @click="r.messageIndex != null && handleRecClick(r)"
      >
        <i class="rec-icon" :class="[`sev-${r.severity}`, r.severity === 'high' ? 'i-carbon-warning-alt' : r.severity === 'med' ? 'i-carbon-information' : 'i-carbon-checkmark']" />
        <div class="rec-content">
          <div class="rec-title">{{ r.title }}</div>
          <div class="rec-detail">{{ r.detail }}</div>
        </div>
        <span class="rec-impact" :class="`sev-${r.severity}`">{{ r.impact }}</span>
      </div>
    </div>
  </section>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.panel {
  @include panel;
}

.panel--primary {
  position: relative;
  border-left: none;

  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--accent-amber);
    pointer-events: none;
  }
}

.panel-head {
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-dim);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.panel-title {
  @include section-label;
}

.finding-count {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--accent-blue-dim);
  color: var(--accent-blue);
}

.audit-row {
  padding: var(--space-2) var(--space-4);
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border-dim);
}

.audit-chip {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  cursor: default;

  b { font-weight: 700; margin-left: 2px; }

  &.audit-good { background: rgba(16, 185, 129, 0.08); color: #6ee7b7; b { color: #10b981; } }
  &.audit-warn { background: rgba(245, 158, 11, 0.08); color: #fbbf24; b { color: #f59e0b; } }
  &.audit-bad { background: rgba(239, 68, 68, 0.08); color: #fca5a5; b { color: #ef4444; } }
}

.rec-list { padding: var(--space-3) var(--space-4); }

.rec-list--scroll {
  max-height: 220px;
  overflow-y: auto;
  padding-right: calc(var(--space-4) - 4px);
  @include scrollbar-thin;
}

.rec {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-dim);

  &:last-child { border-bottom: none; padding-bottom: 0; }
  &:first-child { padding-top: 0; }
}

.rec-icon {
  font-size: 14px;
  margin-top: 1px;
  flex-shrink: 0;

  &.sev-high { color: var(--accent-red); }
  &.sev-med { color: var(--accent-amber); }
  &.sev-low { color: var(--accent-green); }
}

.rec-clickable {
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 0.12s;

  &:hover { background: var(--bg-hover); }
}

.rec-content { flex: 1; min-width: 0; }

.rec-title {
  @include sans-text;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-secondary);
}

.rec-detail {
  @include sans-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  margin-top: 3px;
  line-height: 1.5;
}

.rec-impact {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 1px 5px;
  border-radius: 0;
  white-space: nowrap;
  flex-shrink: 0;
  margin-top: 2px;

  &.sev-high { background: var(--accent-red-dim); color: var(--accent-red); }
  &.sev-med { background: var(--accent-amber-dim); color: var(--accent-amber); }
  &.sev-low { background: var(--accent-green-dim); color: var(--accent-green); }
}

.panel-body {
  padding: var(--space-4);
}
</style>
