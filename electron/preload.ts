import { contextBridge, ipcRenderer } from 'electron'
import type { Activity, AppSettings, RuntimeCommand, Snapshot } from './shared'

const api = {
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke('snapshot:get'),
  saveSettings: (settings: AppSettings): Promise<void> => ipcRenderer.invoke('settings:save', settings),
  saveSchedule: (schedule: Activity[]): Promise<{ error?: string }> => ipcRenderer.invoke('schedule:save', schedule),
  command: (command: RuntimeCommand): Promise<void> => ipcRenderer.invoke('runtime:command', command),
  showDashboard: (): Promise<void> => ipcRenderer.invoke('window:dashboard'),
  showWidget: (): Promise<void> => ipcRenderer.invoke('window:widget'),
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  toggleAlwaysOnTop: (): Promise<void> => ipcRenderer.invoke('window:topmost'),
  setCompact: (compact: boolean): Promise<void> => ipcRenderer.invoke('window:compact', compact),
  onSnapshot: (callback: (snapshot: Snapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => callback(snapshot)
    ipcRenderer.on('snapshot:updated', listener)
    return () => ipcRenderer.removeListener('snapshot:updated', listener)
  },
  onTransition: (callback: (payload: { name: string; nextName: string; warning: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { name: string; nextName: string; warning: boolean }) => callback(payload)
    ipcRenderer.on('activity:transition', listener)
    return () => ipcRenderer.removeListener('activity:transition', listener)
  },
}

contextBridge.exposeInMainWorld('focusFlow', api)
