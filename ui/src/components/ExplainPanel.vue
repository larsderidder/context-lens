<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  section?: 'health' | 'composition' | null
}>()

const emit = defineEmits<{
  close: []
}>()

const activeSection = ref<'health' | 'composition'>('health')

watch(() => props.section, (s) => {
  if (s) activeSection.value = s
})

function onOverlayClick() {
  emit('close')
}

function onPanelClick(e: MouseEvent) {
  e.stopPropagation()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="explain">
      <div v-if="open" class="explain-overlay" @click="onOverlayClick">
        <aside class="explain-panel" @click="onPanelClick">
          <header class="explain-header">
            <h2 class="explain-title">
              <i class="i-carbon-information" />
              {{ activeSection === 'health' ? 'Health Score' : 'Composition' }}
            </h2>
            <button class="explain-close" @click="emit('close')">
              <i class="i-carbon-close" />
            </button>
          </header>

          <nav class="explain-tabs">
            <button
              class="explain-tab"
              :class="{ active: activeSection === 'health' }"
              @click="activeSection = 'health'"
            >Health</button>
            <button
              class="explain-tab"
              :class="{ active: activeSection === 'composition' }"
              @click="activeSection = 'composition'"
            >Composition</button>
          </nav>

          <div class="explain-body">
            <!-- Health section -->
            <template v-if="activeSection === 'health'">
              <p class="explain-intro">
                The health score (0-100) estimates how efficiently this turn uses the context window.
                It is a weighted average of five audits. A higher score means more room for the conversation to grow.
              </p>

              <div class="explain-audit">
                <div class="audit-name">
                  <span class="audit-weight">30%</span>
                  Context Utilization
                </div>
                <p>How much of the model's context window is used. Below 50% scores well. Above 80% starts losing points rapidly. Near-limit turns score near zero.</p>
              </div>

              <div class="explain-audit">
                <div class="audit-name">
                  <span class="audit-weight">25%</span>
                  Tool Results
                </div>
                <p>Whether tool results are proportionally sized. Large tool results (file contents, search results) can dominate the context. Flagged when a single result exceeds 20% of total tokens.</p>
              </div>

              <div class="explain-audit">
                <div class="audit-name">
                  <span class="audit-weight">20%</span>
                  Tool Definitions
                </div>
                <p>Ratio of tool definitions to total context. If many defined tools go unused across the session, the definitions are wasting space. Also penalised when tool definitions exceed 30% of tokens.</p>
              </div>

              <div class="explain-audit">
                <div class="audit-name">
                  <span class="audit-weight">15%</span>
                  Growth Rate
                </div>
                <p>How much the context grew since the previous turn. Gradual growth is healthy. A sudden spike (more than 30% of the window in one turn) suggests a large paste or tool result.</p>
              </div>

              <div class="explain-audit">
                <div class="audit-name">
                  <span class="audit-weight">10%</span>
                  Thinking Overhead
                </div>
                <p>Proportion of tokens spent on thinking/reasoning blocks. Some thinking is fine, but when it dominates (over 40%) it can crowd out conversation context.</p>
              </div>

              <div class="explain-caveat">
                <i class="i-carbon-warning-alt" />
                <p>This score is a heuristic, not a quality judgment. A low score does not mean the conversation is bad. It highlights patterns worth reviewing.</p>
              </div>
            </template>

            <!-- Composition section -->
            <template v-if="activeSection === 'composition'">
              <p class="explain-intro">
                The composition treemap shows what types of content fill the context window and how much space each takes.
              </p>

              <div class="explain-category">
                <span class="cat-dot" style="background: #2563eb" />
                <div>
                  <strong>System prompt</strong>
                  <p>The model's instructions. Set once at the start. Usually stable across turns.</p>
                </div>
              </div>

              <div class="explain-category">
                <span class="cat-dot" style="background: #db2777" />
                <div>
                  <strong>Tool definitions</strong>
                  <p>JSON schemas describing available tools/functions. Sent with every request. Can be large when many tools are defined.</p>
                </div>
              </div>

              <div class="explain-category">
                <span class="cat-dot" style="background: #059669" />
                <div>
                  <strong>Tool results</strong>
                  <p>Data returned from tool calls (file reads, search results, command output). Often the fastest-growing category.</p>
                </div>
              </div>

              <div class="explain-category">
                <span class="cat-dot" style="background: #ec4899" />
                <div>
                  <strong>Tool calls</strong>
                  <p>The model's requests to invoke tools. Includes function name and arguments.</p>
                </div>
              </div>

              <div class="explain-category">
                <span class="cat-dot" style="background: #d97706" />
                <div>
                  <strong>Assistant text</strong>
                  <p>The model's natural language responses. The actual conversation output.</p>
                </div>
              </div>

              <div class="explain-category">
                <span class="cat-dot" style="background: #10b981" />
                <div>
                  <strong>User text</strong>
                  <p>Your messages to the model. Typically small relative to the rest.</p>
                </div>
              </div>

              <div class="explain-category">
                <span class="cat-dot" style="background: #8b5cf6" />
                <div>
                  <strong>Thinking</strong>
                  <p>Extended thinking/reasoning blocks. These are billed but don't persist in the context across turns (for most providers).</p>
                </div>
              </div>

              <div class="explain-category">
                <span class="cat-dot" style="background: #6366f1" />
                <div>
                  <strong>System injections</strong>
                  <p>Content the tool framework inserts alongside the system prompt (reminders, rules, tool instructions). Distinct from the main system prompt.</p>
                </div>
              </div>

              <div class="explain-category">
                <span class="cat-dot" style="background: #4b5563" />
                <div>
                  <strong>Images / Cache markers / Other</strong>
                  <p>Image tokens (estimated by resolution), cache control markers, and anything that doesn't fit the categories above.</p>
                </div>
              </div>
            </template>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.explain-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: flex-end;
}

