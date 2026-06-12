import type { ParsedMessage, ProjectedEntry } from '@/api-types'
import { classifyEntries } from '@/utils/messages'

export interface ChronoMessageItem {
  msg: ParsedMessage
  origIdx: number
  future: boolean
  prunedGhost: boolean
}

export interface BuildChronoMessagesOptions {
  currentMessages: ParsedMessage[]
  latestMessages?: ParsedMessage[]
  prunedMessageIds?: string[]
  includeFuture?: boolean
  findPrunedMessage?: (origIdx: number) => ParsedMessage | null
}

/**
 * Merge the selected entry context with pruned placeholders and optional future rows.
 * The original index is kept stable so pruning, focusing, and turn labels can agree.
 */
export function buildChronoMessages(options: BuildChronoMessagesOptions): ChronoMessageItem[] {
  const currentMsgs = options.currentMessages
  const pruned = options.prunedMessageIds ?? []
  const result: ChronoMessageItem[] = []

  if (pruned.length > 0) {
    const prunedIndices = new Map<number, string>()
    for (const id of pruned) {
      const match = id.match(/^(user|assistant|unknown):(\d+)$/)
      if (match) prunedIndices.set(parseInt(match[2]), id)
    }

    let currentIdx = 0
    const maxIdx = Math.max(
      currentMsgs.length + prunedIndices.size,
      prunedIndices.size > 0 ? Math.max(...prunedIndices.keys()) + 1 : 0,
    )

    for (let origIdx = 0; origIdx < maxIdx; origIdx++) {
      if (prunedIndices.has(origIdx)) {
        const ghost = options.findPrunedMessage?.(origIdx) ?? null
        if (ghost) {
          result.push({ msg: ghost, origIdx, future: false, prunedGhost: true })
        }
      } else if (currentIdx < currentMsgs.length) {
        result.push({ msg: currentMsgs[currentIdx], origIdx, future: false, prunedGhost: false })
        currentIdx++
      }
    }

    while (currentIdx < currentMsgs.length) {
      result.push({ msg: currentMsgs[currentIdx], origIdx: result.length, future: false, prunedGhost: false })
      currentIdx++
    }
  } else {
    for (let i = 0; i < currentMsgs.length; i++) {
      result.push({ msg: currentMsgs[i], origIdx: i, future: false, prunedGhost: false })
    }
  }

  if (options.includeFuture && options.latestMessages) {
    for (let i = currentMsgs.length; i < options.latestMessages.length; i++) {
      result.push({ msg: options.latestMessages[i], origIdx: i, future: true, prunedGhost: false })
    }
  }

  return result
}

/**
 * A new turn starts at the first message and at user messages after assistant output.
 */
export function detectTurnBoundarySet(items: Array<{ msg: ParsedMessage }>): Set<number> {
  const boundaries = new Set<number>()
  if (items.length > 0) boundaries.add(0)

  let seenAssistant = false
  for (let i = 0; i < items.length; i++) {
    const role = items[i].msg.role
    if (role === 'assistant') {
      seenAssistant = true
    } else if (role === 'user' && seenAssistant) {
      boundaries.add(i)
      seenAssistant = false
    }
  }

  return boundaries
}

/** Assign visible turn numbers after accounting for compacted earlier turns. */
export function buildTurnNumberMap(boundaries: Iterable<number>, turnOffset: number): Map<number, number> {
  const map = new Map<number, number>()
  let turnNum = turnOffset
  for (const idx of boundaries) {
    turnNum++
    map.set(idx, turnNum)
  }
  return map
}

export function countLocalTurns(boundaries: Iterable<number>, selectedMessageCount: number): number {
  let count = 0
  for (const idx of boundaries) {
    if (idx < selectedMessageCount) count++
  }
  return count
}

/**
 * Return the selected entry's main-agent turn number, ignoring subagent entries.
 */
export function getMainTurnNumber(entriesNewestFirst: ProjectedEntry[], selectedEntryId: number): number {
  const classified = classifyEntries([...entriesNewestFirst].reverse())
  let idx = 0
  for (const item of classified) {
    if (item.isMain) idx++
    if (item.entry.id === selectedEntryId) return idx
  }
  return 1
}

export interface GroupSubagentOptions {
  entriesNewestFirst: ProjectedEntry[]
  selectedEntryId: number
  boundaryIndices: number[]
  turnOffset: number
}

/**
 * Group subagent calls so the message list can render them before the next main turn.
 * Entries arrive newest first from the API, but turn math is easier in chronological order.
 */
export function groupSubagentEntriesByTurnBoundary(options: GroupSubagentOptions): Map<number, ProjectedEntry[]> {
  const classified = classifyEntries([...options.entriesNewestFirst].reverse())
  const mainEntries: ProjectedEntry[] = []
  const subsBetween: ProjectedEntry[][] = []
  let pendingSubs: ProjectedEntry[] = []

  for (const item of classified) {
    if (item.isMain) {
      mainEntries.push(item.entry)
      if (mainEntries.length > 1) {
        subsBetween.push([...pendingSubs])
      }
      pendingSubs = []
    } else if (mainEntries.length > 0) {
      pendingSubs.push(item.entry)
    }
  }

  subsBetween.push([...pendingSubs])

  const selectedMainIdx = mainEntries.findIndex((entry) => entry.id === options.selectedEntryId)
  if (selectedMainIdx < 0) return new Map()

  const boundaries = [...options.boundaryIndices].sort((a, b) => a - b)
  const result = new Map<number, ProjectedEntry[]>()

  for (let i = 0; i <= selectedMainIdx && i < subsBetween.length; i++) {
    const subs = subsBetween[i]
    if (subs.length === 0) continue

    const boundaryLocalIdx = i + 1 - options.turnOffset
    if (boundaryLocalIdx < 0) continue
    if (boundaryLocalIdx < boundaries.length) {
      result.set(boundaries[boundaryLocalIdx], subs)
    }
  }

  return result
}
