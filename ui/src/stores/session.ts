import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  ApiRequestsResponse,
  ConversationGroup,
  ConversationSummary,
  ProjectedEntry,
  SSEEvent,
} from '@/api-types'
import {
  fetchRequests,
  fetchSummary,
  fetchConversation,
  deleteConversation as apiDeleteConversation,
  resetAll as apiResetAll,
} from '@/api'

export type ViewMode = 'inspector' | 'dashboard'
export type InspectorTab = 'overview' | 'messages' | 'timeline'
export type DensityMode = 'comfortable' | 'compact'

const DENSITY_STORAGE_KEY = 'context-lens-density'

export const useSessionStore = defineStore('session', () => {
  // --- Data ---
  const revision = ref(0)
  const summaries = ref<ConversationSummary[]>([])
  const loadedConversations = ref<Map<string, ConversationGroup>>(new Map())
  const ungroupedCount = ref(0)
  const loading = ref(false)
  const loadingSession = ref<string | null>(null)
  const error = ref<string | null>(null)
  const connected = ref(false)

  // --- UI state ---
  const view = ref<ViewMode>('inspector')
  const inspectorTab = ref<InspectorTab>('overview')
  const selectedSessionId = ref<string | null>(null)
  const selectedTurnIndex = ref<number>(-1) // -1 = latest
  const sourceFilter = ref<string>('') // '' = all sources
  const density = ref<DensityMode>('comfortable')
  const messageFocusCategory = ref<string | null>(null)
  const messageFocusToken = ref(0)
  const messageFocusTool = ref<string | null>(null)

  // --- Backwards-compatible computed ---
  // Components that use `store.conversations` get summaries cast as ConversationGroups
  // with empty entries/agents. Full data is in loadedConversations.
  const conversations = computed<ConversationGroup[]>(() => {
    return summaries.value.map(s => {
      const loaded = loadedConversations.value.get(s.id)
      if (loaded) return loaded
      // Stub: summary data as a ConversationGroup with empty entries
      return {
        ...s,
        agents: [],
        entries: [],
      } as unknown as ConversationGroup
    })
  })

  const ungrouped = computed<ProjectedEntry[]>(() => [])

  const filteredConversations = computed(() => {
    if (!sourceFilter.value) return conversations.value
    return conversations.value.filter(c => c.source === sourceFilter.value)
  })

  const filteredSummaries = computed(() => {
    if (!sourceFilter.value) return summaries.value
    return summaries.value.filter(s => s.source === sourceFilter.value)
  })

  const sources = computed(() => {
    const set = new Set<string>()
    for (const s of summaries.value) {
      if (s.source) set.add(s.source)
    }
    return Array.from(set).sort()
  })

  const selectedSession = computed((): ConversationGroup | null => {
    if (!selectedSessionId.value) return null
    return loadedConversations.value.get(selectedSessionId.value) ?? null
  })

  const selectedEntry = computed((): ProjectedEntry | null => {
    const session = selectedSession.value
    if (!session || session.entries.length === 0) return null
    if (selectedTurnIndex.value === -1) {
      return session.entries[0] // entries are newest-first
    }
    return session.entries[selectedTurnIndex.value] ?? session.entries[0]
  })

  const totalCost = computed(() => {
    let cost = 0
    for (const s of summaries.value) {
      cost += s.totalCost ?? 0
    }
    return cost
  })

  const totalRequests = computed(() => {
    let count = 0
    for (const s of summaries.value) {
      count += s.entryCount
    }
    return count + ungroupedCount.value
  })

  // --- Actions ---
  async function load() {
    loading.value = true
    error.value = null
    try {
      const data = await fetchSummary()
      revision.value = data.revision
      summaries.value = data.conversations
      ungroupedCount.value = data.ungroupedCount

      // Evict loaded conversations that no longer exist
      const ids = new Set(data.conversations.map(c => c.id))
      for (const key of loadedConversations.value.keys()) {
        if (!ids.has(key)) loadedConversations.value.delete(key)
      }

      // Auto-select first session if none selected
      if (!selectedSessionId.value && data.conversations.length > 0) {
        await selectSession(data.conversations[0].id)
      }
      // Clear selection if the selected session was removed
      if (selectedSessionId.value && !ids.has(selectedSessionId.value)) {
        if (data.conversations.length > 0) {
          await selectSession(data.conversations[0].id)
        } else {
          selectedSessionId.value = null
          selectedTurnIndex.value = -1
        }
      }

      // Refresh the currently selected session's entries
      if (selectedSessionId.value && ids.has(selectedSessionId.value)) {
        await loadConversationEntries(selectedSessionId.value)
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  async function loadConversationEntries(id: string) {
    loadingSession.value = id
    try {
      const convo = await fetchConversation(id)
      const next = new Map(loadedConversations.value)
      next.set(id, convo)
      loadedConversations.value = next
    } catch (e) {
      // Non-fatal: session may have been deleted between summary and detail fetch
      console.warn(`Failed to load conversation ${id}:`, e)
    } finally {
      loadingSession.value = null
    }
  }

  function handleSSEEvent(event: SSEEvent) {
    if (event.type === 'connected') {
      connected.value = true
      if (event.revision !== revision.value) {
        load()
      }
      return
    }

    // For all mutation events, re-fetch summaries
    load()
  }

  async function selectSession(id: string) {
    const prevId = selectedSessionId.value
    const prevEntryId = selectedEntry.value?.id ?? null
    selectedSessionId.value = id
    selectedTurnIndex.value = 0

    // Load entries if not already cached
    if (!loadedConversations.value.has(id)) {
      await loadConversationEntries(id)
    }

    // If re-selecting the same session, try to preserve the selected entry
    if (prevId === id && prevEntryId !== null) {
      const loaded = loadedConversations.value.get(id)
      if (loaded) {
        const idx = loaded.entries.findIndex(e => e.id === prevEntryId)
        selectedTurnIndex.value = idx >= 0 ? idx : 0
      }
    }
  }

  function selectTurn(index: number) {
    selectedTurnIndex.value = index
  }

  function setView(v: ViewMode) {
    view.value = v
  }

  function setInspectorTab(tab: InspectorTab) {
    inspectorTab.value = tab
  }

  function setSourceFilter(source: string) {
    sourceFilter.value = source
  }

  function focusMessageCategory(category: string) {
    messageFocusCategory.value = category
    messageFocusTool.value = null
    messageFocusToken.value += 1
  }

  function focusMessageTool(category: string, toolName: string) {
    messageFocusCategory.value = category
    messageFocusTool.value = toolName
    messageFocusToken.value += 1
  }

  async function deleteSession(id: string) {
    try {
      await apiDeleteConversation(id)
      // SSE will trigger a reload, but also update optimistically
      summaries.value = summaries.value.filter(s => s.id !== id)
      loadedConversations.value.delete(id)
      if (selectedSessionId.value === id) {
        if (summaries.value.length > 0) {
          await selectSession(summaries.value[0].id)
        } else {
          selectedSessionId.value = null
          selectedTurnIndex.value = -1
        }
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function reset() {
    try {
      await apiResetAll()
      // SSE will trigger a reload, but also update optimistically
      summaries.value = []
      loadedConversations.value = new Map()
      ungroupedCount.value = 0
      selectedSessionId.value = null
      selectedTurnIndex.value = -1
      revision.value = 0
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  function applyDensityToDom(mode: DensityMode) {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute('data-density', mode)
  }

  function initializeDensity() {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY)
    if (stored === 'comfortable' || stored === 'compact') {
      density.value = stored
    } else {
      density.value = 'comfortable'
    }
    applyDensityToDom(density.value)
  }

  function setDensity(mode: DensityMode) {
    density.value = mode
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, mode)
    }
    applyDensityToDom(mode)
  }

  return {
    // State
    revision,
    summaries,
    conversations,
    ungrouped,
    loading,
    loadingSession,
    error,
    connected,
    view,
    inspectorTab,
    selectedSessionId,
    selectedTurnIndex,
    sourceFilter,
    density,
    messageFocusCategory,
    messageFocusToken,
    messageFocusTool,

    // Computed
    filteredConversations,
    filteredSummaries,
    sources,
    selectedSession,
    selectedEntry,
    totalCost,
    totalRequests,

    // Actions
    load,
    loadConversationEntries,
    handleSSEEvent,
    selectSession,
    selectTurn,
    setView,
    setInspectorTab,
    setSourceFilter,
    focusMessageCategory,
    focusMessageTool,
    initializeDensity,
    setDensity,
    deleteSession,
    reset,
  }
})
