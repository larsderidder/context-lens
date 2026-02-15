<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { ParsedMessage, ProjectedEntry } from '@/api-types'
import { fmtTokens } from '@/utils/format'
import { classifyMessageRole, CATEGORY_META, buildToolNameMap, extractFullText, msgToRawObject } from '@/utils/messages'

const props = defineProps<{
  entry: ProjectedEntry
  messages: { msg: ParsedMessage; origIdx: number }[]
  selectedIndex: number
}>()

const emit = defineEmits<{
  close: []
  navigate: [index: number]
}>()

const tab = ref<'rendered' | 'raw'>('rendered')
const showAll = ref(false)
const contentEl = ref<HTMLElement | null>(null)
const MAX_CHARS = 50000
const MAX_LINES = 500
const SHIKI_MAX_CHARS = 20000
const SHIKI_MAX_LINES = 450
type ContentKind = 'json' | 'xml' | 'markdown' | 'code' | 'text'
let shikiHighlighter: any | null = null
let shikiLoading: Promise<void> | null = null
const shikiCache = new Map<string, string>()
const shikiPending = new Set<string>()
const shikiVersion = ref(0)

const msg = computed(() => props.messages[props.selectedIndex]?.msg ?? null)
const toolNameMap = computed(() => buildToolNameMap(props.entry.contextInfo.messages || []))

const titleText = computed(() => {
  const m = msg.value
  if (!m) return ''
  const cat = classifyMessageRole(m)
  const meta = CATEGORY_META[cat] || { label: cat }
  let title = meta.label
  if (m.contentBlocks) {
    for (const b of m.contentBlocks) {
      if (b.type === 'tool_use') { title = `Tool Call — ${b.name || 'unknown'}`; break }
      if (b.type === 'tool_result') {
        const tn = b.tool_use_id ? toolNameMap.value[b.tool_use_id] : null
        title = `Tool Result${tn ? ' — ' + tn : ''}`
        break
      }
      const any = b as unknown as Record<string, unknown>
      if (any.type === 'thinking') { title = 'Thinking'; break }
    }
  }
  return title
})

const titleColor = computed(() => {
  if (!msg.value) return ''
  const cat = classifyMessageRole(msg.value)
  return (CATEGORY_META[cat] || { color: '#4b5563' }).color
})

const tokPct = computed(() => {
  if (!msg.value || !props.entry.contextInfo.totalTokens) return '0'
  return ((msg.value.tokens || 0) / props.entry.contextInfo.totalTokens * 100).toFixed(1)
})

const canPrev = computed(() => props.selectedIndex > 0)
const canNext = computed(() => props.selectedIndex < props.messages.length - 1)

watch(() => props.selectedIndex, () => {
  tab.value = 'rendered'
  showAll.value = false
  nextTick(() => { if (contentEl.value) contentEl.value.scrollTop = 0 })
  nextTick(() => { maybePrimeShiki() })
})

watch([tab, showAll], () => {
  nextTick(() => { maybePrimeShiki() })
})

watch(msg, () => {
  nextTick(() => { maybePrimeShiki() })
}, { immediate: true })

function navigate(dir: number) {
  const newIdx = props.selectedIndex + dir
  if (newIdx >= 0 && newIdx < props.messages.length) emit('navigate', newIdx)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { emit('close'); e.preventDefault() }
  if (e.key === 'ArrowUp' || e.key === 'k') { navigate(-1); e.preventDefault() }
  if (e.key === 'ArrowDown' || e.key === 'j') { navigate(1); e.preventDefault() }
}

const copyLabel = ref('Copy')
async function handleCopy() {
  if (!msg.value) return
  const text = tab.value === 'raw'
    ? JSON.stringify(msgToRawObject(msg.value), null, 2)
    : extractFullText(msg.value)
  await navigator.clipboard.writeText(text)
  copyLabel.value = 'Copied!'
  setTimeout(() => { copyLabel.value = 'Copy' }, 1500)
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (showAll.value) return { text, truncated: false }
  if (text.length > MAX_CHARS) return { text: text.slice(0, MAX_CHARS), truncated: true }
  const lines = text.split('\n')
  if (lines.length > MAX_LINES) return { text: lines.slice(0, MAX_LINES).join('\n'), truncated: true }
  return { text, truncated: false }
}

