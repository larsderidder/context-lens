import type { ParsedMessage, ProjectedEntry, ContentBlock } from '@/api-types'

/** Category metadata — labels and colors matching the treemap */
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

/** Simple grouped categories for the treemap "simple" mode */
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

/** Classify a message into a composition category */
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

/** Build a map of tool_use_id → tool name from messages */
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

/** Extract a preview string for a message */
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

/** Extract full text content from a message (for copy) */
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

/** Convert a message to a raw JSON object (for raw view) */
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

/** Category ordering for message list grouping */
export const CATEGORY_ORDER = [
  'tool_results',
  'system_injections',
  'tool_calls',
  'thinking',
  'assistant_text',
  'user_text',
]

/** Group messages by category, maintaining category order */
export function groupMessagesByCategory(msgs: ParsedMessage[]): {
  category: string
  items: { msg: ParsedMessage; origIdx: number }[]
  tokens: number
}[] {
  const categories = new Map<string, { items: { msg: ParsedMessage; origIdx: number }[]; tokens: number }>()

  msgs.forEach((msg, i) => {
    const cat = classifyMessageRole(msg)
    if (!categories.has(cat)) categories.set(cat, { items: [], tokens: 0 })
    const group = categories.get(cat)!
    group.items.push({ msg, origIdx: i })
    group.tokens += msg.tokens || 0
  })

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

/** Classify entries into main/sub based on agent key frequency */
export function classifyEntries(entries: ProjectedEntry[]): { entry: ProjectedEntry; isMain: boolean }[] {
  const keyCounts = new Map<string, number>()
  for (const e of entries) {
    const k = e.agentKey || '_default'
    keyCounts.set(k, (keyCounts.get(k) || 0) + 1)
  }
  let mainKey = '_default'
  let maxCount = 0
  for (const [k, count] of keyCounts) {
    if (count > maxCount) { mainKey = k; maxCount = count }
  }
  return entries.map(e => ({
    entry: e,
    isMain: (e.agentKey || '_default') === mainKey,
  }))
}

/** Extract a short call summary from an entry */
export function extractCallSummary(e: ProjectedEntry): string {
  const msgs = e.contextInfo.messages
  if (!msgs || msgs.length === 0) return ''

  // Build tool name map first
  const toolNameMap: Record<string, string> = {}
  for (const m of msgs) {
    for (const b of (m.contentBlocks || [])) {
      if (b.type === 'tool_use' && b.id && b.name) toolNameMap[b.id] = b.name
    }
  }

  // Prefer latest tool call name with parameters
  for (let i = msgs.length - 1; i >= 0; i--) {
    const blocks = msgs[i].contentBlocks || []
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.name) {
        const name = b.name
        // Extract key parameter for common tools
        if (b.input && typeof b.input === 'object') {
          const inp = b.input as Record<string, any>
          if (name === 'bash' && inp.command) {
            const cmd = String(inp.command).replace(/\s+/g, ' ').trim()
            return `${name}: ${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}`
          }
          if (name === 'read' && inp.path) {
            return `${name}: ${inp.path}`
          }
          if (name === 'edit' && inp.path) {
            return `${name}: ${inp.path}`
          }
          if (name === 'write' && inp.path) {
            return `${name}: ${inp.path}`
          }
          // Generic: show first string value
          const firstVal = Object.values(inp).find(v => typeof v === 'string' && v.length > 0 && v.length < 200)
          if (firstVal) {
            const val = String(firstVal).replace(/\s+/g, ' ').trim()
            return `${name}: ${val.slice(0, 40)}${val.length > 40 ? '…' : ''}`
          }
        }
        return name
      }
      if (b.type === 'tool_result' && b.tool_use_id && toolNameMap[b.tool_use_id]) {
        return toolNameMap[b.tool_use_id]
      }
    }
  }

  // Fallback: latest user plain text (skip JSON-like strings)
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && msgs[i].content) {
      const text = msgs[i].content.replace(/\s+/g, ' ').trim()
      // Skip JSON-like content
      if (text.startsWith('[') || text.startsWith('{')) continue
      if (text) return text.length > 40 ? text.slice(0, 40) + '…' : text
    }
  }
  return ''
}

/** Extract input tool names from an entry's latest messages */
export function extractInputTools(e: ProjectedEntry): string[] {
  const msgs = e.contextInfo.messages
  if (!msgs) return []
  const tools: string[] = []
  for (let i = msgs.length - 1; i >= 0 && i > msgs.length - 5; i--) {
    const m = msgs[i]
    if (m.contentBlocks) {
      for (const b of m.contentBlocks) {
        if (b.type === 'tool_result') {
          // Try to find tool name
          const anyBlock = b as unknown as Record<string, unknown>
          if (anyBlock.tool_use_id) {
            // We don't have the map here, just note it
            tools.push(String(anyBlock.tool_use_id).slice(0, 8))
          }
        }
      }
    }
  }
  return tools
}
