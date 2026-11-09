import { describe, expect, it } from 'vitest'
import { DEFAULT_SCHEDULE, SATURDAY_SCHEDULE } from '../../electron/shared'
import { DATA_VERSION, defaultData, migrateData, needsMigrationBackup, sanitizeActivities, sanitizeRuntime } from './migration'

const customWeekday = [
  { id: 'foco', name: 'Foco profundo', start: '09:00', end: '11:30', color: '#112233', icon: 'code' },
  { id: 'almoco', name: 'Almoço longo', start: '11:30', end: '13:00', color: '#f6ad70', icon: 'utensils' },
  { id: 'estudo', name: 'Estudo', start: '13:00', end: '16:00', color: '#7da8ff', icon: 'languages' },
]

// Shape written by FocusFlow 1.0.0 (no version field, single schedule).
const v1File = () => ({
  schedule: customWeekday,
  settings: { theme: 'light', notifications: false, sound: false, speech: true, warnings: true, alwaysOnTop: false, transparency: true, launchAtStartup: true, workingDays: [1, 2, 3, 4, 5], compactWidget: true },
  runtime: { paused: false, focusMode: true, skippedKeys: [], manual: { name: 'Leitura', endAt: 1_700_000_000_000 } },
  widgetBounds: { x: -1500, y: 120, width: 286, height: 112 },
})

describe('configuration migration', () => {
  it('creates defaults for a new install: Saturday agenda present, Saturday enabled, Sunday off', () => {
    const result = migrateData(null)
    expect(result).toMatchObject({ migratedFrom: null, repaired: false })
    expect(result.data.version).toBe(DATA_VERSION)
    expect(result.data.schedules.weekday).toEqual(DEFAULT_SCHEDULE)
    expect(result.data.schedules.saturday).toEqual(SATURDAY_SCHEDULE)
    expect(result.data.settings.workingDays).toEqual([1, 2, 3, 4, 5, 6])
    expect(result.data.settings.hardwareMonitor).toBe(true)
  })

  it('migrates an existing v1 focusflow.json without losing the customised agenda or any setting', () => {
    const result = migrateData(v1File())
    expect(result.migratedFrom).toBe(1)
    expect(needsMigrationBackup(result)).toBe(true)
    expect(result.data.schedules.weekday).toEqual(customWeekday)
    expect(result.data.schedules.saturday).toEqual(SATURDAY_SCHEDULE)
    expect(result.data.settings).toMatchObject({ theme: 'light', notifications: false, sound: false, speech: true, warnings: true, alwaysOnTop: false, transparency: true, launchAtStartup: true, compactWidget: true })
    expect(result.data.settings.workingDays).toEqual([1, 2, 3, 4, 5, 6])
    expect(result.data.runtime.manual).toEqual({ name: 'Leitura', endAt: 1_700_000_000_000 })
    expect(result.data.runtime.focusMode).toBe(true)
    expect(result.data.widgetBounds).toEqual({ x: -1500, y: 120, width: 286, height: 112 })
    expect(result.data.widgetVisible).toBe(true)
  })

  it('keeps Sunday exactly as the user had it when migrating', () => {
    const withSunday = { ...v1File(), settings: { ...v1File().settings, workingDays: [0, 1, 2] } }
    expect(migrateData(withSunday).data.settings.workingDays).toEqual([0, 1, 2, 6])
  })

  it('is idempotent and never re-enables Saturday after the user turned it off', () => {
    const migrated = migrateData(v1File()).data
    const userChoice = { ...migrated, settings: { ...migrated.settings, workingDays: [1, 2, 3, 4, 5] }, schedules: { ...migrated.schedules, saturday: [{ ...SATURDAY_SCHEDULE[0], end: '08:45' }, SATURDAY_SCHEDULE[3]] } }
    const again = migrateData(JSON.parse(JSON.stringify(userChoice)))
    expect(again.migratedFrom).toBe(DATA_VERSION)
    expect(again.repaired).toBe(false)
    expect(needsMigrationBackup(again)).toBe(false)
    expect(again.data.settings.workingDays).toEqual([1, 2, 3, 4, 5])
    expect(again.data.schedules.saturday[0].end).toBe('08:45')
    expect(again.data).toEqual(userChoice)
  })

  it('falls back per field: an invalid Saturday agenda does not discard the weekday agenda or settings', () => {
    const data = migrateData(v1File()).data
    const damaged = { ...data, schedules: { weekday: customWeekday, saturday: [{ id: 'x', name: 'Ruim', start: '10:00', end: '09:00', color: '#000000', icon: 'code' }] }, settings: { ...data.settings, theme: 'purple', workingDays: 'x' } }
    const result = migrateData(damaged)
    expect(result.repaired).toBe(true)
    expect(result.data.schedules.weekday).toEqual(customWeekday)
    expect(result.data.schedules.saturday).toEqual(SATURDAY_SCHEDULE)
    expect(result.data.settings.theme).toBe('dark')
    expect(result.data.settings.workingDays).toEqual([1, 2, 3, 4, 5, 6])
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('restores the default weekday agenda when a v1 schedule is corrupt', () => {
    const result = migrateData({ ...v1File(), schedule: [{ id: 'a', name: 5 }] })
    expect(result.data.schedules.weekday).toEqual(DEFAULT_SCHEDULE)
    expect(result.warnings.join(' ')).toContain('Weekday schedule')
  })

  it('treats non-object content as a repair, and newer formats as readable with a warning', () => {
    expect(migrateData('text').repaired).toBe(true)
    expect(migrateData([]).data).toEqual(defaultData())
    const future = migrateData({ ...defaultData(), version: 99, extra: { a: 1 } })
    expect(future.warnings[0]).toContain('newer format')
    expect(future.data.version).toBe(DATA_VERSION)
  })

  it('drops invalid stale runtime state instead of crashing on it', () => {
    const runtime = sanitizeRuntime({ paused: true, manual: { name: '', endAt: 'soon' }, skippedKeys: [1, 'ok'], frozenRemainingMs: -5 })
    expect(runtime).toMatchObject({ paused: false, focusMode: false, skippedKeys: ['ok'] })
    expect(runtime.manual).toBeUndefined()
    expect(sanitizeRuntime({ paused: true, frozenRemainingMs: 5000, pausedAt: 10 })).toMatchObject({ paused: true, frozenRemainingMs: 5000 })
    expect(sanitizeRuntime(null).paused).toBe(false)
  })

  it('rejects activities with bad types, colours or overlaps', () => {
    expect(sanitizeActivities(customWeekday)).toEqual(customWeekday)
    expect(sanitizeActivities([{ ...customWeekday[0], color: 'red' }])).toBeNull()
    expect(sanitizeActivities([{ ...customWeekday[0], icon: 5 }])).toBeNull()
    expect(sanitizeActivities([customWeekday[0], { ...customWeekday[1], start: '10:00' }])).toBeNull()
    expect(sanitizeActivities('nope')).toBeNull()
    expect(sanitizeActivities([null])).toBeNull()
  })

  it('ignores corrupt window bounds', () => {
    const result = migrateData({ ...v1File(), widgetBounds: { x: 'a', y: 1, width: 5, height: 5 } })
    expect(result.data.widgetBounds).toBeUndefined()
  })
})
