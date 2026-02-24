<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SearchInput from '@/components/SearchInput.vue'
import TagFilter from '@/components/TagFilter.vue'
import { useSessionStore } from '@/stores/session'
import { fmtTokens, fmtCost, shortModel, sourceBadgeClass, healthColor } from '@/utils/format'
import { computeSessionPriority } from '@/utils/priority'
import { CATEGORY_META } from '@/utils/messages'
import { computeRecommendations } from '@/utils/recommendations'
import { classifyEntries } from '@/utils/messages'
import type { ConversationSummary, ConversationGroup, CompositionEntry } from '@/api-types'
import type { Recommendation } from '@/utils/recommendations'

const store = useSessionStore()

// ── Local UI state ──
const sortMode = ref<'recent' | 'priority' | 'cost'>('recent')
const expandedIds = ref<Set<string>>(new Set())
const sourceMenuOpen = ref(false)
const searchQuery = ref('')
const selectingForCompare = ref(false)

// Reset selection mode when compare state is cleared externally (e.g. exitCompare)
watch(() => store.compareSessionIds.size, (size) => {
  if (size === 0 && selectingForCompare.value) {
    selectingForCompare.value = false
  }
})

function toggleSelectMode() {
  selectingForCompare.value = !selectingForCompare.value
  if (!selectingForCompare.value) {
    store.compareSessionIds = new Set()
  }
}

function isSelectedForCompare(id: string): boolean {
  return store.compareSessionIds.has(id)
}

function handleRowClick(id: string) {
  if (selectingForCompare.value) {
    store.toggleCompareSession(id)
  } else {
    toggleExpand(id)
  }
}

const compareCount = computed(() => store.compareSessionIds.size)

// ── Source filter (local multi-select, independent of store.sourceFilter) ──
const activeSources = ref<Set<string> | null>(null) // null = all

const allSources = computed(() => {
  const set = new Set<string>()
  for (const s of store.summaries) {
    if (s.source) set.add(s.source)
  }
  return Array.from(set).sort()
})

function isSourceActive(source: string): boolean {
  if (!activeSources.value) return true
  return activeSources.value.has(source)
}

function toggleSource(source: string) {
  if (!activeSources.value) {
    // First deselect: create set with all except this one
    const next = new Set(allSources.value)
    next.delete(source)
    if (next.size > 0) activeSources.value = next
    return
  }
  const next = new Set(activeSources.value)
  if (next.has(source)) {
    next.delete(source)
    if (next.size === 0) return // don't allow empty
  } else {
    next.add(source)
  }
  // If all are selected, reset to null (= all)
  if (next.size === allSources.value.length) {
    activeSources.value = null
  } else {
    activeSources.value = next
  }
}

const hasSourceFilter = computed(() => activeSources.value !== null)

const sourceFilterLabel = computed(() => {
  if (!activeSources.value) return 'Source'
  return `Source (${activeSources.value.size})`
})

// ── Filtered & sorted summaries ──
const filteredSummaries = computed(() => {
  let list = store.summaries
  if (activeSources.value) {
    list = list.filter(s => activeSources.value!.has(s.source))
  }
  const q = searchQuery.value.trim().toLowerCase()
  if (q) {
    list = list.filter(s => {
      const haystack = [
        s.id,
        s.source,
        s.label,
        s.workingDirectory ?? '',
        s.latestModel,
      ].join('\0').toLowerCase()
      return haystack.includes(q)
    })
  }
  if (store.tagFilter) {
    const tag = store.tagFilter.toLowerCase()
    list = list.filter(s => s.tags?.includes(tag))
  }
  return list
})

const maxCost = computed(() => {
  let max = 0
  for (const s of filteredSummaries.value) {
    max = Math.max(max, s.totalCost)
  }
  return max
})

const priorityMap = computed(() => {
  const map = new Map<string, ReturnType<typeof computeSessionPriority>>()
  for (const s of filteredSummaries.value) {
    map.set(s.id, computeSessionPriority(s, maxCost.value))
  }
  return map
})

