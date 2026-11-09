import type { Activity, ScheduleKind, ScheduleSet, ScheduleView } from '../../electron/shared'

/** Monday to Saturday. Sunday is a rest day unless the user enables it. */
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5, 6]
const minute = 60_000
const day = 86_400_000
const BREAK_IDS = new Set(['almoco', 'cafe'])

/** Breaks are scheduled blocks that do not count as focus time. */
export const isBreakActivity = (item: Pick<Activity, 'id'>) => BREAK_IDS.has(item.id)

export function parseTime(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return Number.NaN
  const hours = Number(match[1]), minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : Number.NaN
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function atMinute(date: Date, minutes: number): number {
  const value = new Date(date)
  value.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return value.getTime()
}

export const MAX_ACTIVITIES = 60
export const MAX_NAME_LENGTH = 80

export function validateSchedule(schedule: Activity[]): string | null {
  if (schedule.length === 0) return 'Adicione pelo menos uma atividade.'
  if (schedule.length > MAX_ACTIVITIES) return `Use no máximo ${MAX_ACTIVITIES} atividades.`
  const ids = new Set<string>()
  for (const item of schedule) {
    if (!item.name.trim()) return 'Toda atividade precisa de um nome.'
    if (item.name.length > MAX_NAME_LENGTH) return `O nome de “${item.name.slice(0, 20)}…” é longo demais (máximo ${MAX_NAME_LENGTH} caracteres).`
    if (!item.id || ids.has(item.id)) return 'Cada atividade precisa de um identificador único.'
    ids.add(item.id)
    const start = parseTime(item.start), end = parseTime(item.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return `Horário inválido em “${item.name}”.`
  }
  const sorted = [...schedule].sort((a, b) => parseTime(a.start) - parseTime(b.start))
  for (let index = 1; index < sorted.length; index++) {
    if (parseTime(sorted[index].start) < parseTime(sorted[index - 1].end)) {
      return `“${sorted[index].name}” se sobrepõe a “${sorted[index - 1].name}”.`
    }
  }
  return null
}

/** Saturday has its own agenda; every other enabled day (Monday-Friday, and Sunday if the user enabled it) uses the weekday agenda. */
export const scheduleKindForDay = (dayOfWeek: number): ScheduleKind => dayOfWeek === 6 ? 'saturday' : 'weekday'

export function scheduleForDate(set: ScheduleSet, date: Date): Activity[] {
  return set[scheduleKindForDay(date.getDay())]
}

const isSet = (value: Activity[] | ScheduleSet): value is ScheduleSet => !Array.isArray(value)

function getWorkDate(date: Date, workingDays: number[]): Date | null {
  const workDate = new Date(date)
  if (!workingDays.includes(workDate.getDay())) return null
  workDate.setHours(0, 0, 0, 0)
  return workDate
}

function sortedBlocks(schedule: Activity[]): Activity[] {
  return [...schedule].sort((a, b) => parseTime(a.start) - parseTime(b.start))
}

/** Start (timestamp) of the first block on the next enabled day after `date`, or null when no day is enabled. */
export function nextWorkdayStart(date: Date, schedules: Activity[] | ScheduleSet, workingDays: number[]): number | null {
  const cursor = new Date(date)
  cursor.setHours(0, 0, 0, 0)
  for (let count = 0; count < 8; count++) {
    cursor.setDate(cursor.getDate() + 1)
    if (!workingDays.includes(cursor.getDay())) continue
    const blocks = sortedBlocks(isSet(schedules) ? scheduleForDate(schedules, cursor) : schedules)
    if (blocks.length) return atMinute(cursor, parseTime(blocks[0].start))
  }
  return null
}

export function totalFocusMs(schedule: Activity[]): number {
  return schedule.filter(item => !isBreakActivity(item)).reduce((sum, item) => sum + (parseTime(item.end) - parseTime(item.start)) * minute, 0)
}

/**
 * Resolves what is happening at `now`. Accepts either a single agenda (applied to every enabled day) or the
 * per-day-kind set, in which case Saturday uses its own agenda.
 */
export function getScheduleView(now: number, schedules: Activity[] | ScheduleSet, workingDays = DEFAULT_WORKING_DAYS): ScheduleView {
  const date = new Date(now)
  const today = getWorkDate(date, workingDays)
  const scheduleKind = scheduleKindForDay(date.getDay())
  const schedule = isSet(schedules) ? schedules[scheduleKind] : schedules
  const total = totalFocusMs(schedule)
  const empty = { activity: null, next: null, startAt: null, endAt: null, nextAt: null, totalFocusMs: total, dayStart: null, dayEnd: null, scheduleKind }
  if (!today) return { kind: 'rest', ...empty, nextAt: nextWorkdayStart(date, schedules, workingDays) }
  const blocks = sortedBlocks(schedule)
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  if (!first || !last) return { kind: 'finished', ...empty, nextAt: nextWorkdayStart(date, schedules, workingDays) }
  const dayStart = atMinute(today, parseTime(first.start)), dayEnd = atMinute(today, parseTime(last.end))
  const bounds = { ...empty, dayStart, dayEnd }
  if (now < dayStart) return { kind: 'before', ...bounds, next: first, nextAt: dayStart }
  for (let index = 0; index < blocks.length; index++) {
    const current = blocks[index]
    const startAt = atMinute(today, parseTime(current.start)), endAt = atMinute(today, parseTime(current.end))
    if (now >= startAt && now < endAt) return { kind: 'activity', ...bounds, activity: current, next: blocks[index + 1] ?? null, startAt, endAt, nextAt: endAt }
    const next = blocks[index + 1]
    if (now >= endAt && next && now < atMinute(today, parseTime(next.start))) {
      return { kind: 'before', ...bounds, next, nextAt: atMinute(today, parseTime(next.start)) }
    }
  }
  if (now >= dayEnd) return { kind: 'finished', ...bounds, nextAt: nextWorkdayStart(date, schedules, workingDays) }
  return { kind: 'before', ...bounds, next: first, nextAt: dayStart }
}

export function remainingMs(endAt: number | null, now: number): number {
  return endAt === null ? 0 : Math.max(0, endAt - now)
}

export function progressPercent(startAt: number | null, endAt: number | null, now: number): number {
  if (startAt === null || endAt === null || endAt <= startAt) return 0
  return Math.min(100, Math.max(0, ((now - startAt) / (endAt - startAt)) * 100))
}

export type DayTotals = { elapsedMs: number; totalMs: number; percent: number; completed: number; count: number }

/** Focus time done so far today (breaks excluded) for the agenda that applies to `now`'s date. */
export function getDayTotals(schedule: Activity[], now: number): DayTotals {
  const date = new Date(now)
  let elapsedMs = 0, totalMs = 0, completed = 0
  for (const item of schedule) {
    const start = atMinute(date, parseTime(item.start)), end = atMinute(date, parseTime(item.end))
    if (isBreakActivity(item) || !(end > start)) continue
    totalMs += end - start
    elapsedMs += Math.max(0, Math.min(now, end) - start)
    if (now >= end) completed++
  }
  return { elapsedMs, totalMs, percent: totalMs ? Math.min(100, (elapsedMs / totalMs) * 100) : 0, completed, count: schedule.filter(item => !isBreakActivity(item)).length }
}

export function getDayBounds(now: number): { start: number; end: number } {
  const value = new Date(now)
  value.setHours(0, 0, 0, 0)
  return { start: value.getTime(), end: value.getTime() + day }
}