function hashText(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function tokenReplace(
  text: string,
  regex: RegExp,
  renderMatch: (match: string, index: number) => string,
): string {
  let out = ''
  let last = 0
  regex.lastIndex = 0
  let m: RegExpExecArray | null = regex.exec(text)
  while (m) {
    const idx = m.index
    const full = m[0]
    out += escapeHtml(text.slice(last, idx))
    out += renderMatch(full, idx)
    last = idx + full.length
    m = regex.exec(text)
  }
  out += escapeHtml(text.slice(last))
  return out
}

function highlightJson(text: string): string {
  const tokenRe = /"(?:\\.|[^"\\])*"(?=\s*:)?|"(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g
  return tokenReplace(text, tokenRe, (tok, idx) => {
    if (tok.startsWith('"')) {
      const rest = text.slice(idx + tok.length)
      const isKey = /^\s*:/.test(rest)
      return `<span class="${isKey ? 'syn-key' : 'syn-str'}">${escapeHtml(tok)}</span>`
    }
    if (tok === 'true' || tok === 'false') return `<span class="syn-bool">${tok}</span>`
    if (tok === 'null') return `<span class="syn-null">${tok}</span>`
    return `<span class="syn-num">${tok}</span>`
  })
}

function highlightXml(text: string): string {
  const tagRe = /<!--[\s\S]*?-->|<\/?[\w:.-]+(?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*\s*\/?>/g
  return tokenReplace(text, tagRe, (tok) => {
    if (tok.startsWith('<!--')) return `<span class="syn-com">${escapeHtml(tok)}</span>`
    const m = /^<(\/?)([\w:.-]+)([\s\S]*?)(\/?)>$/.exec(tok)
    if (!m) return `<span class="syn-tag">${escapeHtml(tok)}</span>`
    const close = m[1] ? '/' : ''
    const name = m[2]
    const attrs = m[3] || ''
    const selfClose = m[4] ? '/' : ''
    let attrOut = ''
    const attrRe = /([\w:.-]+)(\s*=\s*)(".*?"|'.*?')/g
    let last = 0
    let am: RegExpExecArray | null = attrRe.exec(attrs)
    while (am) {
      attrOut += escapeHtml(attrs.slice(last, am.index))
      attrOut += `<span class="syn-attr">${escapeHtml(am[1])}</span>`
      attrOut += escapeHtml(am[2])
      attrOut += `<span class="syn-str">${escapeHtml(am[3])}</span>`
      last = am.index + am[0].length
      am = attrRe.exec(attrs)
    }
    attrOut += escapeHtml(attrs.slice(last))
    return `<span class="syn-punc">&lt;${close}</span><span class="syn-tag">${escapeHtml(name)}</span>${attrOut}<span class="syn-punc">${selfClose}&gt;</span>`
  })
}

function highlightMarkdown(text: string): string {
  const mdRe = /```[\s\S]*?```|`[^`\n]+`|^#{1,6}\s.+$|^\s*[-*+]\s.+$|^\s*\d+\.\s.+$|^>\s.+$|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~|\[[^\]]+\]\([^)]+\)/gm
  return tokenReplace(text, mdRe, (tok) => {
    if (tok.startsWith('```') || tok.startsWith('`')) return `<span class="syn-code">${escapeHtml(tok)}</span>`
    if (tok.startsWith('#')) return `<span class="syn-heading">${escapeHtml(tok)}</span>`
    if (/^\s*[-*+]\s/.test(tok) || /^\s*\d+\.\s/.test(tok)) return `<span class="syn-list">${escapeHtml(tok)}</span>`
    if (tok.startsWith('>')) return `<span class="syn-quote">${escapeHtml(tok)}</span>`
    if (tok.startsWith('[')) return `<span class="syn-link">${escapeHtml(tok)}</span>`
    return `<span class="syn-em">${escapeHtml(tok)}</span>`
  })
}

function highlightCode(text: string): string {
  const codeRe = /\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|class|extends|new|import|from|export|async|await|interface|type|public|private|protected|throw|in|of|typeof|instanceof|true|false|null|undefined)\b|-?\d+(?:\.\d+)?/gm
  return tokenReplace(text, codeRe, (tok) => {
    if (tok.startsWith('//') || tok.startsWith('/*')) return `<span class="syn-com">${escapeHtml(tok)}</span>`
    if (tok.startsWith('"') || tok.startsWith('\'') || tok.startsWith('`')) return `<span class="syn-str">${escapeHtml(tok)}</span>`
    if (/^-?\d/.test(tok)) return `<span class="syn-num">${tok}</span>`
    if (tok === 'true' || tok === 'false') return `<span class="syn-bool">${tok}</span>`
    if (tok === 'null' || tok === 'undefined') return `<span class="syn-null">${tok}</span>`
    return `<span class="syn-keyword">${tok}</span>`
  })
}