const sortedSummaries = computed(() => {
  const list = [...filteredSummaries.value]
  if (sortMode.value === 'priority') {
    list.sort((a, b) => {
      const aScore = priorityMap.value.get(a.id)?.score ?? 0
      const bScore = priorityMap.value.get(b.id)?.score ?? 0
      return bScore - aScore
    })
  } else if (sortMode.value === 'cost') {
    list.sort((a, b) => b.totalCost - a.totalCost)
  }
  // 'recent' is already sorted by latestTimestamp from the API
  return list
})

// ── KPI Calculations ──
const totalSessions = computed(() => filteredSummaries.value.length)

const totalRequests = computed(() => {
  return filteredSummaries.value.reduce((sum, s) => sum + s.entryCount, 0)
})

const totalTokens = computed(() => {
  return filteredSummaries.value.reduce((sum, s) => sum + s.latestTotalTokens, 0)
})

const totalCost = computed(() => {
  return filteredSummaries.value.reduce((sum, s) => sum + s.totalCost, 0)
})

const avgHealth = computed(() => {
  const withHealth = filteredSummaries.value.filter(s => s.healthScore?.overall != null)
  if (withHealth.length === 0) return 0
  const sum = withHealth.reduce((acc, s) => acc + (s.healthScore?.overall ?? 0), 0)
  return Math.round(sum / withHealth.length)
})

// ── Helpers ──
function getPriority(id: string) {
  return priorityMap.value.get(id) ?? {
    score: 0, label: 'Healthy' as const, toneClass: 'priority-healthy' as const,
    barClass: 'prio-healthy' as const, risk: 0, normalizedCost: 0, tooltip: '',
  }
}

function utilization(s: ConversationSummary): number {
  if (!s.contextLimit) return 0
  return s.latestTotalTokens / s.contextLimit
}

function utilClass(u: number): string {
  if (u >= 0.8) return 'util-high'
  if (u >= 0.6) return 'util-mid'
  return 'util-low'
}

function healthRatingClass(s: ConversationSummary): string {
  const rating = s.healthScore?.rating
  if (rating === 'poor') return 'health-bad'
  if (rating === 'needs-work') return 'health-warn'
  return 'health-good'
}

