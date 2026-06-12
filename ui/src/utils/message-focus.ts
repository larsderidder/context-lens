import type { ParsedMessage, ToolUseBlock } from '@/api-types'
import { makeRelative } from '@/utils/files'

export interface MessageListItem {
  msg: ParsedMessage
  origIdx: number
}

export interface MessageSelectionSignature {
  key: string
  ordinal: number
}

/**
 * Build a stable key for a message row across category and chronological views.
 * Ordinal matching handles repeated messages that would otherwise share a key.
 */
export function messageKey(msg: ParsedMessage): string {
  const first = (msg.contentBlocks || [])[0]
  if (!first) return `${msg.role}|${msg.tokens || 0}|${msg.content?.slice(0, 160) || ''}`

  if (first.type === 'tool_result') {
    const content = typeof first.content === 'string' ? first.content : JSON.stringify(first.content || '')
    return `${msg.role}|${msg.tokens || 0}|tool_result|${first.tool_use_id || ''}|${content.slice(0, 160)}`
  }

  if (first.type === 'tool_use') {
    return `${msg.role}|${msg.tokens || 0}|tool_use|${first.id || ''}|${first.name || ''}|${JSON.stringify(first.input || {}).slice(0, 120)}`
  }

  const anyFirst = first as unknown as Record<string, unknown>
  const text = String((anyFirst.text as string) || (anyFirst.thinking as string) || '').slice(0, 160)
  return `${msg.role}|${msg.tokens || 0}|${String(anyFirst.type || 'other')}|${text}`
}

export function messageSelectionSignature(items: MessageListItem[], index: number): MessageSelectionSignature | null {
  const item = items[index]
  if (!item) return null

  const key = messageKey(item.msg)
  let ordinal = 0
  for (let i = 0; i <= index; i++) {
    if (messageKey(items[i].msg) === key) ordinal += 1
  }

  return { key, ordinal: Math.max(1, ordinal) }
}

export function findIndexBySelectionSignature(items: MessageListItem[], key: string | null, ordinal: number): number {
  if (!key) return -1

  let seen = 0
  for (let i = 0; i < items.length; i++) {
    if (messageKey(items[i].msg) === key) {
      seen += 1
      if (seen === ordinal) return i
    }
  }

  return -1
}

/** Normalize user-facing file paths before comparing focus targets. */
export function normalizeToolFilePath(filePath: string): string {
  let result = filePath.replace(/\/+/g, '/')
  if (result.startsWith('./')) result = result.slice(2)
  if (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1)
  return result
}

/**
 * Extract a normalized file path from a tool call input.
 * The UI accepts common path key names because agents do not agree on one schema.
 */
export function extractToolFilePath(block: ToolUseBlock, workingDirectory?: string | null): string | null {
  const input = block.input
  if (!input || typeof input !== 'object') return null

  for (const key of ['file_path', 'path', 'filePath']) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) {
      return makeRelative(normalizeToolFilePath(value), workingDirectory)
    }
  }

  return null
}

/**
 * Find message rows connected to a file path through tool calls and their results.
 */
export function findFileRelatedMessageIndices(
  messages: ParsedMessage[],
  filePath: string,
  workingDirectory?: string | null,
): Set<number> {
  const indices = new Set<number>()
  const fileToolIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg.contentBlocks) continue

    for (const block of msg.contentBlocks) {
      if (block.type !== 'tool_use') continue
      const path = extractToolFilePath(block as ToolUseBlock, workingDirectory)
      if (path === filePath) {
        fileToolIds.add(block.id)
        indices.add(i)
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg.contentBlocks) continue

    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result' && fileToolIds.has(block.tool_use_id)) {
        indices.add(i)
      }
    }
  }

  return indices
}