function isJsonLike(text: string): boolean {
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

function isXmlLike(text: string): boolean {
  const t = text.trim()
  if (!t.startsWith('<')) return false
  return /<[\w:.-]+[\s>]/.test(t) && /<\/[\w:.-]+>/.test(t)
}

function isMarkdownLike(text: string): boolean {
  return /(^#{1,6}\s)|(^\s*[-*+]\s)|(^\s*\d+\.\s)|(```)|(`[^`\n]+`)|(\[[^\]]+\]\([^)]+\))|(^>\s)|(\*\*[^*\n]+\*\*)/m.test(text)
}

function isCodeLike(text: string): boolean {
  return /[{}();]|(^\s*(const|let|var|function|if|for|while|class|import|export)\s)/m.test(text)
}

function contentKind(text: string, forceJson = false): ContentKind {
  if (forceJson) return 'json'
  if (isJsonLike(text)) return 'json'
  if (isXmlLike(text)) return 'xml'
  if (isMarkdownLike(text)) return 'markdown'
  if (isCodeLike(text)) return 'code'
  return 'text'
}

function highlightTextFallback(text: string, forceJson = false): string {
  const kind = contentKind(text, forceJson)
  if (kind === 'json') return highlightJson(text)
  if (kind === 'xml') return highlightXml(text)
  if (kind === 'markdown') return highlightMarkdown(text)
  if (kind === 'code') return highlightCode(text)
  return escapeHtml(text)
}

function languageFor(kind: ContentKind): string | null {
  if (kind === 'json') return 'json'
  if (kind === 'xml') return 'xml'
  if (kind === 'markdown') return 'markdown'
  if (kind === 'code') return 'typescript'
  return null
}

function shouldUseShiki(text: string, kind: ContentKind): boolean {
  if (kind === 'text') return false
  if (text.length > SHIKI_MAX_CHARS) return false
  if (text.split('\n').length > SHIKI_MAX_LINES) return false
  return true
}

async function ensureShiki(): Promise<void> {
  if (shikiHighlighter) return
  if (shikiLoading) return shikiLoading
  shikiLoading = (async () => {
    const { createHighlighterCore } = await import('shiki/core')
    const { createOnigurumaEngine } = await import('shiki/engine/oniguruma')
    shikiHighlighter = await createHighlighterCore({
      engine: createOnigurumaEngine(import('shiki/wasm')),
      themes: [import('shiki/themes/github-dark.mjs')],
      langs: [
        import('shiki/langs/json.mjs'),
        import('shiki/langs/jsonc.mjs'),
        import('shiki/langs/yaml.mjs'),
        import('shiki/langs/xml.mjs'),
        import('shiki/langs/html.mjs'),
        import('shiki/langs/css.mjs'),
        import('shiki/langs/markdown.mjs'),
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/javascript.mjs'),
        import('shiki/langs/jsx.mjs'),
        import('shiki/langs/tsx.mjs'),
        import('shiki/langs/python.mjs'),
        import('shiki/langs/shellscript.mjs'),
        import('shiki/langs/sql.mjs'),
        import('shiki/langs/diff.mjs'),
        import('shiki/langs/toml.mjs'),
        import('shiki/langs/rust.mjs'),
        import('shiki/langs/go.mjs'),
        import('shiki/langs/c.mjs'),
        import('shiki/langs/cpp.mjs'),
        import('shiki/langs/java.mjs'),
        import('shiki/langs/ruby.mjs'),
        import('shiki/langs/php.mjs'),
        import('shiki/langs/swift.mjs'),
        import('shiki/langs/kotlin.mjs'),
        import('shiki/langs/graphql.mjs'),
        import('shiki/langs/dockerfile.mjs'),
      ],
    })
  })()
  await shikiLoading
}

async function queueShiki(text: string, kind: ContentKind, cacheKey: string): Promise<void> {
  if (!shouldUseShiki(text, kind)) return
  if (shikiCache.has(cacheKey) || shikiPending.has(cacheKey)) return
  const lang = languageFor(kind)
  if (!lang) return
  shikiPending.add(cacheKey)
  try {
    await ensureShiki()
    if (!shikiHighlighter) return
    const html = shikiHighlighter.codeToHtml(text, { lang, theme: 'github-dark' })
    shikiCache.set(cacheKey, html)
    shikiVersion.value += 1
  } catch {
    // Keep fast fallback when Shiki is unavailable.
  } finally {
    shikiPending.delete(cacheKey)
  }
}

function highlightText(text: string, forceJson = false): string {
  void shikiVersion.value
  const kind = contentKind(text, forceJson)
  const key = `${kind}:${hashText(text)}`
  if (shouldUseShiki(text, kind)) {
    const cached = shikiCache.get(key)
    if (cached) return cached
    void queueShiki(text, kind, key)
  }
  return highlightTextFallback(text, forceJson)
}

function maybePrimeShiki(): void {
  const m = msg.value
  if (!m) return
  if (tab.value === 'raw') {
    const raw = JSON.stringify(msgToRawObject(m), null, 2)
    const text = truncate(raw).text
    const kind = contentKind(text, true)
    void queueShiki(text, kind, `${kind}:${hashText(text)}`)
    return
  }
  const blocks = getRenderedBlocks()
  for (const block of blocks) {
    const text = truncate(block.content).text
    const kind = contentKind(text, block.isJson)
    void queueShiki(text, kind, `${kind}:${hashText(text)}`)
  }
}

function getRenderedBlocks(): { type: string; label: string; labelClass: string; content: string; isJson: boolean }[] {
  const m = msg.value
  if (!m) return []
  const blocks = m.contentBlocks
  if (blocks && blocks.length > 0) {
    return blocks.map(b => {
      if (b.type === 'tool_use') {
        const params = b.input ? JSON.stringify(b.input, null, 2) : '{}'
        return { type: 'tool_use', label: `tool_use: ${b.name || '?'}`, labelClass: 'lbl-tool-use', content: params, isJson: true }
      }
      if (b.type === 'tool_result') {
        const tn = b.tool_use_id ? toolNameMap.value[b.tool_use_id] : null
        const rc = typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2)
        return { type: 'tool_result', label: `tool_result${tn ? ': ' + tn : ''}`, labelClass: 'lbl-tool-result', content: rc, isJson: false }
      }
      const any = b as unknown as Record<string, unknown>
      if (any.type === 'thinking') {
        return { type: 'thinking', label: 'thinking', labelClass: 'lbl-thinking', content: (any.thinking as string) || (any.text as string) || '', isJson: false }
      }
      if (b.type === 'text' || b.type === 'input_text') {
        return { type: b.type, label: b.type, labelClass: 'lbl-text', content: b.text || '', isJson: false }
      }
      if (b.type === 'image') {
        return { type: 'image', label: 'image', labelClass: 'lbl-image', content: '[Image content]', isJson: false }
      }
      return { type: 'unknown', label: 'block', labelClass: 'lbl-text', content: `[Unknown block type: ${(b as any).type || 'unspecified'}]`, isJson: false }
    })
  }
  return [{ type: 'text', label: '', labelClass: '', content: m.content || '', isJson: false }]
}

const metaPairs = computed((): [string, string][] => {
  const m = msg.value
  if (!m) return []
  const pairs: [string, string][] = [
    ['Role', m.role],
    ['Tokens', fmtTokens(m.tokens || 0)],
    ['% context', tokPct.value + '%'],
    ['Model', props.entry.contextInfo.model || '?'],
  ]
  if (m.contentBlocks) {
    for (const b of m.contentBlocks) {
      if (b.type === 'tool_use') {
        pairs.push(['tool_use_id', b.id || '?'])
        pairs.push(['tool_name', b.name || '?'])
      }
      if (b.type === 'tool_result' && b.tool_use_id) {
        pairs.push(['tool_use_id', b.tool_use_id])
        const tn = toolNameMap.value[b.tool_use_id]
        if (tn) pairs.push(['tool_name', tn])
      }
    }
  }
  pairs.push(['Position', `${props.selectedIndex + 1} / ${props.messages.length}`])
  return pairs
})
</script>

<template>
  <div class="detail" tabindex="0" @keydown="handleKeydown">
    <!-- ── Header ── -->
    <div class="detail-header">
      <div class="header-top">
        <span class="detail-title" :style="{ color: titleColor }">{{ titleText }}</span>
        <div class="nav-btns">
          <button :disabled="!canPrev" @click="navigate(-1)" v-tooltip="'↑ Previous'"><i class="i-carbon-chevron-up" /></button>
          <button :disabled="!canNext" @click="navigate(1)" v-tooltip="'↓ Next'"><i class="i-carbon-chevron-down" /></button>
        </div>
        <button class="close-btn" @click="$emit('close')" v-tooltip="'Close (Esc)'">
          <i class="i-carbon-close" />
        </button>
      </div>
      <div class="header-meta" v-if="msg">
        <span><b>{{ msg.role }}</b></span>
        <span>{{ fmtTokens(msg.tokens || 0) }} tok</span>
        <span>{{ tokPct }}%</span>
        <span>{{ selectedIndex + 1 }}/{{ messages.length }}</span>
      </div>
    </div>

    <!-- ── Tabs ── -->
    <div class="detail-tabs">
      <button :class="{ on: tab === 'rendered' }" @click="tab = 'rendered'">Rendered</button>
      <button :class="{ on: tab === 'raw' }" @click="tab = 'raw'">Raw</button>
    </div>

    <!-- ── Content ── -->
    <div ref="contentEl" class="detail-body">
      <template v-if="tab === 'rendered' && msg">
        <template v-for="(block, i) in getRenderedBlocks()" :key="i">
          <hr v-if="i > 0" class="block-sep" />
          <div v-if="block.label" class="block-label" :class="block.labelClass">{{ block.label }}</div>
          <div
            class="block-content syntax rich-html"
            :class="`kind-${contentKind(truncate(block.content).text, block.isJson)}`"
            v-html="highlightText(truncate(block.content).text, block.isJson)"
          ></div>
          <button v-if="truncate(block.content).truncated" class="show-more" @click="showAll = true">
            Show full content…
          </button>
        </template>
      </template>
      <template v-else-if="tab === 'raw' && msg">
        <div class="raw-header">
          <button class="copy-btn" :class="{ copied: copyLabel === 'Copied!' }" @click="handleCopy">
            <i class="i-carbon-copy" />
            {{ copyLabel }}
          </button>
        </div>
        <div
          class="block-content syntax rich-html kind-json"
          v-html="highlightText(JSON.stringify(msgToRawObject(msg), null, 2), true)"
        ></div>
      </template>
    </div>

    <!-- ── Footer meta ── -->
    <div class="detail-footer">
      <div class="meta-header">Metadata</div>
      <template v-for="([label, val]) in metaPairs" :key="label">
        <span class="meta-key">{{ label }}</span>
        <span class="meta-val" :title="val">{{ val }}</span>
      </template>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.detail {
  height: 100%;
  background: var(--bg-field);
  border-left: 1px solid var(--border-dim);
  display: flex;
  flex-direction: column;
  outline: none;
}

// ── Header ──
.detail-header {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-dim);
  flex-shrink: 0;
}

