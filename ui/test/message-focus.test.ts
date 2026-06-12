import { describe, expect, it } from 'vitest'
import {
  extractToolFilePath,
  findFileRelatedMessageIndices,
  findIndexBySelectionSignature,
  messageSelectionSignature,
} from '@/utils/message-focus'
import type { ParsedMessage, ToolUseBlock } from '@/api-types'

function textMsg(role: string, content: string, tokens = 1): ParsedMessage {
  return { role, content, tokens }
}

function toolUse(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id, name, input }
}

describe('message focus helpers', () => {
  it('builds stable selection signatures for duplicate messages', () => {
    const items = [
      { msg: textMsg('user', 'repeat'), origIdx: 0 },
      { msg: textMsg('assistant', 'other'), origIdx: 1 },
      { msg: textMsg('user', 'repeat'), origIdx: 2 },
    ]

    const signature = messageSelectionSignature(items, 2)

    expect(signature?.ordinal).toBe(2)
    expect(findIndexBySelectionSignature(items, signature!.key, signature!.ordinal)).toBe(2)
  })

  it('normalizes tool file paths relative to the working directory', () => {
    const block = toolUse('tool-1', 'Read', { file_path: '/home/lars/project/src/main.ts' })

    expect(extractToolFilePath(block, '/home/lars/project')).toBe('src/main.ts')
  })

  it('finds tool calls and matching tool results for a focused file', () => {
    const messages: ParsedMessage[] = [
      {
        role: 'assistant',
        content: '',
        tokens: 5,
        contentBlocks: [toolUse('read-1', 'Read', { file_path: './src/main.ts' })],
      },
      {
        role: 'user',
        content: '',
        tokens: 20,
        contentBlocks: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'file content' }],
      },
      {
        role: 'assistant',
        content: '',
        tokens: 3,
        contentBlocks: [toolUse('read-2', 'Read', { file_path: './src/other.ts' })],
      },
    ]

    expect(Array.from(findFileRelatedMessageIndices(messages, 'src/main.ts'))).toEqual([0, 1])
  })
})
