import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  ApiRequestsResponse,
  ConversationGroup,
  ConversationSummary,
  ProjectedEntry,
  SSEEvent,
} from '@/api-types'
import type { ContextInfo } from '@/api-types'
import {
  fetchRequests,
  fetchSummary,
  fetchConversation,
  fetchEntryDetail,
  deleteConversation as apiDeleteConversation,
  resetAll as apiResetAll,
} from '@/api'

export type ViewMode = 'inspector' | 'dashboard'
export type InspectorTab = 'overview' | 'messages' | 'timeline'
export type DensityMode = 'comfortable' | 'compact'
export type SelectionMode = 'live' | 'pinned'

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
  const view = ref<ViewMode>('dashboard')
  const inspectorTab = ref<InspectorTab>('overview')
  const selectedSessionId = ref<string | null>(null)
  const selectionMode = ref<SelectionMode>('live')
  const selectedEntryId = ref<number | null>(null)
  const sourceFilter = ref<string>('') // '' = all sources
  const modelFilter = ref<string>('') // '' = all models
  const density = ref<DensityMode>('comfortable')
  const metadataPanelOpen = ref(false) // unused, kept for store shape stability
  const messageFocusCategory = ref<string | null>(null)
  const messageFocusToken = ref(0)
  const messageFocusTool = ref<string | null>(null)
  const messageFocusIndex = ref<number | null>(null)
  const messageFocusHighlight = ref<string | null>(null)

  // Sessions that received data recently (for pulse animation)
  const recentlyUpdated = ref<Set<string>>(new Set())
  const _pulseTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function markUpdated(id: string) {
    const next = new Set(recentlyUpdated.value)
    next.add(id)
    recentlyUpdated.value = next

    // Clear existing timer for this id
    const existing = _pulseTimers.get(id)
    if (existing) clearTimeout(existing)

    // Auto-clear after animation duration
    _pulseTimers.set(id, setTimeout(() => {
      _pulseTimers.delete(id)
      const s = new Set(recentlyUpdated.value)
      s.delete(id)
      recentlyUpdated.value = s
    }, 1500))
  }

  // Full (uncompacted) contextInfo cache, keyed by entry id
  const entryDetailCache = new Map<number, ContextInfo>()
  const entryDetailLoading = ref<number | null>(null)
  const entryDetailVersion = ref(0)

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
    let filtered = conversations.value
    if (sourceFilter.value) {
      filtered = filtered.filter(c => c.source === sourceFilter.value)
    }
    if (modelFilter.value) {
      filtered = filtered.filter(c => {
        const loaded = loadedConversations.value.get(c.id)
        if (loaded && loaded.entries.length > 0) {
          return loaded.entries[0].contextInfo.model.includes(modelFilter.value)
        }
        const summary = summaries.value.find(s => s.id === c.id)
        return summary?.latestModel.includes(modelFilter.value)
      })
    }
    return filtered
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

  const models = computed(() => {
    const set = new Set<string>()
    for (const s of summaries.value) {
      if (s.latestModel) set.add(s.latestModel)
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
    if (selectionMode.value === 'live') {
      return session.entries[0]
    }
    const pinned = session.entries.find((entry) => entry.id === selectedEntryId.value)
    return pinned ?? session.entries[0]
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

      // Auto-select first session if none selected and in inspector mode
      if (!selectedSessionId.value && data.conversations.length > 0 && view.value === 'inspector') {
        await selectSession(data.conversations[0].id)
      }
      // Clear selection if the selected session was removed
      if (selectedSessionId.value && !ids.has(selectedSessionId.value)) {
        selectedSessionId.value = null
        selectionMode.value = 'live'
        selectedEntryId.value = null
        if (view.value === 'inspector') {
          view.value = 'dashboard'
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

    // Mark the session as recently updated (pulse animation)
    if (event.conversationId) {
      markUpdated(event.conversationId)
    }

    // For all mutation events, re-fetch summaries
    load()

    // If the event is for the currently selected session, also refresh its entries
    if (event.conversationId && selectedSessionId.value === event.conversationId) {
      loadConversationEntries(event.conversationId)
    }
  }

  async function selectSession(id: string) {
    selectedSessionId.value = id
    selectionMode.value = 'live'
    selectedEntryId.value = null

    // Load entries if not already cached
    if (!loadedConversations.value.has(id)) {
      await loadConversationEntries(id)
    }
  }

  function followLive() {
    selectionMode.value = 'live'
    selectedEntryId.value = null
  }

  function pinEntry(entryId: number) {
    selectionMode.value = 'pinned'
    selectedEntryId.value = entryId
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

  function setModelFilter(model: string) {
    modelFilter.value = model
  }

  function focusMessageCategory(category: string) {
    messageFocusCategory.value = category
    messageFocusTool.value = null
    messageFocusIndex.value = null
    messageFocusHighlight.value = null
    messageFocusToken.value += 1
  }

  function focusMessageTool(category: string, toolName: string) {
    messageFocusCategory.value = category
    messageFocusTool.value = toolName
    messageFocusIndex.value = null
    messageFocusHighlight.value = null
    messageFocusToken.value += 1
  }

  function focusMessageByIndex(index: number, highlight?: string) {
    messageFocusCategory.value = null
    messageFocusTool.value = null
    messageFocusIndex.value = index
    messageFocusHighlight.value = highlight ?? null
    messageFocusToken.value += 1
  }

  /**
   * Fetch full (uncompacted) contextInfo for an entry from the server.
   * Returns null if the detail is not available (old entries).
   */
  async function loadEntryDetail(entryId: number): Promise<ContextInfo | null> {
    if (entryDetailCache.has(entryId)) {
      return entryDetailCache.get(entryId)!
    }
    entryDetailLoading.value = entryId
    try {
      const detail = await fetchEntryDetail(entryId)
      if (detail) {
        entryDetailCache.set(entryId, detail)
        entryDetailVersion.value++
        // Cap cache size
        if (entryDetailCache.size > 50) {
          const oldest = entryDetailCache.keys().next().value
          if (oldest !== undefined) entryDetailCache.delete(oldest)
        }
      }
      return detail
    } catch {
      return null
    } finally {
      entryDetailLoading.value = null
    }
  }

  function getEntryDetail(entryId: number): ContextInfo | null {
    return entryDetailCache.get(entryId) ?? null
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
          selectionMode.value = 'live'
          selectedEntryId.value = null
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
      selectionMode.value = 'live'
      selectedEntryId.value = null
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

  function toggleMetadataPanel() {
    metadataPanelOpen.value = !metadataPanelOpen.value
  }

  return {
    // State
    revision,
    summaries,
    loadedConversations,
    conversations,
    ungrouped,
    loading,
    loadingSession,
    error,
    connected,
    view,
    inspectorTab,
    selectedSessionId,
    selectionMode,
    selectedEntryId,
    sourceFilter,
    modelFilter,
    density,
    metadataPanelOpen,
    messageFocusCategory,
    messageFocusToken,
    messageFocusTool,
    messageFocusIndex,
    messageFocusHighlight,
    recentlyUpdated,

    // Computed
    filteredConversations,
    filteredSummaries,
    sources,
    models,
    selectedSession,
    selectedEntry,
    totalCost,
    totalRequests,

    // Actions
    load,
    loadConversationEntries,
    handleSSEEvent,
    selectSession,
    followLive,
    pinEntry,
    setView,
    setInspectorTab,
    setSourceFilter,
    setModelFilter,
    focusMessageCategory,
    focusMessageTool,
    focusMessageByIndex,
    loadEntryDetail,
    getEntryDetail,
    entryDetailLoading,
    entryDetailVersion,
    initializeDensity,
    setDensity,
    toggleMetadataPanel,
    deleteSession,
    reset,
  }
})
