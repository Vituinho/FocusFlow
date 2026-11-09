import { isRect, Rect } from '../../electron/bounds'
import { Activity, AppSettings, DEFAULT_RUNTIME, DEFAULT_SCHEDULE, DEFAULT_SETTINGS, RuntimeState, SATURDAY_SCHEDULE, ScheduleSet } from '../../electron/shared'
import { MAX_NAME_LENGTH, validateSchedule } from './schedule'

export const DATA_VERSION = 2

export type PersistedData = {
  version: typeof DATA_VERSION
  schedules: ScheduleSet
  settings: AppSettings
  runtime: RuntimeState
  widgetBounds?: Rect
  dashboardBounds?: Rect & { maximized?: boolean }
  /** Whether the user last left the floating widget visible. */
  widgetVisible: boolean
}

export type MigrationResult = {
  data: PersistedData
  /** Version the stored file had (1 for files written before versioning), or null for a brand new install. */
  migratedFrom: number | null
  /** True when stored content had to be repaired or replaced. */
  repaired: boolean
  warnings: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Defensive parse of one agenda. Returns null when anything about it is invalid so callers keep the previous/default one. */
export function sanitizeActivities(value: unknown): Activity[] | null {
  if (!Array.isArray(value)) return null
  const result: Activity[] = []
  for (const item of value) {
    if (!isObject(item)) return null
    const { id, name, start, end, color, icon } = item
    if (typeof id !== 'string' || typeof name !== 'string' || typeof start !== 'string' || typeof end !== 'string') return null
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return null
    if (typeof icon !== 'string' || icon.length > 24 || id.length > 80 || name.length > MAX_NAME_LENGTH) return null
    result.push({ id, name, start, end, color, icon })
  }
  if (validateSchedule(result)) return null
  return result.sort((a, b) => a.start.localeCompare(b.start))
}

function sanitizeSettings(value: unknown, warnings: string[]): { settings: AppSettings; workingDaysValid: boolean } {
  const source = isObject(value) ? value : {}
  const pick = <K extends keyof AppSettings>(key: K): boolean => typeof source[key] === 'boolean' ? source[key] as boolean : DEFAULT_SETTINGS[key] as boolean
  const days = Array.isArray(source.workingDays) ? [...new Set(source.workingDays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort() : []
  if (isObject(value) && Array.isArray(source.workingDays) && days.length !== source.workingDays.length) warnings.push('Invalid working days were dropped')
  return {
    workingDaysValid: days.length > 0,
    settings: {
      theme: source.theme === 'light' ? 'light' : 'dark',
      notifications: pick('notifications'), sound: pick('sound'), speech: pick('speech'), warnings: pick('warnings'),
      alwaysOnTop: pick('alwaysOnTop'), transparency: pick('transparency'), launchAtStartup: pick('launchAtStartup'),
      compactWidget: pick('compactWidget'), hardwareMonitor: pick('hardwareMonitor'), crashRecovery: pick('crashRecovery'),
      workingDays: days.length ? days : [...DEFAULT_SETTINGS.workingDays],
    },
  }
}

export function sanitizeRuntime(value: unknown): RuntimeState {
  const source = isObject(value) ? value : {}
  const runtime: RuntimeState = { paused: source.paused === true, focusMode: source.focusMode === true, skippedKeys: Array.isArray(source.skippedKeys) ? source.skippedKeys.filter((key): key is string => typeof key === 'string').slice(-50) : [] }
  if (finiteNumber(source.pausedAt)) runtime.pausedAt = source.pausedAt
  if (finiteNumber(source.frozenRemainingMs) && source.frozenRemainingMs >= 0) runtime.frozenRemainingMs = source.frozenRemainingMs
  if (typeof source.pausedActivityName === 'string') runtime.pausedActivityName = source.pausedActivityName.slice(0, MAX_NAME_LENGTH)
  if (finiteNumber(source.extendedUntil)) runtime.extendedUntil = source.extendedUntil
  const manual = source.manual
  if (isObject(manual) && typeof manual.name === 'string' && manual.name.trim() && finiteNumber(manual.endAt)) {
    runtime.manual = { name: manual.name.slice(0, MAX_NAME_LENGTH), endAt: manual.endAt, ...(finiteNumber(manual.startedAt) ? { startedAt: manual.startedAt } : {}) }
  }
  // A paused session without its frozen time cannot be resumed meaningfully.
  if (runtime.paused && runtime.frozenRemainingMs === undefined) { runtime.paused = false; runtime.pausedAt = undefined }
  return runtime
}

export function defaultData(): PersistedData {
  return { version: DATA_VERSION, schedules: { weekday: clone(DEFAULT_SCHEDULE), saturday: clone(SATURDAY_SCHEDULE) }, settings: { ...DEFAULT_SETTINGS, workingDays: [...DEFAULT_SETTINGS.workingDays] }, runtime: { ...DEFAULT_RUNTIME, skippedKeys: [] }, widgetVisible: true }
}

/**
 * Turns whatever was stored into current-version data without losing user changes.
 *
 * - No file: defaults (Saturday enabled, Sunday rest).
 * - v1 (no `version`, single `schedule`): the customised weekday agenda and every setting are kept; the Saturday agenda is
 *   added with its default and Saturday is enabled as a working day exactly once (this is the only place that does so).
 * - v2: fields are validated individually and invalid ones fall back to defaults. Manual choices, such as a disabled Saturday
 *   or an edited Saturday agenda, are never overridden.
 */
export function migrateData(raw: unknown): MigrationResult {
  const defaults = defaultData()
  if (raw === null || raw === undefined) return { data: defaults, migratedFrom: null, repaired: false, warnings: [] }
  if (!isObject(raw)) return { data: defaults, migratedFrom: null, repaired: true, warnings: ['Stored data was not an object; defaults were used'] }

  const warnings: string[] = []
  const version = finiteNumber(raw.version) ? Math.floor(raw.version) : 1
  if (version > DATA_VERSION) warnings.push(`Stored data uses a newer format (v${version}); unknown fields are ignored`)

  const { settings, workingDaysValid } = sanitizeSettings(raw.settings, warnings)
  let weekday: Activity[] | null
  let saturday: Activity[] | null = null
  if (version === 1) {
    weekday = sanitizeActivities(raw.schedule)
    if (!weekday) warnings.push('Weekday schedule was missing or invalid; the default was restored')
    // One-time migration: Saturday becomes a working day with its own agenda. Sunday is left exactly as stored.
    if (!settings.workingDays.includes(6)) settings.workingDays = [...settings.workingDays, 6].sort()
  } else {
    const schedules = isObject(raw.schedules) ? raw.schedules : {}
    weekday = sanitizeActivities(schedules.weekday)
    saturday = sanitizeActivities(schedules.saturday)
    if (!weekday) warnings.push('Weekday schedule was missing or invalid; the default was restored')
    if (!saturday) warnings.push('Saturday schedule was missing or invalid; the default was restored')
  }
  if (!workingDaysValid) warnings.push('Working days were missing; defaults were used')

  const widgetBounds = isRect(raw.widgetBounds) ? { x: raw.widgetBounds.x, y: raw.widgetBounds.y, width: raw.widgetBounds.width, height: raw.widgetBounds.height } : undefined
  const dash = raw.dashboardBounds
  const dashboardBounds = isRect(dash) ? { x: dash.x, y: dash.y, width: dash.width, height: dash.height, ...(isObject(dash) && dash.maximized === true ? { maximized: true } : {}) } : undefined

  const data: PersistedData = {
    version: DATA_VERSION,
    schedules: { weekday: weekday ?? defaults.schedules.weekday, saturday: saturday ?? defaults.schedules.saturday },
    settings,
    runtime: sanitizeRuntime(raw.runtime),
    ...(widgetBounds ? { widgetBounds } : {}),
    ...(dashboardBounds ? { dashboardBounds } : {}),
    widgetVisible: raw.widgetVisible === false ? false : true,
  }
  return { data, migratedFrom: version === DATA_VERSION ? DATA_VERSION : version, repaired: warnings.length > 0, warnings }
}

/** True when the stored version differs from the current one and the original should be preserved before rewriting. */
export const needsMigrationBackup = (result: MigrationResult) => result.migratedFrom !== null && (result.migratedFrom !== DATA_VERSION || result.repaired)