.header-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.close-btn {
  @include mono-text;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: none;
  border: none;
  display: flex;
  align-items: center;
  transition: color 0.1s, background 0.1s;
  flex-shrink: 0;
  margin-left: auto;

  &:hover { color: var(--text-primary); background: var(--bg-hover); }
}

.detail-title {
  @include truncate;
  font-size: var(--text-sm);
  font-weight: 600;
  flex: 1;
}

.copy-btn {
  @include mono-text;
  font-size: 9px;
  color: var(--text-muted);
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 3px;
  transition: color 0.12s, border-color 0.12s;
  flex-shrink: 0;

  &:hover { color: var(--accent-blue); border-color: var(--accent-blue); }
  &.copied { color: var(--accent-green); border-color: var(--accent-green); }

  i { font-size: 10px; }
}

.nav-btns {
  display: flex;
  gap: 2px;
  flex-shrink: 0;

  button {
    @include mono-text;
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.1s, border-color 0.1s;

    &:hover:not(:disabled) { color: var(--accent-blue); border-color: var(--accent-blue); }
    &:disabled { opacity: 0.25; cursor: default; }
  }
}

.header-meta {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-dim);
  margin-top: 5px;
  display: flex;
  gap: var(--space-3);

  b { color: var(--text-secondary); font-weight: 600; }
}