.explain-panel {
  width: 380px;
  max-width: 90vw;
  height: 100%;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-dim);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.explain-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-dim);
}

.explain-title {
  @include sans-text;
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;

  i { color: var(--accent-blue); font-size: 16px; }
}

.explain-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
  transition: background 0.1s, color 0.1s;

  &:hover { background: var(--bg-hover); color: var(--text-primary); }

  i { font-size: 16px; }
}

.explain-tabs {
  display: flex;
  border-bottom: 1px solid var(--border-dim);
  padding: 0 var(--space-4);
}

.explain-tab {
  @include sans-text;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-muted);
  background: none;
  border: none;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.12s, border-color 0.12s;

  &:hover { color: var(--text-secondary); }
  &.active {
    color: var(--accent-blue);
    border-bottom-color: var(--accent-blue);
  }
}

.explain-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  @include scrollbar-thin;
}

.explain-intro {
  @include sans-text;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.6;
  margin: 0 0 var(--space-4);
}

.explain-audit {
  margin-bottom: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border-dim);

  &:last-of-type { border-bottom: none; }
}

.audit-name {
  @include sans-text;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: var(--space-1);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.audit-weight {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--accent-blue);
  background: var(--accent-blue-dim);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
}

.explain-audit p, .explain-category p {
  @include sans-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  line-height: 1.6;
  margin: 0;
}

.explain-caveat {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
  padding: var(--space-3);
  background: var(--accent-amber-dim, rgba(245, 158, 11, 0.06));
  border-radius: var(--radius-md);
  margin-top: var(--space-4);

  i {
    color: var(--accent-amber);
    font-size: 14px;
    flex-shrink: 0;
    margin-top: 2px;
  }

  p {
    @include sans-text;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.6;
    margin: 0;
  }
}

.explain-category {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  margin-bottom: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-dim);

  &:last-of-type { border-bottom: none; }

  strong {
    @include sans-text;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
    display: block;
    margin-bottom: 2px;
  }
}

.cat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 5px;
}

// --- Transition ---
.explain-enter-active,
.explain-leave-active {
  transition: opacity 0.2s ease;

  .explain-panel {
    transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }
}

.explain-enter-from,
.explain-leave-to {
  opacity: 0;

  .explain-panel {
    transform: translateX(100%);
  }
}
</style>
