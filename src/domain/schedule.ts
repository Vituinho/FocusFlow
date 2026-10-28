import { Activity, ScheduleView } from '../../electron/shared'

export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5]
const minute = 60_000
const day = 86_400_000

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

export function validateSchedule(schedule: Activity[]): string | null {
  if (schedule.length === 0) return 'Adicione pelo menos uma atividade.'
  const ids = new Set<string>()
  for (const item of schedule) {
    if (!item.name.trim()) return 'Toda atividade precisa de um nome.'
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

function getWorkDate(date: Date, workingDays: number[]): Date | null {
  const workDate = new Date(date)
  if (!workingDays.includes(workDate.getDay())) return null
  workDate.setHours(0, 0, 0, 0)
  return workDate
}

function nextWorkday(date: Date, workingDays: number[]): Date {
  const result = new Date(date)
  result.setHours(0, 0, 0, 0)
  for (let count = 0; count < 8; count++) {
    result.setDate(result.getDate() + 1)
    if (workingDays.includes(result.getDay())) return result
  }
  return result
}

export function getScheduleView(now: number, schedule: Activity[], workingDays = DEFAULT_WORKING_DAYS): ScheduleView {
  const date = new Date(now)
  const today = getWorkDate(date, workingDays)
  const totalFocusMs = schedule.filter(item => !['almoco', 'cafe'].includes(item.id)).reduce((sum, item) => sum + (parseTime(item.end) - parseTime(item.start)) * minute, 0)
  if (!today) {
    return { kind: 'rest', activity: null, next: null, startAt: null, endAt: null, nextAt: null, totalFocusMs, dayStart: null, dayEnd: null }
  }
  const blocks = [...schedule].sort((a, b) => parseTime(a.start) - parseTime(b.start))
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  if (!first || !last) return { kind: 'finished', activity: null, next: null, startAt: null, endAt: null, nextAt: null, totalFocusMs, dayStart: null, dayEnd: null }
  const dayStart = atMinute(today, parseTime(first.start)), dayEnd = atMinute(today, parseTime(last.end))
  if (now < dayStart) {
    const nextDay = nextWorkday(today, workingDays)
    const nextAt = atMinute(today, parseTime(first.start))
    return { kind: 'before', activity: null, next: first, startAt: null, endAt: null, nextAt: now < nextAt ? nextAt : atMinute(nextDay, parseTime(first.start)), totalFocusMs, dayStart, dayEnd }
  }
  for (let index = 0; index < blocks.length; index++) {
    const current = blocks[index]
    const startAt = atMinute(today, parseTime(current.start)), endAt = atMinute(today, parseTime(current.end))
    if (now >= startAt && now < endAt) {
      const next = blocks[index + 1] ?? null
      return { kind: 'activity', activity: current, next, startAt, endAt, nextAt: endAt, totalFocusMs, dayStart, dayEnd }
    }
    const next = blocks[index + 1]
    if (now < startAt && index > 0) {
      return { kind: 'before', activity: null, next: current, startAt: null, endAt: null, nextAt: startAt, totalFocusMs, dayStart, dayEnd }
    }
    if (now >= endAt && next && now < atMinute(today, parseTime(next.start))) {
      return { kind: 'before', activity: null, next, startAt: null, endAt: null, nextAt: atMinute(today, parseTime(next.start)), totalFocusMs, dayStart, dayEnd }
    }
  }
  if (now >= dayEnd) return { kind: 'finished', activity: null, next: null, startAt: null, endAt: null, nextAt: null, totalFocusMs, dayStart, dayEnd }
  return { kind: 'before', activity: null, next: first, startAt: null, endAt: null, nextAt: dayStart, totalFocusMs, dayStart, dayEnd }
}

export function remainingMs(endAt: number | null, now: number): number {
  return endAt === null ? 0 : Math.max(0, endAt - now)
}

export function progressPercent(startAt: number | null, endAt: number | null, now: number): number {
  if (startAt === null || endAt === null || endAt <= startAt) return 0
  return Math.min(100, Math.max(0, ((now - startAt) / (endAt - startAt)) * 100))
}

export function getDayBounds(now: number): { start: number; end: number } {
  const value = new Date(now)
  value.setHours(0, 0, 0, 0)
  return { start: value.getTime(), end: value.getTime() + day }
}