function auditRatingClass(score: number): string {
  if (score >= 90) return 'health-good'
  if (score >= 50) return 'health-warn'
  return 'health-bad'
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function exactTime(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  const date = d.toLocaleDateString('en-CA') // YYYY-MM-DD format
  return `${time} on ${date}`
}

function compactDir(path: string | null | undefined): string {
  if (!path) return ''
  let p = path
  if (/^\/home\/[^/]+(\/|$)/.test(p)) p = p.replace(/^\/home\/[^/]+/, '~')
  else if (/^\/Users\/[^/]+(\/|$)/.test(p)) p = p.replace(/^\/Users\/[^/]+/, '~')
  // Show last 2 segments
  const parts = p.split('/')
  if (parts.length > 2) return parts.slice(-2).join('/')
  return p
}

// ── Sparkline SVG ──
function sparkColor(barClass: string): string {
  if (barClass === 'prio-critical') return '#ef4444'
  if (barClass === 'prio-warning') return '#f59e0b'
  return '#0ea5e9'
}

function buildSparkSVG(data: number[], color: string): string {
  if (data.length === 0) return ''
  const w = 72
  const h = 22
  const max = Math.max(...data)
  if (max === 0) return ''
  const pts = data.map((v, i) => {
    const x = data.length <= 1 ? w / 2 : (i / (data.length - 1)) * w
    const y = h - (v / max) * (h - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const area = pts.join(' ') + ` ${w},${h} 0,${h}`
  const id = 'sg' + color.replace('#', '')
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;width:100%;height:100%">`
    + `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${color}" stop-opacity="0.15"/>`
    + `<stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>`
    + `</linearGradient></defs>`
    + `<polygon points="${area}" fill="url(#${id})"/>`
    + `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<circle cx="${pts[pts.length - 1].split(',')[0]}" cy="${pts[pts.length - 1].split(',')[1]}" r="2" fill="${color}"/>`
    + `</svg>`
}

function getSparkSVG(s: ConversationSummary): string {
  const data = s.tokenHistory
  if (!data || data.length < 2) return ''
  const prio = getPriority(s.id)
  return buildSparkSVG(data, sparkColor(prio.barClass))
}

// ── Composition tape for expanded detail ──

const COMP_CATS = [
  { key: 'system_prompt', label: 'System', color: 'var(--cat-system, #3b82f6)' },
  { key: 'tool_definitions', label: 'Tool defs', color: 'var(--cat-tools, #ec4899)' },
  { key: 'tool_results', label: 'Tool results', color: 'var(--cat-tool-results, #10b981)' },
  { key: 'assistant_text', label: 'Assistant', color: 'var(--cat-assistant, #f59e0b)' },
  { key: 'user_text', label: 'User', color: 'var(--cat-user, #06b6d4)' },
  { key: 'thinking', label: 'Thinking', color: 'var(--cat-thinking, #8b5cf6)' },
  { key: 'system_injections', label: 'Injections', color: 'var(--cat-injections, #6366f1)' },
]

function getComposition(s: ConversationSummary): CompositionEntry[] {
  const loaded = store.loadedConversations.get(s.id)
  if (!loaded || loaded.entries.length === 0) return []
  return loaded.entries[0].composition || []
}

function getFindings(s: ConversationSummary): Recommendation[] {
  const loaded = store.loadedConversations.get(s.id)
  if (!loaded || loaded.entries.length === 0) return []
  const entry = loaded.entries[0]
  const entries = [...loaded.entries].reverse()
  const classified = classifyEntries(entries)
  return computeRecommendations(entry, entries, classified)
}

// ── Expand/collapse ──
function isExpanded(id: string): boolean {
  return expandedIds.value.has(id)
}

async function toggleExpand(id: string) {
  const next = new Set(expandedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
    // Lazy-load entries if not cached
    if (!store.loadedConversations.has(id)) {
      await store.loadConversationEntries(id)
    }
  }
  expandedIds.value = next
}

function collapseAll() {
  expandedIds.value = new Set()
}

// ── Navigation ──
function sessionHref(id: string): string {
  return `#session/${encodeURIComponent(id)}?tab=overview`
}

function inspectSession(id: string) {
  store.setInspectorTab('overview')
  store.selectSession(id)
  store.setView('inspector')
}

// ── Close source menu on outside click ──
function onDocumentClick() {
  sourceMenuOpen.value = false
}

// ── Keyboard ──
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') collapseAll()
}
</script>

<template>
  <div class="dashboard" @keydown="onKeydown" tabindex="-1" @click="onDocumentClick">
    <!-- KPI Cards -->
    <div class="kpi-row">
      <div class="kpi-card">
        <div class="kpi-value">{{ totalSessions }}</div>
        <div class="kpi-label">Sessions</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value accent-blue">{{ totalRequests }}</div>
        <div class="kpi-label">Requests</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">{{ fmtTokens(totalTokens) }}</div>
        <div class="kpi-label">Total Tokens</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value accent-green">{{ fmtCost(totalCost) }}</div>
        <div class="kpi-label">Total Cost</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value accent-amber">{{ avgHealth }}</div>
        <div class="kpi-label">Avg Health</div>
      </div>
    </div>

    <!-- Section head -->
    <div class="section-head">
      <span class="section-title">Sessions</span>
      <span class="section-count">{{ filteredSummaries.length }}</span>

      <SearchInput
        v-model="searchQuery"
        placeholder="Filter by ID, directory, model…"
      />

      <div class="filter-group">
        <!-- Compare toggle -->
        <button
          class="compare-toggle"
          :class="{ active: selectingForCompare }"
          @click="toggleSelectMode"
          title="Select sessions to compare"
        >
          <i class="i-carbon-compare" /> Compare
        </button>

        <!-- Source filter dropdown -->
        <div v-if="allSources.length > 1" class="filter-dropdown">
          <button
            class="filter-btn"
            :class="{ 'has-filter': hasSourceFilter }"
            @click.stop="sourceMenuOpen = !sourceMenuOpen"
          >
            {{ sourceFilterLabel }} <span class="caret"></span>
          </button>
          <div v-if="sourceMenuOpen" class="filter-menu" @click.stop>
            <div
              v-for="src in allSources"
              :key="src"
              class="filter-option"
              :class="{ checked: isSourceActive(src) }"
              @click="toggleSource(src)"
            >
              <span class="check"><i class="i-carbon-checkmark" /></span>
              <span class="source-badge" :class="sourceBadgeClass(src)">{{ src }}</span>
            </div>
          </div>
        </div>

        <!-- Tag filter -->
        <TagFilter />

        <!-- Sort toggles -->
        <div class="sort-group">
          <button class="sort-btn" :class="{ active: sortMode === 'recent' }" @click="sortMode = 'recent'">Recent</button>
          <button class="sort-btn" :class="{ active: sortMode === 'priority' }" @click="sortMode = 'priority'">Priority</button>
          <button class="sort-btn" :class="{ active: sortMode === 'cost' }" @click="sortMode = 'cost'">Cost</button>
        </div>
      </div>
    </div>

    <!-- Table -->
    <div class="table-wrap">
      <table class="ledger">
        <thead>
          <tr>
            <th v-if="selectingForCompare" class="col-select"></th>
            <th class="col-priority"></th>
            <th class="col-source">Source</th>
            <th class="col-model">Model</th>
            <th class="col-dir">Directory</th>
            <th class="col-turns">Turns</th>
            <th class="col-context sorted">Context</th>
            <th class="col-cost">Cost</th>
            <th class="col-health">Health</th>
            <th class="col-spark">Trend</th>
            <th class="col-time">Time</th>
            <th class="col-arrow"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="s in sortedSummaries" :key="s.id">
            <!-- Main row -->
            <tr
              class="main-row"
              :class="{
                expanded: isExpanded(s.id),
                selected: isExpanded(s.id) || isSelectedForCompare(s.id),
                pulse: store.recentlyUpdated.has(s.id),
              }"
              @click="handleRowClick(s.id)"
            >
              <td v-if="selectingForCompare" class="col-select">
                <span class="compare-check" :class="{ checked: isSelectedForCompare(s.id) }">
                  <i class="i-carbon-checkmark" />
                </span>
              </td>
              <td class="col-priority">
                <div class="priority-bar" :class="getPriority(s.id).barClass"></div>
              </td>
              <td class="col-source">
                <span class="source-badge" :class="sourceBadgeClass(s.source)">{{ s.source || '?' }}</span>
                <span v-if="s.tags?.length" class="row-tags">
                  <span
                    v-for="(tag, i) in s.tags.slice(0, 2)"
                    :key="tag"
                    class="row-tag"
                    :class="store.getTagColorClass(i)"
                    :title="tag"
                  >{{ tag }}</span>
                  <span v-if="s.tags.length > 2" class="row-tag-more">+{{ s.tags.length - 2 }}</span>
                </span>
              </td>
              <td class="col-model">
                <span class="model-text">{{ shortModel(s.latestModel) }}</span>
              </td>
              <td class="col-dir">
                <span class="dir-text" :title="s.workingDirectory ?? ''">{{ compactDir(s.workingDirectory) }}</span>
              </td>
              <td class="col-turns">
                <span class="num">{{ s.entryCount }}</span>
              </td>
              <td class="col-context">
                <span class="util-chip" :class="utilClass(utilization(s))">
                  {{ Math.round(utilization(s) * 100) }}%
                </span>
              </td>
              <td class="col-cost">
                <span class="num green">{{ fmtCost(s.totalCost) }}</span>
              </td>
              <td class="col-health">
                <div class="health-cell">
                  <span class="health-num" :class="healthRatingClass(s)">
                    {{ s.healthScore?.overall ?? '—' }}
                  </span>
                  <div v-if="s.healthScore?.audits" class="health-tooltip">
                    <div class="health-tooltip-title">Health Score: {{ s.healthScore.overall }}</div>
                    <div v-for="audit in s.healthScore.audits" :key="audit.id" class="health-audit-line">
                      <span class="health-audit-name">{{ audit.name }}</span>
                      <span class="health-audit-score" :class="auditRatingClass(audit.score)">{{ audit.score }}</span>
                    </div>
                  </div>
                </div>
              </td>
              <td class="col-spark">
                <div class="inline-spark" v-html="getSparkSVG(s)"></div>
              </td>
              <td class="col-time">
                <span class="time-text" :title="exactTime(s.latestTimestamp)">{{ relativeTime(s.latestTimestamp) }}</span>
              </td>
              <td class="col-arrow">
                <a
                  class="inspect-btn"
                  title="Open in inspector"
                  :href="sessionHref(s.id)"
                  @click.prevent.stop="inspectSession(s.id)"
                ><i class="i-carbon-arrow-right" /></a>
              </td>
            </tr>

            <!-- Expand row -->
            <tr class="expand-row" :class="{ open: isExpanded(s.id) }">
              <td :colspan="selectingForCompare ? 12 : 11">
                <div class="expand-content">
                  <div class="expand-inner">
                    <!-- Loading state -->
                    <div v-if="store.loadingSession === s.id" class="expand-loading">
                      Loading…
                    </div>
                    <template v-else>
                      <!-- Composition -->
                      <div class="expand-section" v-if="getComposition(s).length > 0">
                        <div class="expand-section-label">
                          Composition · {{ fmtTokens(getComposition(s).reduce((sum, c) => sum + c.tokens, 0)) }} tokens
                        </div>
                        <div class="comp-tape">
                          <div
                            v-for="cat in COMP_CATS"
                            :key="cat.key"
                            class="comp-seg"
                            v-show="(getComposition(s).find(c => c.category === cat.key)?.tokens ?? 0) > 0"
                            :style="{
                              flex: getComposition(s).find(c => c.category === cat.key)?.tokens ?? 0,
                              background: cat.color,
                            }"
                            :title="`${cat.label}: ${getComposition(s).find(c => c.category === cat.key)?.pct ?? 0}%`"
                          >
                            <span
                              v-if="(getComposition(s).find(c => c.category === cat.key)?.pct ?? 0) >= 12"
                              class="comp-seg-label"
                            >{{ cat.label }}</span>
                          </div>
                        </div>
                      </div>

                      <!-- Findings -->
                      <div class="expand-section">
                        <div class="expand-section-label">Findings</div>
                        <div class="expand-findings" :class="{ 'expand-findings--scroll': getFindings(s).length > 5 }">
                          <template v-if="getFindings(s).length > 0">
                            <div v-for="(f, i) in getFindings(s)" :key="i" class="finding">
                              <i class="finding-icon" :class="[`sev-${f.severity}`, f.severity === 'high' ? 'i-carbon-warning-alt' : f.severity === 'med' ? 'i-carbon-information' : 'i-carbon-checkmark']"></i>
                              <span class="finding-text">
                                {{ f.title }}
                                <span v-if="f.impact" class="finding-impact" :class="`sev-${f.severity}`">{{ f.impact }}</span>
                              </span>
                            </div>
                          </template>
                          <div v-else class="finding">
                            <i class="finding-icon sev-low i-carbon-checkmark"></i>
                            <span class="finding-text muted">No issues detected.</span>
                          </div>
                        </div>
                      </div>


                    </template>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>

    </div>

    <!-- Compare action bar -->
    <Transition name="compare-bar">
      <div v-if="selectingForCompare && compareCount >= 2" class="compare-bar">
        <span class="compare-bar-text">{{ compareCount }} sessions selected</span>
        <button class="compare-bar-btn" @click="store.enterCompare()">
          <i class="i-carbon-compare" /> Compare
        </button>
      </div>
    </Transition>

    <!-- Empty state -->
    <div v-if="sortedSummaries.length === 0 && (searchQuery || activeSources)" class="dashboard-empty">
      <div class="empty-title">No matching sessions</div>
      <div class="empty-sub">Try adjusting your search or filters</div>
    </div>
    <div v-else-if="store.summaries.length === 0" class="dashboard-empty">
      <div class="empty-title">No requests captured</div>
      <div class="empty-sub">Point API calls to <code>localhost:4040</code></div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.dashboard {
  padding: 20px 24px;
  height: 100%;
  overflow-y: auto;
  @include scrollbar-thin;
  outline: none;
}

// ── Section head ──
.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.section-title {
  @include section-label;
}

.section-count {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  background: var(--bg-raised);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}

// ── Filter group ──
.filter-group {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.filter-dropdown {
  position: relative;
}

.filter-btn {
  @include mono-text;
  font-size: var(--text-sm);
  padding: 4px 10px;
  background: none;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: border-color 0.12s, color 0.12s;

  &:hover { border-color: var(--border-mid); color: var(--text-secondary); }
  &.has-filter { border-color: rgba(14, 165, 233, 0.4); color: var(--accent-blue); }
}

.caret { 
  display: inline-block;
  width: 0;
  height: 0;
  margin-left: 6px;
  vertical-align: middle;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 4px solid currentColor;
  opacity: 0.6;
}

.filter-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 140px;
  background: var(--bg-surface);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-md);
  padding: var(--space-1) 0;
  z-index: 50;
  box-shadow: var(--shadow-lg);
}

