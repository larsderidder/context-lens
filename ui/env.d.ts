/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

declare module 'splitpanes' {
  import type { DefineComponent } from 'vue'
  export const Splitpanes: DefineComponent<{
    horizontal?: boolean
    pushOtherPanes?: boolean
    dblClickSplitter?: boolean
    firstSplitter?: boolean
  }>
  export const Pane: DefineComponent<{
    size?: number
    minSize?: number
    maxSize?: number
  }>
}
