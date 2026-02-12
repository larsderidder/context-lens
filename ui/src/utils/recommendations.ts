import type { ProjectedEntry } from '@/api-types'
import { fmtTokens } from './format'
import { classifyMessageRole, buildToolNameMap } from './messages'

export interface Recommendation {
  severity: 'high' | 'med' | 'low'
  title: string
  detail: string
  impact: string
  messageIndex?: number
  highlight?: string
}

/**
 * Compute actionable recommendations for a single entry based on:
 * composition ratios, conversation history, context usage, and security alerts.
 * TODO: Move this server-side for notifications support.
 */
export function computeRecommendations(
  entry: ProjectedEntry,
  entries: ProjectedEntry[],
  classified: { entry: ProjectedEntry; isMain: boolean }[],
): Recommendation[] {
  const recs: Recommendation[] = []
  const ci = entry.contextInfo
  const comp = entry.composition || []
  const totalTok = comp.reduce((s, c) => s + c.tokens, 0)
  const toolNameMap = buildToolNameMap(ci.messages || [])

  // Large tool results
  const toolResults = comp.find(c => c.category === 'tool_results')
  if (toolResults && totalTok > 0 && toolResults.pct > 25) {
    let largestResult = 0
    let largestToolName = ''
    for (const m of ci.messages || []) {
      if (classifyMessageRole(m) === 'tool_results' && m.tokens > largestResult) {
        largestResult = m.tokens
        if (m.contentBlocks) {
          for (const b of m.contentBlocks) {
            if (b.type === 'tool_result' && b.tool_use_id && toolNameMap[b.tool_use_id]) {
              largestToolName = toolNameMap[b.tool_use_id]
              break
            }
          }
        }
      }
    }
    if (largestResult > 2000) {
      const lrPct = Math.round(largestResult / totalTok * 100)
      recs.push({
        severity: 'high',
        title: `Large tool result${largestToolName ? ': ' + largestToolName : ''} (${fmtTokens(largestResult)} tokens, ${lrPct}% of context)`,
        detail: 'This single result reduces space for conversation history and is re-sent every turn. You may want to truncate output or use summary flags.',
        impact: `${fmtTokens(largestResult)} tok`,
      })
    }
  }

  // Unused tool definitions
  const toolDefs = comp.find(c => c.category === 'tool_definitions')
  if (toolDefs && toolDefs.pct > 30) {
    const usedTools = new Set<string>()
    for (const e of entries) {
      for (const m of e.contextInfo.messages || []) {
        if (m.contentBlocks) {
          for (const b of m.contentBlocks) {
            if (b.type === 'tool_use' && b.name) usedTools.add(b.name)
          }
        }
      }
    }
    const allDefinedNames: string[] = []
    if (ci.tools) {
      for (const t of ci.tools) {
        const name = 'name' in t ? t.name : t.function?.name
        if (name) allDefinedNames.push(name)
      }
    }
    const unusedNames = allDefinedNames.filter(n => !usedTools.has(n))
    const totalTools = allDefinedNames.length
    if (totalTools > usedTools.size + 3) {
      const unusedPreview = unusedNames.slice(0, 5).join(', ') + (unusedNames.length > 5 ? ` +${unusedNames.length - 5} more` : '')
      const wastedTok = Math.round(toolDefs.tokens * unusedNames.length / totalTools)
      recs.push({
        severity: 'high',
        title: `${usedTools.size}/${totalTools} tools used, ${unusedNames.length} idle`,
        detail: `Unused: ${unusedPreview}. Definitions cost ~${fmtTokens(wastedTok)} tokens and are re-sent every turn. You may want to remove unused tools to free context.`,
        impact: `~${fmtTokens(wastedTok)} tok`,
      })
    }
  }

  // Tool results dominating context
  if (toolResults && toolResults.pct > 60) {
    const userText = comp.find(c => c.category === 'user_text')
    const userPct = userText ? userText.pct : 0
    const perToolTokens = new Map<string, number>()
    for (const m of ci.messages || []) {
      if (classifyMessageRole(m) === 'tool_results' && m.contentBlocks) {
        for (const b of m.contentBlocks) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            const tname = toolNameMap[b.tool_use_id] || 'unknown'
            perToolTokens.set(tname, (perToolTokens.get(tname) || 0) + (m.tokens || 0))
          }
        }
      }
    }
    const topTools = Array.from(perToolTokens.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, tokens]) => `${name} (${fmtTokens(tokens)})`)
      .join(', ')
    recs.push({
      severity: 'med',
      title: `Tool results dominate: ${toolResults.pct}% of context`,
      detail: `Top tools: ${topTools}. User text is only ${userPct}%. Large results crowd out conversation history.`,
      impact: 'Structural',
    })
  }

  // Context utilization
  const utilPct = entry.contextLimit > 0 ? Math.round(ci.totalTokens / entry.contextLimit * 100) : 0
  if (utilPct > 80) {
    recs.push({
        severity: 'high',
        title: `Context utilization critical: ${utilPct}%`,
        detail: `${fmtTokens(ci.totalTokens)} of ${fmtTokens(entry.contextLimit)} tokens. Overflow risk is elevated, and older messages may be dropped or summarized.`,
        impact: 'Critical',
      })
  } else if (utilPct > 60) {
    recs.push({
      severity: 'med',
      title: `Context utilization high: ${utilPct}%`,
      detail: `${fmtTokens(ci.totalTokens)} of ${fmtTokens(entry.contextLimit)} tokens used.`,
      impact: 'Monitor',
    })
  }

  // Compaction detection
  const idx = entries.indexOf(entry)
  if (idx > 0) {
    let prevIdx = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (classified[i]?.isMain) { prevIdx = i; break }
    }
    if (prevIdx >= 0) {
      const prevTok = entries[prevIdx].contextInfo.totalTokens
      if (ci.totalTokens < prevTok * 0.7) {
        recs.push({
          severity: 'med',
          title: 'Compaction detected',
          detail: `Tokens dropped ${fmtTokens(prevTok)} → ${fmtTokens(ci.totalTokens)}. Context was summarized or truncated — older details may be lost.`,
          impact: `-${fmtTokens(prevTok - ci.totalTokens)} tok`,
        })
      }
    }
  }

  // System injections
  const sysInj = comp.find(c => c.category === 'system_injections')
  if (sysInj && sysInj.pct > 5) {
    recs.push({
      severity: 'med',
      title: `System injections: ${sysInj.pct}% of context`,
      detail: `${fmtTokens(sysInj.tokens)} tokens of system-reminder blocks injected into messages. These are re-sent every turn, reducing space for actual conversation.`,
      impact: `${fmtTokens(sysInj.tokens)} tok`,
    })
  }

  // Security alerts
  for (const a of entry.securityAlerts || []) {
    const sev = a.severity === 'high' ? 'high' : a.severity === 'medium' ? 'med' : 'low'
    const where = a.toolName ? `tool result: ${a.toolName}` : `${a.role} message`
    recs.push({
      severity: sev,
      title: `⚠ ${a.pattern.replace(/_/g, ' ')} in ${where} (msg ${a.messageIndex + 1})`,
      detail: a.match,
      impact: a.severity,
      messageIndex: a.messageIndex,
      highlight: a.match,
    })
  }

  return recs
}