.filter-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px 10px;
  @include mono-text;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.08s;

  &:hover { background: var(--bg-hover); }
}

.check {
  width: 14px;
  height: 14px;
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  color: transparent;
  transition: background 0.1s, border-color 0.1s, color 0.1s;
  flex-shrink: 0;

  .filter-option.checked & {
    background: var(--accent-blue-dim);
    border-color: var(--accent-blue);
    color: var(--accent-blue);
  }
}

// ── Sort group ──
.sort-group {
  display: flex;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.sort-btn {
  font-size: var(--text-sm);
  padding: 4px 10px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;

  & + & { border-left: 1px solid var(--border-dim); }
  &:hover { color: var(--text-secondary); }
  &.active { background: var(--accent-blue-dim); color: var(--accent-blue); }
}

// ── Table ──
.table-wrap {
  background: var(--bg-field);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.ledger {
  width: 100%;
  border-collapse: collapse;
}

.ledger th {
  @include section-label;
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-mid);
  background: var(--bg-surface);
  position: sticky;
  top: 0;
  z-index: 10;
  white-space: nowrap;
  cursor: default;
  user-select: none;

  &.sorted { color: var(--accent-blue); }
}

.ledger td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-dim);
  vertical-align: middle;
}

// ── Row styles ──
.main-row {
  cursor: pointer;
  transition: background 0.08s;

  &:hover td { background: var(--bg-hover) !important; }
  &.selected td { background: var(--accent-blue-dim) !important; }
  &.pulse td { animation: row-pulse 1.5s ease-out; }
}

