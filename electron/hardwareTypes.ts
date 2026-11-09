// Types and validation shared by the main process, preload and renderer. Pure, no Node/Electron imports.

export type HardwareStatus = 'off' | 'starting' | 'ok' | 'degraded' | 'unavailable'

export type HardwareVolume = {
  /** Drive letter such as "C:". */
  id: string
  label: string
  /** null means N/D: the drive is disconnected or could not be read. */
  usedBytes: number | null
  totalBytes: number | null
}

export type HardwareSnapshot = {
  timestamp: number
  status: HardwareStatus
  /** System-wide CPU utilisation, 0-100, or null (N/D). Never the app's own process load. */
  cpu: number | null
  ram: { percent: number | null; usedBytes: number | null; totalBytes: number | null }
  /** Busiest GPU adapter; null when the OS exposes no usable GPU counters. */
  gpu: { percent: number | null; adapters: { id: string; percent: number }[] }
  /** Physical disk time (I/O activity), separate from storage capacity. */
  disk: { activityPercent: number | null; volumes: HardwareVolume[] }
  /** Short, user-facing reasons for any N/D values. */
  notes: string[]
}

export const EMPTY_HARDWARE: HardwareSnapshot = {
  timestamp: 0, status: 'off', cpu: null,
  ram: { percent: null, usedBytes: null, totalBytes: null },
  gpu: { percent: null, adapters: [] },
  disk: { activityPercent: null, volumes: [] },
  notes: [],
}

const STATUSES: HardwareStatus[] = ['off', 'starting', 'ok', 'degraded', 'unavailable']

export const clampPercent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(100, Math.max(0, value)) * 10) / 10 : null

const bytes = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : ''

/** Validates (and sanitises) a snapshot received over IPC. Returns null when it is not well formed. */
export function validateHardwareSnapshot(value: unknown): HardwareSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, any>
  if (!STATUSES.includes(raw.status) || typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp)) return null
  const adapters = Array.isArray(raw.gpu?.adapters) ? raw.gpu.adapters.slice(0, 8).flatMap((item: any) => {
    const percent = clampPercent(item?.percent)
    return percent === null ? [] : [{ id: text(item?.id, 24), percent }]
  }) : []
  const volumes = Array.isArray(raw.disk?.volumes) ? raw.disk.volumes.slice(0, 26).flatMap((item: any) => {
    const id = text(item?.id, 3)
    if (!/^[A-Za-z]:$/.test(id)) return []
    const used = bytes(item?.usedBytes), total = bytes(item?.totalBytes)
    const valid = used !== null && total !== null && used <= total
    return [{ id: id.toUpperCase(), label: text(item?.label, 48), usedBytes: valid ? used : null, totalBytes: valid ? total : null }]
  }) : []
  const ramTotal = bytes(raw.ram?.totalBytes), ramUsed = bytes(raw.ram?.usedBytes)
  const ramOk = ramTotal !== null && ramUsed !== null && ramUsed <= ramTotal
  return {
    timestamp: raw.timestamp,
    status: raw.status,
    cpu: clampPercent(raw.cpu),
    ram: { percent: clampPercent(raw.ram?.percent), usedBytes: ramOk ? ramUsed : null, totalBytes: ramOk ? ramTotal : null },
    gpu: { percent: clampPercent(raw.gpu?.percent), adapters },
    disk: { activityPercent: clampPercent(raw.disk?.activityPercent), volumes },
    notes: Array.isArray(raw.notes) ? raw.notes.slice(0, 6).map((note: unknown) => text(note, 120)).filter(Boolean) : [],
  }
}

export function formatPercent(value: number | null): string { return value === null ? 'N/D' : `${Math.round(value)}%` }

export function formatBytes(value: number | null): string {
  if (value === null) return 'N/D'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value, unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}
