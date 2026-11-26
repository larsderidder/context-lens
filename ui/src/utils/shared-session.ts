/**
 * Shared session loader for contextlens.io viewer mode.
 *
 * Fetches a .lhar.json file from a URL and converts it into the
 * ConversationGroup shape the store expects.
 */

import { sumCosts } from '@/utils/cost'
import type {
  ConversationGroup,
  ConversationSummary,
  ProjectedEntry,
  CompositionEntry,
  AgentGroup,
} from '@/api-types'

// Minimal LHAR types (subset of lhar-types.generated.ts we actually use)
interface LharEntryUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

interface LharEntryUsageExt {
  cache_read_tokens: number
  cache_write_tokens: number
  thinking_tokens: number
  cost_usd: number | null
}

interface LharContextLens {
  window_size: number
  system_tokens: number
  tools_tokens: number
  messages_tokens: number
  composition: CompositionEntry[]
  security?: {
    alerts: Array<{
      message_index: number
      role: string
      tool_name: string | null
      severity: 'high' | 'medium' | 'info'
      pattern: string
      match: string
      offset: number
      length: number
    }>
  }
}

interface LharEntry {
  id: string
  trace_id: string
  span_id: string
  parent_span_id: string | null
  timestamp: string
  sequence: number
  source: {
    tool: string
    agent_role: string
  }
  gen_ai: {
    system: string
    request: {
      model: string
      max_tokens: number | null
    }
    response: {
      model: string | null
      finish_reasons: string[]
    }
    usage: LharEntryUsage
  }
  usage_ext: LharEntryUsageExt
  http: {
    method: string
    url: string | null
    status_code: number | null
    api_format: string
    stream: boolean
  }
  timings: {
    send_ms: number
    wait_ms: number
    receive_ms: number
    total_ms: number
    tokens_per_second: number | null
  } | null
  transfer: {
    request_bytes: number
    response_bytes: number
  }
  context_lens: LharContextLens
  raw: {
    request_body: Record<string, unknown> | null
    response_body: Record<string, unknown> | string | null
  }
}

interface LharSession {
  trace_id: string
  started_at: string
  tool: string
  model: string
}

interface LharJsonWrapper {
  lhar: {
    version: string
    sessions: LharSession[]
    entries: LharEntry[]
  }
}

let _entryIdCounter = 1

function lharEntryToProjected(entry: LharEntry, idx: number): ProjectedEntry {
  const usage = entry.gen_ai.usage
  const usageExt = entry.usage_ext
  const cl = entry.context_lens

  const hasUsage =
    usage.input_tokens > 0 ||
    usage.output_tokens > 0 ||
    usageExt.cache_read_tokens > 0 ||
    usageExt.cache_write_tokens > 0 ||
    usageExt.thinking_tokens > 0

  // Reconstruct a minimal ContextInfo for detail views
  const requestBody = entry.raw?.request_body ?? {}
  const provider = providerFromSystem(entry.gen_ai.system)

  return {
    id: _entryIdCounter++,
    timestamp: entry.timestamp,
    contextInfo: {
      provider,
      apiFormat: entry.http.api_format,
      model: entry.gen_ai.request.model,
      systemTokens: cl.system_tokens,
      toolsTokens: cl.tools_tokens,
      messagesTokens: cl.messages_tokens,
      totalTokens: usage.input_tokens,
      systemPrompts: extractSystemPrompts(requestBody),
      tools: extractTools(requestBody, provider),
      messages: extractMessages(requestBody, provider),
    },
    response: (entry.raw?.response_body ?? {}) as Record<string, unknown>,
    contextLimit: cl.window_size,
    source: entry.source.tool,
    conversationId: entry.trace_id,
    agentKey: entry.parent_span_id ? `${entry.trace_id}:${entry.source.agent_role}` : null,
    agentLabel: entry.source.agent_role || 'main',
    httpStatus: entry.http.status_code,
    timings: entry.timings,
    requestBytes: entry.transfer.request_bytes,
    responseBytes: entry.transfer.response_bytes,
    targetUrl: entry.http.url,
    composition: cl.composition ?? [],
    costUsd: usageExt.cost_usd,
    healthScore: null,
    securityAlerts: (cl.security?.alerts ?? []).map(a => ({
      messageIndex: a.message_index,
      role: a.role,
      toolName: a.tool_name,
      severity: a.severity,
      pattern: a.pattern,
      match: a.match,
      offset: a.offset,
      length: a.length,
    })),
    outputSecurityAlerts: [],
    usage: hasUsage
      ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usageExt.cache_read_tokens,
          cacheWriteTokens: usageExt.cache_write_tokens,
          thinkingTokens: usageExt.thinking_tokens,
        }
      : null,
    responseModel: entry.gen_ai.response.model,
    stopReason: entry.gen_ai.response.finish_reasons[0] ?? null,
  }
}

function providerFromSystem(system: string): string {
  if (system === 'anthropic') return 'anthropic'
  if (system === 'openai') return 'openai'
  if (system === 'google') return 'gemini'
  return system || 'unknown'
}