@keyframes row-pulse {
  0% { background: rgba(14, 165, 233, 0.18); }
  100% { background: transparent; }
}

// Alternating row backgrounds (every other main-row)
.main-row:nth-child(4n+3) td { background: var(--bg-row-alt, #161616); }

// ── Priority bar ──
.col-priority { width: 3px; padding: 0 !important; }

.priority-bar {
  width: 3px;
  height: 100%;
  min-height: 28px;
}

.prio-critical { background: var(--accent-red); }
.prio-warning { background: var(--accent-amber); }
.prio-healthy { background: var(--accent-green); opacity: 0.4; }

// ── Column sizing ──
.col-source { width: 72px; }
.col-model { width: 80px; }
.col-dir { /* flex */ }
.col-turns { width: 52px; text-align: right !important; }
.col-context { width: 64px; text-align: right !important; }
.col-cost { width: 64px; text-align: right !important; }
.col-health { width: 52px; text-align: center !important; }
.col-spark { width: 80px; padding-left: 0 !important; padding-right: 0 !important; }
.col-time { width: 72px; text-align: right !important; white-space: nowrap; }
.col-arrow { width: 28px; text-align: center !important; }

// ── Cell styles ──
.source-badge {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 2px 5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  border-radius: var(--radius-sm);
  line-height: 1.4;
}

.row-tags {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 4px;
  vertical-align: middle;
}

.row-tag {
  @include mono-text;
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 2px;
  text-transform: lowercase;
  max-width: 50px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  // Default background (will be overridden by color classes)
  background: var(--bg-raised);
  color: var(--text-secondary);

  // Position-based tag colors
  &.tag-color-0 { background: var(--accent-blue-dim);          color: var(--accent-blue); }
  &.tag-color-1 { background: rgba(16,  185, 129, 0.15);       color: var(--accent-green); }
  &.tag-color-2 { background: var(--accent-amber-dim);         color: var(--accent-amber); }
  &.tag-color-3 { background: rgba(139,  92, 246, 0.15);       color: var(--accent-purple); }
  &.tag-color-4 { background: var(--accent-red-dim);           color: var(--accent-red); }
  &.tag-color-5 { background: rgba(  6, 182, 212, 0.15);       color: #06b6d4; }
  &.tag-color-6 { background: rgba(236,  72, 153, 0.15);       color: #ec4899; }
  &.tag-color-7 { background: rgba(132, 204,  22, 0.15);       color: #84cc16; }
}

.row-tag-more {
  font-size: 9px;
  color: var(--text-muted);
}

// Badge colors
.badge-claude { background: rgba(251, 146, 60, 0.15); color: #fb923c; }
.badge-codex { background: rgba(52, 211, 153, 0.15); color: #34d399; }
.badge-aider { background: rgba(14, 165, 233, 0.15); color: var(--accent-blue); }
.badge-kimi { background: rgba(167, 139, 250, 0.15); color: var(--accent-purple); }
.badge-pi { background: rgba(167, 139, 250, 0.15); color: var(--accent-purple); }
.badge-gemini { background: rgba(74, 144, 226, 0.15); color: #4a90e2; }
.badge-unknown { background: var(--bg-raised); color: var(--text-dim); }

.model-text {
  @include mono-text;
  font-size: var(--text-sm);
  color: var(--text-dim);
}

.dir-text {
  @include mono-text;
  @include truncate;
  font-size: var(--text-sm);
  color: var(--text-dim);
  display: block;
  max-width: 200px;
}

.num {
  @include mono-text;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  &.green { color: var(--accent-green); }
}

.util-chip {
  @include mono-text;
  font-size: var(--text-sm);
  font-weight: 600;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  display: inline-block;
  min-width: 38px;
  text-align: center;
}

.util-low { color: var(--accent-blue); background: var(--accent-blue-dim); }
.util-mid { color: var(--accent-amber); background: var(--accent-amber-dim); }
.util-high { color: var(--accent-red); background: var(--accent-red-dim); }

.health-cell {
  position: relative;
  display: inline-block;
}

.health-num {
  @include mono-text;
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: help;
}

.health-good { color: var(--accent-green); }
.health-warn { color: var(--accent-amber); }
.health-bad { color: var(--accent-red); }

.health-tooltip {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-raised);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.6;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s ease;
  z-index: 100;
  box-shadow: var(--shadow-lg);
  min-width: 200px;

  .health-cell:hover & {
    opacity: 1;
  }

  &::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-top-color: var(--border-bright);
  }
}

.health-tooltip-title {
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-dim);
  font-weight: 600;
  color: var(--text-primary);
}

.health-audit-line {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 2px 0;
}

.health-audit-name {
  color: var(--text-secondary);
}

.health-audit-score {
  font-weight: 600;
  text-align: right;
}

.time-text {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  cursor: help;
  display: inline-block;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  transition: background 0.15s, color 0.15s;
  
  &:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }
}

.inline-spark {
  display: block;
  width: 72px;
  height: 22px;
}

// ── Inspector button (right column) ──
.inspect-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s ease;
  padding: 0;
  line-height: 1;

  &:hover {
    background: var(--accent-blue-dim);
    border-color: var(--accent-blue);
    color: var(--accent-blue);
    transform: translateX(2px);
  }
}

// ── Expanded row detail ──
.expand-row td {
  padding: 0 !important;
  border-bottom: 1px solid transparent;
  background: transparent !important;
  transition: border-color 0.22s ease, background-color 0.22s ease;
}

.expand-row.open td {
  border-bottom-color: var(--border-dim);
  background: var(--bg-expand, #141414) !important;
}

.expand-content {
  overflow: hidden;
  max-height: 0;
  opacity: 0;
  transition: max-height 0.26s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.2s ease;
}

.expand-row.open .expand-content {
  max-height: 420px;
  opacity: 1;
}

.expand-inner {
  padding: var(--space-3) var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  transform: translateY(-2px);
  transition: padding 0.26s cubic-bezier(0.25, 0.46, 0.45, 0.94), transform 0.2s ease;
}

.expand-row.open .expand-inner {
  transform: translateY(0);
}

.expand-row:not(.open) .expand-inner {
  padding-top: 0;
  padding-bottom: 0;
}

.expand-loading {
  @include mono-text;
  font-size: var(--text-sm);
  color: var(--text-muted);
  padding: var(--space-2) 0;
}

.expand-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.expand-section-label {
  @include section-label;
}

// ── Composition tape ──
.comp-tape {
  height: 24px;
  display: flex;
  gap: 1px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-deep);
  cursor: default;
}

.comp-seg {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  transition: filter 0.12s;

  &:hover { filter: brightness(1.25); }
}

.comp-seg-label {
  @include mono-text;
  font-size: 9px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  @include truncate;
  padding: 0 4px;
}

// ── Findings ──
.expand-findings {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.expand-findings--scroll {
  --finding-row-height: 22px;
  max-height: calc((5 * var(--finding-row-height)) + (4 * 6px));
  overflow-y: auto;
  padding-right: 4px;
  @include scrollbar-thin;
}

.finding {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: var(--text-sm);
  min-height: var(--finding-row-height, auto);
}

.finding-icon {
  font-size: 13px;
  margin-top: 1px;
  flex-shrink: 0;

  &.sev-high { color: var(--accent-red); }
  &.sev-med { color: var(--accent-amber); }
  &.sev-low { color: var(--accent-green); }
}

.finding-text {
  color: var(--text-secondary);
  line-height: 1.4;

  &.muted { color: var(--text-muted); }
}

.finding-impact {
  @include mono-text;
  font-size: var(--text-xs);
  margin-left: 6px;
  padding: 1px 4px;
  border-radius: var(--radius-sm);

  &.sev-high { background: var(--accent-red-dim); color: var(--accent-red); }
  &.sev-med { background: var(--accent-amber-dim); color: var(--accent-amber); }
  &.sev-low { background: var(--accent-green-dim); color: var(--accent-green); }
}

// ── Footer ──
.table-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border-dim);
  background: var(--bg-field);
}

.table-hint {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-ghost);
}

.comp-legend {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.comp-legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);
}

