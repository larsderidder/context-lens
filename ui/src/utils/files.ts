import type { ParsedMessage, ProjectedEntry, ToolUseBlock } from '@/api-types'

export interface FileAttribution {
  /** Normalized file path */
  path: string
  /** Total tokens attributed to this file (reads + writes + edits) */
  tokens: number
  /** Number of read operations */
  reads: number
  /** Number of write/edit operations */
  writes: number
  /** Tokens from tool_result blocks (file content read into context) */
  toolResultTokens: number
  /** Tokens from tool_use blocks targeting this file */
  toolCallTokens: number
}

/**
 * Known tool names and their parameter keys that contain file paths.
 * Covers Claude Code, Codex, Pi, and common MCP tool patterns.
 */
const FILE_PATH_TOOLS: Record<string, { paramKeys: string[]; kind: 'read' | 'write' }> = {
  // Claude Code / Pi (both use capitalized names; Claude uses file_path, Pi uses path)
  Read: { paramKeys: ['file_path', 'path'], kind: 'read' },
  Write: { paramKeys: ['file_path', 'path'], kind: 'write' },
  Edit: { paramKeys: ['file_path', 'path'], kind: 'write' },
  MultiEdit: { paramKeys: ['file_path', 'path'], kind: 'write' },
  // Codex / OpenAI
  read_file: { paramKeys: ['path', 'file_path'], kind: 'read' },
  write_file: { paramKeys: ['path', 'file_path'], kind: 'write' },
  // Pi coding agent (lowercase variants)
  read: { paramKeys: ['path', 'file_path'], kind: 'read' },
  write: { paramKeys: ['path', 'file_path'], kind: 'write' },
  edit: { paramKeys: ['path', 'file_path'], kind: 'write' },
  // Gemini CLI
  replace: { paramKeys: ['file_path', 'path'], kind: 'write' },
  // Generic / MCP patterns
  readFile: { paramKeys: ['path', 'filePath', 'file_path'], kind: 'read' },
  writeFile: { paramKeys: ['path', 'filePath', 'file_path'], kind: 'write' },
  editFile: { paramKeys: ['path', 'filePath', 'file_path'], kind: 'write' },
  create_file: { paramKeys: ['path', 'file_path'], kind: 'write' },
  patch: { paramKeys: ['path', 'file_path'], kind: 'write' },
}

/**
 * Extract a file path from a tool_use block's input arguments.
 * Returns null if the tool is not a known file operation or no path is found.
 */
function extractFilePath(block: ToolUseBlock): { path: string; kind: 'read' | 'write' } | null {
  const toolConfig = FILE_PATH_TOOLS[block.name]
  if (!toolConfig) return null

  const input = block.input
  if (!input || typeof input !== 'object') return null

  for (const key of toolConfig.paramKeys) {
    const val = input[key]
    if (typeof val === 'string' && val.length > 0) {
      return { path: normalizePath(val), kind: toolConfig.kind }
    }
  }
  return null
}

/**
 * Normalize a file path for grouping:
 * - Strip leading ./ prefix
 * - Collapse repeated slashes
 * - Keep leading / for absolute paths
 */
function normalizePath(p: string): string {
  let result = p.replace(/\/+/g, '/')
  if (result.startsWith('./')) result = result.slice(2)
  // Remove trailing slash unless it's the root
  if (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1)
  return result
}

/**
 * Make a path relative to a working directory.
 * Returns the original path if it's not under the working directory.
 */
export function makeRelative(filePath: string, workingDirectory: string | null | undefined): string {
  if (!workingDirectory) return filePath
  // Ensure the working directory ends with / for prefix matching
  const prefix = workingDirectory.endsWith('/') ? workingDirectory : workingDirectory + '/'
  if (filePath.startsWith(prefix)) {
    return filePath.slice(prefix.length)
  }
  // Also try matching against $HOME to shorten paths outside the working dir
  const home = extractHome(filePath)
  if (home) return '~/' + filePath.slice(home.length)
  return filePath
}

/**
 * Try to extract $HOME prefix from an absolute path.
 * Matches /home/<user>/ or /Users/<user>/ patterns.
 */
