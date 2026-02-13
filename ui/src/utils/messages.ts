import type { ParsedMessage, ProjectedEntry } from '@/api-types'

export interface ClassifiedEntry {
  entry: ProjectedEntry
  isMain: boolean
}

/** Per-category labels and colors shared with the composition treemap. */
export const CATEGORY_META: Record<string, { label: string; color: string }> = {
  system_prompt: { label: 'System prompt', color: '#2563eb' },
  tool_definitions: { label: 'Tool definitions', color: '#db2777' },
  tool_results: { label: 'Tool results', color: '#059669' },
  tool_calls: { label: 'Tool calls', color: '#ec4899' },
  assistant_text: { label: 'Assistant text', color: '#d97706' },
  user_text: { label: 'User text', color: '#10b981' },
  thinking: { label: 'Thinking', color: '#8b5cf6' },
  system_injections: { label: 'System injections', color: '#6366f1' },
  images: { label: 'Images', color: '#4b5563' },
  cache_markers: { label: 'Cache markers', color: '#6b7280' },
  other: { label: 'Other', color: '#4b5563' },
}

export function getCategoryLabel(category: string): string {
  return CATEGORY_META[category]?.label ?? category
}

export function getCategoryColor(category: string, fallback = '#475569'): string {
  return CATEGORY_META[category]?.color ?? fallback
}

/** Group map used by the treemap "simple" mode. */
export const SIMPLE_GROUPS: Record<string, string[]> = {
  system: ['system_prompt', 'system_injections'],
  tools: ['tool_definitions', 'tool_calls', 'tool_results'],
  conversation: ['assistant_text', 'user_text', 'thinking'],
  other: ['images', 'cache_markers', 'other'],
}

export const SIMPLE_META: Record<string, { label: string; color: string }> = {
  system: { label: 'System', color: '#2563eb' },
  tools: { label: 'Tools', color: '#db2777' },
  conversation: { label: 'Conversation', color: '#d97706' },
  other: { label: 'Other', color: '#4b5563' },
}

/** Classify a parsed message into one of the composition categories. */
export function classifyMessageRole(msg: ParsedMessage): string {
  const role = msg.role || 'user'
  const content = msg.content || ''
  const blocks = msg.contentBlocks

  if (blocks && Array.isArray(blocks)) {
    const hasToolUse = blocks.some((b) => b.type === 'tool_use')
    const hasToolResult = blocks.some((b) => b.type === 'tool_result')
    const hasThinking = blocks.some((b) => (b as unknown as Record<string, unknown>).type === 'thinking')
    if (hasToolResult) return 'tool_results'
    if (hasToolUse) return 'tool_calls'
    if (hasThinking) return 'thinking'
  }

  if (typeof content === 'string' && content.includes('<system-reminder>')) return 'system_injections'
  if (role === 'assistant') return 'assistant_text'
  if (role === 'user') return 'user_text'
  return 'other'
}

/** Build a map from `tool_use` block id to tool name. */
export function buildToolNameMap(msgs: ParsedMessage[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const m of msgs) {
    if (m.contentBlocks) {
      for (const b of m.contentBlocks) {
        if (b.type === 'tool_use' && b.id && b.name) {
          map[b.id] = b.name
        }
      }
    }
  }
  return map
}

/** Build a short, human-readable preview for a message row. */
export function extractPreview(msg: ParsedMessage, toolNameMap: Record<string, string> = {}): string {
  const blocks = msg.contentBlocks
  if (blocks && Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        return (b.name || 'tool') + '(' + (b.input ? JSON.stringify(b.input).slice(0, 60) : '') + ')'
      }
      if (b.type === 'tool_result') {
        const toolName = b.tool_use_id ? toolNameMap[b.tool_use_id] : null
        const rc = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')
        const prefix = toolName ? toolName + ': ' : ''
        return prefix + rc.slice(0, 80 - prefix.length)
      }
      const anyBlock = b as unknown as Record<string, unknown>
      if (anyBlock.type === 'thinking') {
        return ((anyBlock.thinking as string) || (anyBlock.text as string) || '').slice(0, 80)
      }
      if (b.type === 'text' || b.type === 'input_text') {
        return (b.text || '').slice(0, 80)
      }
    }
  }
  return (msg.content || '').slice(0, 80)
}

/** Convert a message into full plain text for clipboard/export actions. */
export function extractFullText(msg: ParsedMessage): string {
  if (msg.contentBlocks && msg.contentBlocks.length > 0) {
    return msg.contentBlocks.map((b) => {
      if (b.type === 'tool_use') return b.name + '(' + JSON.stringify(b.input, null, 2) + ')'
      if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2)
      const anyBlock = b as unknown as Record<string, unknown>
      if (anyBlock.type === 'thinking') return (anyBlock.thinking as string) || (anyBlock.text as string) || ''
      if (b.type === 'text' || b.type === 'input_text') return b.text || ''
      return JSON.stringify(b, null, 2)
    }).join('\n\n')
  }
  return msg.content || ''
}

/** Convert a parsed message into a raw-object view payload. */
export function msgToRawObject(msg: ParsedMessage): Record<string, unknown> {
  const obj: Record<string, unknown> = { role: msg.role }
  if (msg.contentBlocks && msg.contentBlocks.length > 0) {
    obj.content = msg.contentBlocks
  } else {
    try {
      obj.content = JSON.parse(msg.content)
    } catch {
      obj.content = msg.content
    }
  }
  obj._tokens = msg.tokens
  return obj
}

/** Fixed category ordering used by the message list UI. */
const CATEGORY_ORDER = [
  'tool_results',
  'system_injections',
  'tool_calls',
  'thinking',
  'assistant_text',
  'user_text',
]

/** Group messages by category while preserving the UI category order. */
export function groupMessagesByCategory(msgs: ParsedMessage[]): {
  category: string
  items: { msg: ParsedMessage; origIdx: number }[]
  tokens: number
}[] {
  const categories = new Map<string, { items: { msg: ParsedMessage; origIdx: number }[]; tokens: number }>()

  // Newest-first within each category for faster access to recent activity.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    const cat = classifyMessageRole(msg)
    if (!categories.has(cat)) categories.set(cat, { items: [], tokens: 0 })
    const group = categories.get(cat)!
    group.items.push({ msg, origIdx: i })
    group.tokens += msg.tokens || 0
  }

  // Build ordered list
  const order = [...CATEGORY_ORDER]
  for (const cat of categories.keys()) {
    if (!order.includes(cat)) order.push(cat)
  }

  return order
    .filter((cat) => categories.has(cat))
    .map((cat) => ({
      category: cat,
      ...categories.get(cat)!,
    }))
}

/** Mark entries as main/sub by majority vote on agent key (most common = main). */
export function classifyEntries(entries: ProjectedEntry[]): ClassifiedEntry[] {
  if (entries.length === 0) return []

  // The agent key that appears most often is the main agent.
  // This matches the backend heuristic in buildLharRecord.
  const keyCounts = new Map<string, number>()
  for (const e of entries) {
    const k = e.agentKey || '_default'
    keyCounts.set(k, (keyCounts.get(k) || 0) + 1)
  }

  let mainKey = '_default'
  let maxCount = 0
  for (const [k, count] of keyCounts) {
    if (count > maxCount) {
      mainKey = k
      maxCount = count
    }
  }

  return entries.map(e => ({
    entry: e,
    isMain: (e.agentKey || '_default') === mainKey,
  }))
}