.comp-legend-dot {
  width: 6px;
  height: 6px;
  border-radius: 1px;
  flex-shrink: 0;
}

// ── KPI Cards ──
.kpi-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.kpi-card {
  background: var(--bg-field);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-lg);
  padding: var(--space-3);
  text-align: center;
  transition: border-color 0.2s ease;

  &:hover {
    border-color: var(--border-mid);
  }
}

.kpi-value {
  @include mono-text;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);

  &.accent-blue { color: var(--accent-blue); }
  &.accent-green { color: var(--accent-green); }
  &.accent-amber { color: var(--accent-amber); }
}

.kpi-label {
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--text-dim);
  margin-top: 4px;
  letter-spacing: 0.02em;
}

// ── Empty state ──
.dashboard-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-8) 0;
}

.empty-title {
  font-size: var(--text-base);
  color: var(--text-dim);
  font-weight: 500;
}

.empty-sub {
  font-size: var(--text-sm);
  color: var(--text-muted);

  code {
    @include mono-text;
    color: var(--accent-blue);
    background: var(--accent-blue-dim);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
  }
}

// ── Compare mode ──
.compare-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-muted);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;

  &:hover { border-color: var(--border-mid); color: var(--text-secondary); }
  &.active {
    border-color: rgba(14, 165, 233, 0.4);
    color: var(--accent-blue);
    background: var(--accent-blue-dim);
  }
}

.col-select { width: 32px; text-align: center !important; padding: 0 4px !important; }

.compare-check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--border-mid);
  border-radius: var(--radius-sm);
  color: transparent;
  font-size: 10px;
  transition: background 0.1s, border-color 0.1s, color 0.1s;
  margin: 0 auto;

  &.checked {
    background: var(--accent-blue);
    border-color: var(--accent-blue);
    color: #fff;
  }
}

.compare-bar {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  background: var(--bg-raised);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  z-index: 100;
}

.compare-bar-text {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  white-space: nowrap;
}

.compare-bar-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent-blue);
  color: #fff;
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.1s;

  &:hover { opacity: 0.9; }
}

.compare-bar-enter-active,
.compare-bar-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.compare-bar-enter-from,
.compare-bar-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(10px);
}

@media (prefers-reduced-motion: reduce) {
  .expand-content { transition: none; }
  .inspect-btn { transition: none; }
  .compare-bar-enter-active,
  .compare-bar-leave-active { transition: none; }
}
</style>
