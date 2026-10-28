import type { Activity, AppSettings, RuntimeCommand, Snapshot } from '../electron/shared'

declare global {
  interface Window {
    focusFlow: {
      getSnapshot(): Promise<Snapshot>
      saveSettings(settings: AppSettings): Promise<void>
      saveSchedule(schedule: Activity[]): Promise<{ error?: string }>
      command(command: RuntimeCommand): Promise<void>
      showDashboard(): Promise<void>
      showWidget(): Promise<void>
      minimize(): Promise<void>
      close(): Promise<void>
      toggleAlwaysOnTop(): Promise<void>
      setCompact(compact: boolean): Promise<void>
      onSnapshot(callback: (snapshot: Snapshot) => void): () => void
      onTransition(callback: (payload: { name: string; nextName: string; warning: boolean }) => void): () => void
    }
  }
}

export {}
