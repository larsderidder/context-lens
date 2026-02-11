import { reactive } from 'vue'

/**
 * Reactive Set<string> for tracking expanded items.
 * Pattern from Vue DevTools' toggle-expanded composable.
 */
export function useExpandable() {
  const expanded = reactive(new Set<string>())

  function toggle(id: string) {
    if (expanded.has(id)) {
      expanded.delete(id)
    } else {
      expanded.add(id)
    }
  }

  function isExpanded(id: string): boolean {
    return expanded.has(id)
  }

  function expand(id: string) {
    expanded.add(id)
  }

  function collapse(id: string) {
    expanded.delete(id)
  }

  function collapseAll() {
    expanded.clear()
  }

  return {
    expanded,
    toggle,
    isExpanded,
    expand,
    collapse,
    collapseAll,
  }
}