function extractHome(filePath: string): string | null {
  const homeMatch = filePath.match(/^(\/(?:home|Users)\/[^/]+\/)/)
  return homeMatch ? homeMatch[1] : null
}

/**
 * Build a map from tool_use block ID to its extracted file path + kind.
 */
function buildToolUseFileMap(msgs: ParsedMessage[], workingDirectory?: string | null): Map<string, { path: string; kind: 'read' | 'write'; tokens: number }> {
  const map = new Map<string, { path: string; kind: 'read' | 'write'; tokens: number }>()

  for (const msg of msgs) {
    if (!msg.contentBlocks) continue
    const toolUseBlocks = msg.contentBlocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    // Split the message tokens evenly across all blocks
    const blockShare = toolUseBlocks.length > 0 ? (msg.tokens || 0) / msg.contentBlocks.length : 0

    for (const block of msg.contentBlocks) {
      if (block.type !== 'tool_use') continue
      const tb = block as ToolUseBlock
      const result = extractFilePath(tb)
      if (result && tb.id) {
        const relativePath = makeRelative(result.path, workingDirectory)
        map.set(tb.id, { path: relativePath, kind: result.kind, tokens: Math.round(blockShare) })
      }
    }
  }
  return map
}

/**
 * Extract per-file token attribution across ALL entries in a session.
 *
 * Scans each entry for tool_use/tool_result blocks, deduplicates by tool_use ID
 * across entries, and aggregates file-level stats. This captures files from early
 * turns that may have been compacted out of the latest entry's messages.
 */
export function extractSessionFileAttributions(
  entries: ProjectedEntry[],
  workingDirectory?: string | null,
): FileAttribution[] {
  // Accumulate across all entries, deduplicating tool_use IDs
  const seenToolUseIds = new Set<string>()
  const fileMap = new Map<string, FileAttribution>()

  function getOrCreate(filePath: string): FileAttribution {
    let attr = fileMap.get(filePath)
    if (!attr) {
      attr = { path: filePath, tokens: 0, reads: 0, writes: 0, toolResultTokens: 0, toolCallTokens: 0 }
      fileMap.set(filePath, attr)
    }
    return attr
  }

  for (const entry of entries) {
    const msgs = entry.contextInfo.messages ?? []
    if (msgs.length === 0) continue

    const toolUseFileMap = buildToolUseFileMap(msgs, workingDirectory)

    // Pass 1: tool_use tokens
    for (const [id, info] of toolUseFileMap) {
      if (seenToolUseIds.has(id)) continue
      seenToolUseIds.add(id)
      const attr = getOrCreate(info.path)
      attr.toolCallTokens += info.tokens
      attr.tokens += info.tokens
      if (info.kind === 'read') attr.reads++
      else attr.writes++
    }

    // Pass 2: tool_result tokens (only for newly seen tool_use IDs)
    for (const msg of msgs) {
      if (!msg.contentBlocks) continue
      const resultBlocks = msg.contentBlocks.filter(b => b.type === 'tool_result')
      if (resultBlocks.length === 0) continue
      const tokenShare = resultBlocks.length > 0 ? (msg.tokens || 0) / resultBlocks.length : 0

      for (const block of resultBlocks) {
        if (block.type !== 'tool_result') continue
        const toolId = block.tool_use_id
        const fileInfo = toolUseFileMap.get(toolId)
        if (!fileInfo) continue
        // Only count if this tool_use was first seen in this entry
        if (!seenToolUseIds.has(toolId)) continue
        const attr = getOrCreate(fileInfo.path)
        const blockTokens = Math.round(tokenShare)
        attr.toolResultTokens += blockTokens
        attr.tokens += blockTokens
      }
    }
  }

  return Array.from(fileMap.values())
    .filter(a => a.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
}

/**
 * Get a short display name from a file path (the filename portion).
 */
export function shortFileName(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1] || filePath
}

/**
 * Get the directory portion of a file path.
 */
export function fileDirectory(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  if (idx <= 0) return ''
  return filePath.slice(0, idx)
}

/**
 * Color palette for file attribution treemap blocks.
 */
const FILE_COLORS = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#14b8a6', // teal
  '#6366f1', // indigo
  '#84cc16', // lime
]

export function fileColor(index: number): string {
  return FILE_COLORS[index % FILE_COLORS.length]
}
