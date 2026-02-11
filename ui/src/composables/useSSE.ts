import { ref, onUnmounted } from 'vue'
import type { SSEEvent } from '@/api-types'

export function useSSE(url: string, onEvent: (event: SSEEvent) => void) {
  const connected = ref(false)
  let source: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    if (source) {
      source.close()
    }

    source = new EventSource(url)

    source.onopen = () => {
      connected.value = true
    }

    source.onmessage = (e) => {
      try {
        const event: SSEEvent = JSON.parse(e.data)
        onEvent(event)
      } catch {
        // Ignore malformed events
      }
    }

    source.onerror = () => {
      connected.value = false
      source?.close()
      source = null

      // Reconnect after delay
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(connect, 2000)
    }
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (source) {
      source.close()
      source = null
    }
    connected.value = false
  }

  // Auto-connect
  connect()

  // Cleanup on component unmount
  onUnmounted(disconnect)

  return {
    connected,
    disconnect,
    reconnect: connect,
  }
}
