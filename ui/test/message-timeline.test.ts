import { describe, expect, it } from 'vitest'
import {
  buildChronoMessages,
  buildTurnNumberMap,
  detectTurnBoundarySet,
  getMainTurnNumber,
  groupSubagentEntriesByTurnBoundary,
} from '@/utils/message-timeline'
import type { ParsedMessage, ProjectedEntry } from '@/api-types'

function msg(role: string, content: string, tokens = 1): ParsedMessage {
  return { role, content, tokens }
}

function entry(id: number, agentKey: string | null): ProjectedEntry {
  return {
    id,
    timestamp: `2026-01-01T00:00:0${id}.000Z`,
    contextInfo: {
      provider: 'anthropic',
      apiFormat: 'anthropic-messages',
      model: 'claude',
      systemTokens: 0,
      toolsTokens: 0,
      messagesTokens: 0,
      totalTokens: 0,
      systemPrompts: [],
      tools: [],
      messages: [],
    },
    response: { raw: true },
    contextLimit: 200000,
    source: 'claude',
    conversationId: 'conversation-1',
    agentKey,
    agentLabel: agentKey ?? 'main',
    httpStatus: 200,
    timings: null,
    requestBytes: 0,
    responseBytes: 0,
    targetUrl: null,
    composition: [],
    costUsd: null,
    healthScore: null,
    securityAlerts: [],
    outputSecurityAlerts: [],
    usage: null,
    responseModel: null,
    stopReason: null,
  }
}

describe('message timeline helpers', () => {
  it('re-inserts pruned ghosts and appends future messages without mutating current context order', () => {
    const current = [msg('user', 'kept user'), msg('assistant', 'kept assistant')]
    const latest = [...current, msg('user', 'future turn')]
    const ghost = msg('user', 'removed user')

    const result = buildChronoMessages({
      currentMessages: current,
      latestMessages: latest,
      prunedMessageIds: ['user:1'],
      includeFuture: true,
      findPrunedMessage: (idx) => (idx === 1 ? ghost : null),
    })

    expect(result.map((item) => item.msg.content)).toEqual([
      'kept user',
      'removed user',
      'kept assistant',
      'future turn',
    ])
    expect(result.map((item) => item.origIdx)).toEqual([0, 1, 2, 2])
    expect(result.map((item) => item.prunedGhost)).toEqual([false, true, false, false])
    expect(result.map((item) => item.future)).toEqual([false, false, false, true])
  })

  it('detects turn boundaries after assistant output and assigns offset turn numbers', () => {
    const items = [
      { msg: msg('user', 'one') },
      { msg: msg('assistant', 'reply') },
      { msg: msg('user', 'two') },
      { msg: msg('user', 'same turn continuation') },
      { msg: msg('assistant', 'reply two') },
      { msg: msg('user', 'three') },
    ]

    const boundaries = detectTurnBoundarySet(items)
    const turnNumbers = buildTurnNumberMap(boundaries, 3)

    expect(Array.from(boundaries)).toEqual([0, 2, 5])
    expect(Array.from(turnNumbers.entries())).toEqual([[0, 4], [2, 5], [5, 6]])
  })

  it('maps subagent entries to the boundary before the next main turn', () => {
    const newestFirst = [
      entry(5, 'main'),
      entry(4, 'sub'),
      entry(3, 'main'),
      entry(2, 'sub'),
      entry(1, 'main'),
    ]

    const grouped = groupSubagentEntriesByTurnBoundary({
      entriesNewestFirst: newestFirst,
      selectedEntryId: 5,
      boundaryIndices: [0, 4, 8],
      turnOffset: 0,
    })

    expect(Array.from(grouped.entries()).map(([boundary, entries]) => [boundary, entries.map((e) => e.id)])).toEqual([
      [4, [2]],
      [8, [4]],
    ])
    expect(getMainTurnNumber(newestFirst, 5)).toBe(3)
  })
})
