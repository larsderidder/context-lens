import { afterEach, describe, expect, it, vi } from 'vitest'
import { sumCosts } from '@/utils/cost'
import { loadSharedSession } from '@/utils/shared-session'

const cases: { costs: (number | null)[]; expected: number | null }[] = [
  { costs: [], expected: 0 },
  { costs: [null, null], expected: null },
  { costs: [0.25, null], expected: null },
  { costs: [0, 0], expected: 0 },
  { costs: [0.25, 0.5], expected: 0.75 },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cost completeness', () => {
  it.each(cases)('sums $costs as $expected', ({ costs, expected }) => {
    expect(sumCosts(costs)).toBe(expected)
  })

  for (const withSession of [true, false]) {
    it.each(cases)('imports $costs without replacing unknown costs, declared session: ' + withSession, async ({ costs, expected }) => {
      const entries = costs.map((cost, index) => ({
        id: String(index), trace_id: 'trace', span_id: String(index), parent_span_id: null,
        timestamp: '2026-01-01T00:00:00Z', sequence: index,
        source: { tool: 'fixture', agent_role: 'main' },
        gen_ai: {
          system: 'anthropic', request: { model: 'unpriced', max_tokens: null },
          response: { model: null, finish_reasons: [] },
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
        usage_ext: { cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0, cost_usd: cost },
        http: { method: 'POST', url: null, status_code: 200, api_format: 'anthropic-messages', stream: false },
        timings: null, transfer: { request_bytes: 0, response_bytes: 0 },
        context_lens: { window_size: 1000, system_tokens: 0, tools_tokens: 0, messages_tokens: 10, composition: [] },
        raw: { request_body: null, response_body: null },
      }))
      const sessions = []
      if (withSession) {
        sessions.push({ trace_id: 'trace', started_at: '2026-01-01T00:00:00Z', tool: 'fixture', model: 'unpriced' })
      }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ lhar: { sessions, entries } }))))
      const loaded = await loadSharedSession('https://example.com/fixture.lhar.json')
      if (costs.length === 0) {
        expect(loaded.summaries).toEqual([])
        return
      }
      expect(loaded.summaries[0].totalCost).toBe(expected)
      expect(loaded.conversations[0].entries.map(e => e.costUsd)).toEqual(costs)
      expect(loaded.conversations[0].entries.map(e => e.usage?.inputTokens)).toEqual(costs.map(() => 10))
    })
  }
})