// Extract system prompts from raw request body
function extractSystemPrompts(body: Record<string, unknown>) {
  const system = body.system
  if (!system) return []
  if (typeof system === 'string') return [{ content: system }]
  if (Array.isArray(system)) {
    return system
      .filter((b: unknown): b is { type: string; text: string } => typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'text')
      .map(b => ({ content: b.text }))
  }
  return []
}

import type { Tool, ContentBlock, ParsedMessage } from '@/api-types'

// Extract tool definitions from raw request body
function extractTools(body: Record<string, unknown>, _provider: string): Tool[] {
  const tools = body.tools
  if (!Array.isArray(tools)) return []
  return tools as Tool[]
}

// Extract messages from raw request body
function extractMessages(body: Record<string, unknown>, _provider: string): ParsedMessage[] {
  const messages = body.messages
  if (!Array.isArray(messages)) return []
  return (messages as Array<Record<string, unknown>>).map(m => ({
    role: String(m.role ?? 'user'),
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    contentBlocks: Array.isArray(m.content) ? m.content as ContentBlock[] : null,
    tokens: 0,
  }))
}

function buildAgentGroups(entries: ProjectedEntry[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>()
  for (const e of entries) {
    const key = e.agentKey ?? `${e.conversationId}:main`
    if (!groups.has(key)) {
      groups.set(key, { key, label: e.agentLabel, model: e.contextInfo.model, entries: [] })
    }
    groups.get(key)!.entries.push(e)
  }
  return Array.from(groups.values())
}

function sessionLabel(session: LharSession, entries: ProjectedEntry[]): string {
  const model = entries[0]?.contextInfo.model ?? session.model ?? ''
  const tool = session.tool || 'unknown'
  const date = new Date(session.started_at).toLocaleString()
  return `${tool} · ${model} · ${date}`
}

export interface SharedSessionData {
  conversations: ConversationGroup[]
  summaries: ConversationSummary[]
}

export async function loadSharedSession(url: string): Promise<SharedSessionData> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load shared session: ${res.status} ${res.statusText}`)

  const wrapper: LharJsonWrapper = await res.json()
  if (!wrapper?.lhar?.sessions || !wrapper?.lhar?.entries) {
    throw new Error('Invalid LHAR format: missing sessions or entries')
  }

  const { sessions, entries: rawEntries } = wrapper.lhar

  // Convert all entries first
  const allEntries = rawEntries.map((e, i) => lharEntryToProjected(e, i))

  const conversations: ConversationGroup[] = []
  const summaries: ConversationSummary[] = []

  for (const session of sessions) {
    const sessionEntries = allEntries.filter(e => e.conversationId === session.trace_id)
    if (sessionEntries.length === 0) continue

    const agents = buildAgentGroups(sessionEntries)
    const label = sessionLabel(session, sessionEntries)
    const totalCost = sumCosts(sessionEntries.map(e => e.costUsd))
    const latestEntry = sessionEntries[sessionEntries.length - 1]
    const latestTokens = latestEntry.usage?.inputTokens ?? latestEntry.contextInfo.totalTokens

    const conv: ConversationGroup = {
      id: session.trace_id,
      label,
      source: session.tool,
      workingDirectory: null,
      firstSeen: session.started_at,
      sessionId: null,
      tags: [],
      agents,
      entries: sessionEntries,
    }

    const summary: ConversationSummary = {
      id: session.trace_id,
      label,
      source: session.tool,
      workingDirectory: null,
      firstSeen: session.started_at,
      sessionId: null,
      tags: [],
      entryCount: sessionEntries.length,
      latestTimestamp: latestEntry.timestamp,
      latestModel: latestEntry.contextInfo.model,
      latestTotalTokens: latestTokens,
      contextLimit: latestEntry.contextLimit,
      totalCost,
      healthScore: null,
      tokenHistory: sessionEntries.map(e => e.usage?.inputTokens ?? e.contextInfo.totalTokens),
    }

    conversations.push(conv)
    summaries.push(summary)
  }

  // If entries aren't grouped into sessions (old LHAR with no session lines),
  // bundle everything under a single synthetic session.
  if (conversations.length === 0 && allEntries.length > 0) {
    const id = 'shared'
    const agents = buildAgentGroups(allEntries)
    const totalCost = sumCosts(allEntries.map(e => e.costUsd))
    const latest = allEntries[allEntries.length - 1]

    conversations.push({
      id,
      label: 'Shared session',
      source: allEntries[0].source,
      workingDirectory: null,
      firstSeen: allEntries[0].timestamp,
      sessionId: null,
      tags: [],
      agents,
      entries: allEntries,
    })
    summaries.push({
      id,
      label: 'Shared session',
      source: allEntries[0].source,
      workingDirectory: null,
      firstSeen: allEntries[0].timestamp,
      sessionId: null,
      tags: [],
      entryCount: allEntries.length,
      latestTimestamp: latest.timestamp,
      latestModel: latest.contextInfo.model,
      latestTotalTokens: latest.usage?.inputTokens ?? latest.contextInfo.totalTokens,
      contextLimit: latest.contextLimit,
      totalCost,
      healthScore: null,
      tokenHistory: allEntries.map(e => e.usage?.inputTokens ?? e.contextInfo.totalTokens),
    })
  }

  return { conversations, summaries }
}