// ── Tabs ──
.detail-tabs {
  display: flex;
  border-bottom: 1px solid var(--border-dim);
  flex-shrink: 0;

  button {
    font-size: var(--text-xs);
    color: var(--text-muted);
    padding: 7px var(--space-4);
    cursor: pointer;
    border: none;
    border-bottom: 2px solid transparent;
    background: none;
    transition: color 0.1s, border-color 0.1s;

    &:hover { color: var(--text-secondary); }
    &.on { color: var(--accent-blue); border-bottom-color: var(--accent-blue); }
  }
}

// ── Body ──
.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  @include scrollbar-thin;
}

.raw-header {
  display: flex;
  justify-content: flex-end;
  padding: var(--space-2) var(--space-4) 0;
  flex-shrink: 0;
}

.block-sep {
  border: none;
  border-top: 1px solid var(--border-dim);
  margin: var(--space-3) 0;
}

.block-label {
  display: inline-block;
  @include mono-text;
  font-size: 8px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 1px 6px;
  border-radius: 2px;
  margin-bottom: 6px;

  &.lbl-tool-use { background: rgba(244, 114, 182, 0.10); color: #f472b6; }
  &.lbl-tool-result { background: rgba(16, 185, 129, 0.10); color: #10b981; }
  &.lbl-thinking { background: rgba(167, 139, 250, 0.10); color: #a78bfa; }
  &.lbl-text { background: rgba(251, 191, 36, 0.08); color: #fbbf24; }
  &.lbl-image { background: rgba(75, 85, 99, 0.15); color: #9ca3af; }
}

.block-content {
  @include mono-text;
  font-size: var(--text-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  margin: 0;
}

.syntax {
  :deep(.syn-key) { color: #93c5fd; }
  :deep(.syn-keyword) { color: #60a5fa; }
  :deep(.syn-str) { color: #86efac; }
  :deep(.syn-num) { color: #fbbf24; }
  :deep(.syn-bool) { color: #c4b5fd; }
  :deep(.syn-null) { color: #fda4af; }
  :deep(.syn-com) { color: var(--text-dim); }
  :deep(.syn-tag) { color: #60a5fa; }
  :deep(.syn-attr) { color: #93c5fd; }
  :deep(.syn-punc) { color: var(--text-muted); }
  :deep(.syn-code) { color: #67e8f9; }
  :deep(.syn-heading) { color: #f59e0b; font-weight: 600; }
  :deep(.syn-list) { color: #38bdf8; }
  :deep(.syn-quote) { color: #a78bfa; }
  :deep(.syn-link) { color: #22d3ee; text-decoration: underline; }
  :deep(.syn-em) { color: #f5d0fe; }
}

.rich-html {
  white-space: pre-wrap;

  :deep(pre.shiki) {
    margin: 0;
    padding: 0 !important;
    background: transparent !important;
    white-space: pre-wrap !important;
    word-break: break-word;
    overflow-x: auto;
    font-family: var(--font-mono) !important;
    font-size: inherit !important;
    line-height: inherit !important;
  }

  :deep(pre.shiki code) {
    white-space: inherit !important;
    font-family: inherit !important;
    font-size: inherit !important;
    line-height: inherit !important;
  }
}

.show-more {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--accent-blue);
  cursor: pointer;
  padding: 4px 0;
  background: none;
  border: none;
  transition: color 0.1s;

  &:hover { color: var(--text-primary); }
}

// ── Footer ──
.detail-footer {
  border-top: 1px solid var(--border-dim);
  padding: var(--space-2) var(--space-4);
  flex-shrink: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px var(--space-4);
  @include mono-text;
  font-size: 12px;
}

.meta-header {
  grid-column: 1 / -1;
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 2px;
}

.meta-key { color: var(--text-dim); }
.meta-val {
  @include truncate;
  color: var(--text-dim);
  text-align: right;
}
</style>
