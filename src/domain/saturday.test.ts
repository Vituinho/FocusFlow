import { describe, expect, it } from 'vitest'
import { DEFAULT_SCHEDULE, DEFAULT_SCHEDULES, DEFAULT_SETTINGS, SATURDAY_SCHEDULE } from '../../electron/shared'
import { getDayTotals, getScheduleView, nextWorkdayStart, parseTime, scheduleKindForDay, validateSchedule } from './schedule'

// Local-time fixtures: 2026-10-23 is a Friday, 24 Saturday, 25 Sunday, 26 Monday.
const at = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 9, day, hour, minute, second).getTime()
const WORKING = DEFAULT_SETTINGS.workingDays
const view = (now: number, days = WORKING) => getScheduleView(now, DEFAULT_SCHEDULES, days)

describe('Saturday agenda (08:00-12:00)', () => {
  it('is enabled by default and Sunday is a rest day', () => {
    expect(WORKING).toEqual([1, 2, 3, 4, 5, 6])
    expect(WORKING).not.toContain(0)
  })

  it('07:59 is still before the day and points at the 08:00 start', () => {
    const result = view(at(24, 7, 59))
    expect(result.kind).toBe('before')
    expect(result.scheduleKind).toBe('saturday')
    expect(result.next?.id).toBe('sab-planejamento')
    expect(result.nextAt).toBe(at(24, 8, 0))
  })

  it('08:00 starts the first activity exactly', () => {
    const result = view(at(24, 8, 0))
    expect(result.kind).toBe('activity')
    expect(result.activity?.id).toBe('sab-planejamento')
    expect(result.startAt).toBe(at(24, 8, 0))
    expect(result.endAt).toBe(at(24, 8, 15))
  })

  it('11:59 is the last activity and it finishes at exactly 12:00', () => {
    const result = view(at(24, 11, 59, 59))
    expect(result.activity?.id).toBe('sab-projetos-2')
    expect(result.endAt).toBe(at(24, 12, 0, 0))
    expect(result.dayEnd).toBe(at(24, 12, 0))
    expect(result.next).toBeNull()
  })

  it('12:00 ends the day: no lunch, no afternoon, next start is Monday 08:00', () => {
    const result = view(at(24, 12, 0))
    expect(result.kind).toBe('finished')
    expect(result.activity).toBeNull()
    expect(result.nextAt).toBe(at(26, 8, 0))
    expect(view(at(24, 13, 0)).kind).toBe('finished')
    expect(view(at(24, 15, 20)).activity).toBeNull()
  })

  it('reuses the morning structure of the weekday agenda without lunch or afternoon blocks', () => {
    const morning = DEFAULT_SCHEDULE.filter(item => parseTime(item.end) <= 12 * 60)
    const shape = (list: typeof morning) => list.map(({ name, start, end, color, icon }) => ({ name, start, end, color, icon }))
    expect(shape(SATURDAY_SCHEDULE)).toEqual(shape(morning))
    expect(SATURDAY_SCHEDULE.some(item => ['almoco', 'cafe', 'sab-almoco'].includes(item.id) || /almoço|café/i.test(item.name))).toBe(false)
    expect(Math.max(...SATURDAY_SCHEDULE.map(item => parseTime(item.end)))).toBe(12 * 60)
    expect(Math.min(...SATURDAY_SCHEDULE.map(item => parseTime(item.start)))).toBe(8 * 60)
    expect(validateSchedule(SATURDAY_SCHEDULE)).toBeNull()
  })

  it('computes day totals from the Saturday agenda: 4 h of focus, partial progress at 10:00', () => {
    expect(getDayTotals(SATURDAY_SCHEDULE, at(24, 7, 0))).toMatchObject({ elapsedMs: 0, totalMs: 240 * 60_000, percent: 0, completed: 0, count: 4 })
    const mid = getDayTotals(SATURDAY_SCHEDULE, at(24, 10, 0))
    expect(mid.elapsedMs).toBe(120 * 60_000)
    expect(mid.percent).toBe(50)
    expect(mid.completed).toBe(2)
    expect(getDayTotals(SATURDAY_SCHEDULE, at(24, 12, 0))).toMatchObject({ elapsedMs: 240 * 60_000, percent: 100, completed: 4 })
    expect(getDayTotals(SATURDAY_SCHEDULE, at(24, 18, 0)).elapsedMs).toBe(240 * 60_000) // stays complete after the day ends
  })

  it('honours edits to the Saturday agenda without touching the weekday one', () => {
    const edited = { ...DEFAULT_SCHEDULES, saturday: [{ ...SATURDAY_SCHEDULE[0], end: '08:30' }, { ...SATURDAY_SCHEDULE[1], start: '08:30', end: '11:00' }] }
    expect(getScheduleView(at(24, 11, 30), edited, WORKING).kind).toBe('finished')
    expect(getScheduleView(at(24, 8, 20), edited, WORKING).activity?.id).toBe('sab-planejamento')
    expect(getScheduleView(at(26, 12, 30), edited, WORKING).activity?.id).toBe('almoco')
  })

  it('shows rest on Saturday when the user disabled it, and keeps honouring that choice', () => {
    const result = view(at(24, 9, 0), [1, 2, 3, 4, 5])
    expect(result.kind).toBe('rest')
    expect(result.nextAt).toBe(at(26, 8, 0))
  })
})

