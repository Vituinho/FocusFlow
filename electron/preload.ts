import { contextBridge, ipcRenderer } from 'electron'
import type { Activity, AppSettings, AppStatus, HardwareSnapshot, RuntimeCommand, ScheduleKind, ScheduleSaveResult, Snapshot, TransitionPayload } from './shared'

// The preload is sandboxed, so it cannot import local modules at runtime. It stays a thin, typed bridge: the main process
// validates every request, and the renderer validates hardware data (validateHardwareSnapshot) before showing it.

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

function subscribe<T>(channel: string, accept: (value: unknown) => value is T, callback: (value: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown) => { if (accept(value)) callback(value) }
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
const isSnapshot = (value: unknown): value is Snapshot => isObject(value) && isObject(value.data) && isObject(value.view) && typeof value.now === 'number'
const isTransition = (value: unknown): value is TransitionPayload => isObject(value) && typeof value.name === 'string' && typeof value.nextName === 'string' && typeof value.warning === 'boolean'
const isHardware = (value: unknown): value is HardwareSnapshot => isObject(value) && typeof value.status === 'string' && typeof value.timestamp === 'number'

const api = {
  getSnapshot: () => invoke<Snapshot | null>('snapshot:get'),
  saveSettings: (settings: AppSettings) => invoke<void>('settings:save', settings),
  saveSchedule: (kind: ScheduleKind, schedule: Activity[]) => invoke<ScheduleSaveResult>('schedule:save', kind, schedule),
  resetSchedule: (kind: ScheduleKind) => invoke<ScheduleSaveResult>('schedule:reset', kind),
  command: (command: RuntimeCommand) => invoke<void>('runtime:command', command),
  showDashboard: () => invoke<void>('window:dashboard'),
  showWidget: () => invoke<{ ok: boolean; reason?: string }>('window:widget'),
  minimize: () => invoke<void>('window:minimize'),
  close: () => invoke<void>('window:close'),
  toggleAlwaysOnTop: () => invoke<void>('window:topmost'),
  setCompact: (compact: boolean) => invoke<void>('window:compact', compact),
  getHardware: () => invoke<HardwareSnapshot | null>('hardware:get'),
  retryHardware: () => invoke<void>('hardware:retry'),
  getStatus: () => invoke<AppStatus | null>('app:status'),
  openLogs: () => invoke<void>('app:open-logs'),
  onSnapshot: (callback: (snapshot: Snapshot) => void) => subscribe('snapshot:updated', isSnapshot, callback),
  onTransition: (callback: (payload: TransitionPayload) => void) => subscribe('activity:transition', isTransition, callback),
  onHardware: (callback: (snapshot: HardwareSnapshot) => void) => subscribe('hardware:update', isHardware, callback),
}

contextBridge.exposeInMainWorld('focusFlow', api)
export type FocusFlowApi = typeof api
