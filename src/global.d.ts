import type { FocusFlowApi } from '../electron/preload'

declare global {
  const __APP_VERSION__: string
  interface Window {
    focusFlow: FocusFlowApi
  }
}

export {}