describe('Sunday and weekday behaviour', () => {
  it('Sunday is a rest day with the next start on Monday morning', () => {
    for (const hour of [0, 8, 10, 12, 18, 23]) expect(view(at(25, hour)).kind).toBe('rest')
    expect(view(at(25, 10)).nextAt).toBe(at(26, 8, 0))
    expect(view(at(25, 10)).activity).toBeNull()
  })

  it('a Sunday the user enabled uses the weekday agenda', () => {
    expect(view(at(25, 12, 30), [0, 1, 2, 3, 4, 5, 6]).activity?.id).toBe('almoco')
  })

  it('the Monday-Friday agenda is unchanged', () => {
    expect(DEFAULT_SCHEDULE.map(({ id, start, end }) => `${id} ${start}-${end}`)).toEqual([
      'planejamento 08:00-08:15', 'projetos-manha-1 08:15-09:45', 'dsa 09:45-10:25', 'projetos-manha-2 10:25-12:00',
      'almoco 12:00-13:45', 'novo-projeto 13:45-14:45', 'ingles 14:45-15:15', 'cafe 15:15-15:30', 'projetos-tarde 15:30-16:20',
      'digitacao 16:20-16:40', 'projetos-pessoais 16:40-17:10', 'frances 17:10-17:40', 'revisao 17:40-17:55', 'encerramento 17:55-18:00',
    ])
    for (const [day, name] of [[26, 'Monday'], [27, 'Tuesday'], [23, 'Friday']] as const) {
      expect(view(at(day, 12, 30)).activity?.id, name).toBe('almoco')
      expect(view(at(day, 17, 59)).activity?.id, name).toBe('encerramento')
      expect(view(at(day, 18, 0)).kind, name).toBe('finished')
    }
  })

  it('a day-specific set gives the same result as the legacy single-agenda API for weekdays', () => {
    for (const hour of [7, 8, 9, 12, 14, 17, 18]) {
      expect(getScheduleView(at(27, hour, 7), DEFAULT_SCHEDULES, WORKING)).toEqual(getScheduleView(at(27, hour, 7), DEFAULT_SCHEDULE, WORKING))
    }
  })

  it('Friday evening points at Saturday 08:00 and Saturday noon at Monday', () => {
    expect(view(at(23, 18, 5)).nextAt).toBe(at(24, 8, 0))
    expect(nextWorkdayStart(new Date(2026, 9, 24, 12), DEFAULT_SCHEDULES, WORKING)).toBe(at(26, 8, 0))
  })

  it('maps days to agenda kinds', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(scheduleKindForDay)).toEqual(['weekday', 'weekday', 'weekday', 'weekday', 'weekday', 'weekday', 'saturday'])
  })

  it('validates per-day agendas independently', () => {
    expect(validateSchedule([])).toContain('pelo menos uma')
    expect(validateSchedule([{ ...SATURDAY_SCHEDULE[0], name: ' ' }])).toContain('nome')
    expect(validateSchedule([SATURDAY_SCHEDULE[0], { ...SATURDAY_SCHEDULE[1], id: SATURDAY_SCHEDULE[0].id }])).toContain('identificador')
    expect(validateSchedule([{ ...SATURDAY_SCHEDULE[0], name: 'x'.repeat(81) }])).toContain('longo demais')
  })
})
