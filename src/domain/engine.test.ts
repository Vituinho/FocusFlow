import { describe, expect, it } from 'vitest'
import { DEFAULT_RUNTIME, DEFAULT_SCHEDULES, DEFAULT_SETTINGS, RuntimeState } from '../../electron/shared'
import { applyRuntimeCommand } from './runtime'
import { activityKey, effectiveView, EngineInput, ScheduleEngine } from './engine'
import { getScheduleView } from './schedule'

const at = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 9, day, hour, minute, second).getTime()
const WORKING = DEFAULT_SETTINGS.workingDays
const input = (now: number, extra: Partial<EngineInput> = {}): EngineInput => ({ now, schedules: DEFAULT_SCHEDULES, workingDays: WORKING, runtime: { ...DEFAULT_RUNTIME }, warningsEnabled: false, ...extra })

/** Runs the engine once a second between two instants, as the main process does, collecting events. */
function run(engine: ScheduleEngine, from: number, to: number, extra: Partial<EngineInput> = {}) {
  const events: string[] = []
  for (let now = from; now <= to; now += 1000) {
    for (const event of engine.tick(input(now, extra)).events) events.push(`${event.type}:${event.name}@${new Date(now).toTimeString().slice(0, 8)}`)
  }
  return events
}

describe('schedule engine notifications', () => {
  it('announces each transition exactly once on a Saturday', () => {
    const engine = new ScheduleEngine()
    engine.tick(input(at(24, 7, 59, 0)))
    const events = run(engine, at(24, 7, 59, 1), at(24, 9, 46))
    expect(events).toEqual(['transition:Planejamento diário@08:00:00', 'transition:Projetos em andamento@08:15:00', 'transition:LeetCode / DSA@09:45:00'])
  })

  it('does not announce anything when the app starts in the middle of a block, even right after a boundary', () => {
    const engine = new ScheduleEngine()
    expect(engine.tick(input(at(24, 10, 25, 20))).events).toEqual([])
    expect(run(engine, at(24, 10, 25, 21), at(24, 10, 30))).toEqual([])
  })

  it('does not replay the missed block after sleep/resume, then resumes normal announcements', () => {
    const engine = new ScheduleEngine()
    run(engine, at(24, 8, 59, 50), at(24, 9, 0))
    // The machine sleeps at 09:00 and resumes at 09:45:30, right after the DSA block started.
    engine.markResumed()
    expect(engine.tick(input(at(24, 9, 45, 30))).events).toEqual([])
    expect(run(engine, at(24, 9, 45, 31), at(24, 10, 24))).toEqual([])
    expect(run(engine, at(24, 10, 24, 1), at(24, 10, 26))).toEqual(['transition:Projetos em andamento@10:25:00'])
  })

  it('treats a long timer stall as a resume even when the power event is missed', () => {
    const engine = new ScheduleEngine()
    run(engine, at(24, 9, 40), at(24, 9, 44))
    expect(engine.tick(input(at(24, 9, 45, 20))).events).toEqual([]) // 76 s gap -> suppressed
    expect(engine.tick(input(at(24, 9, 45, 21))).events).toEqual([])
  })

  it('emits nothing for the end of the Saturday agenda at 12:00 and nothing afterwards', () => {
    const engine = new ScheduleEngine()
    run(engine, at(24, 11, 58), at(24, 11, 59, 59))
    const tick = engine.tick(input(at(24, 12, 0)))
    expect(tick.events).toEqual([])
    expect(tick.view.kind).toBe('finished')
    expect(run(engine, at(24, 12, 0, 1), at(24, 12, 5))).toEqual([])
  })

  it('warns once, five minutes before the end, only when enabled and never after a restart inside the window', () => {
    const engine = new ScheduleEngine()
    engine.tick(input(at(24, 11, 54, 0), { warningsEnabled: true }))
    expect(run(engine, at(24, 11, 54, 1), at(24, 11, 59, 59), { warningsEnabled: true })).toEqual(['warning:Projetos em andamento@11:55:00'])
    const quiet = new ScheduleEngine()
    quiet.tick(input(at(24, 11, 54, 0), { warningsEnabled: false }))
    expect(run(quiet, at(24, 11, 54, 1), at(24, 11, 59), { warningsEnabled: false })).toEqual([])
    const restarted = new ScheduleEngine()
    expect(run(restarted, at(24, 11, 55, 40), at(24, 11, 59), { warningsEnabled: true })).toEqual([]) // app (re)started after the warning moment
  })

  it('does not warn for the five-minute closing block of the weekday agenda at its start', () => {
    const engine = new ScheduleEngine()
    engine.tick(input(at(26, 17, 54, 0)))
    expect(run(engine, at(26, 17, 54, 1), at(26, 17, 59))).toEqual(['transition:Encerramento do dia@17:55:00'])
  })

  it('never announces while paused and reports day changes so stale manual state is dropped', () => {
    const engine = new ScheduleEngine()
    const paused: RuntimeState = { ...DEFAULT_RUNTIME, paused: true, frozenRemainingMs: 60_000, pausedAt: at(24, 9, 40) }
    engine.tick(input(at(24, 9, 44), { runtime: paused }))
    expect(run(engine, at(24, 9, 44, 1), at(24, 9, 46), { runtime: paused })).toEqual([])
    const manual: RuntimeState = { ...DEFAULT_RUNTIME, manual: { name: 'Sessão', endAt: at(26, 23) } }
    const next = new ScheduleEngine()
    next.tick(input(at(25, 23, 59, 59), { runtime: manual }))
    const rollover = next.tick(input(at(26, 0, 0, 1), { runtime: manual }))
    expect(rollover.dayChanged).toBe(true)
    expect(rollover.view.activity?.id).not.toBe('manual')
  })

  it('reports manual sessions that have ended', () => {
    const engine = new ScheduleEngine()
    const runtime: RuntimeState = { ...DEFAULT_RUNTIME, manual: { name: 'Leitura', endAt: at(24, 9, 0) } }
    expect(engine.tick(input(at(24, 8, 59), { runtime })).manualExpired).toBe(false)
    expect(engine.tick(input(at(24, 9, 0, 1), { runtime })).manualExpired).toBe(true)
  })
})

describe('manual mode and effective view', () => {
  it('layers a manual session over the day-specific schedule with real progress', () => {
    const now = at(24, 9, 0)
    const runtime = applyRuntimeCommand(DEFAULT_RUNTIME, { type: 'manual', name: 'Leitura', minutes: 30 }, getScheduleView(now, DEFAULT_SCHEDULES, WORKING), now)
    const view = effectiveView(at(24, 9, 15), DEFAULT_SCHEDULES, WORKING, runtime)
    expect(view.activity?.name).toBe('Leitura')
    expect(view.startAt).toBe(now)
    expect(view.endAt).toBe(at(24, 9, 30))
    expect(view.scheduleKind).toBe('saturday')
    expect(activityKey(at(24, 9, 15), view)).toContain(':manual')
    expect(effectiveView(at(24, 9, 31), DEFAULT_SCHEDULES, WORKING, runtime).activity?.id).toBe('sab-projetos-1')
  })

  it('skip on Saturday advances to the Saturday next block, and to nothing after the last one', () => {
    const now = at(24, 9, 50)
    const skipped = applyRuntimeCommand(DEFAULT_RUNTIME, { type: 'skip' }, getScheduleView(now, DEFAULT_SCHEDULES, WORKING), now)
    expect(skipped.manual).toMatchObject({ name: 'Projetos em andamento', endAt: at(24, 12, 0) })
    const last = at(24, 11, 0)
    expect(applyRuntimeCommand(DEFAULT_RUNTIME, { type: 'skip' }, getScheduleView(last, DEFAULT_SCHEDULES, WORKING), last).manual).toBeUndefined()
  })

  it('pause freezes the remaining time and resume continues even after the block boundary', () => {
    const now = at(24, 11, 58)
    const view = getScheduleView(now, DEFAULT_SCHEDULES, WORKING)
    const paused = applyRuntimeCommand(DEFAULT_RUNTIME, { type: 'pause' }, view, now)
    expect(paused.frozenRemainingMs).toBe(120_000)
    const resumed = applyRuntimeCommand(paused, { type: 'resume' }, view, at(24, 12, 30))
    expect(resumed.manual).toMatchObject({ endAt: at(24, 12, 32), startedAt: at(24, 12, 30) })
  })

  it('extend lengthens the current block and automatic clears manual state', () => {
    const now = at(24, 11, 50)
    const view = getScheduleView(now, DEFAULT_SCHEDULES, WORKING)
    const extended = applyRuntimeCommand(DEFAULT_RUNTIME, { type: 'extend', minutes: 10 }, view, now)
    expect(extended.manual?.endAt).toBe(at(24, 12, 10))
    expect(applyRuntimeCommand(extended, { type: 'automatic' }, view, now).manual).toBeUndefined()
    expect(applyRuntimeCommand(DEFAULT_RUNTIME, { type: 'extend', minutes: 10 }, getScheduleView(at(24, 13), DEFAULT_SCHEDULES, WORKING), at(24, 13))).toEqual(DEFAULT_RUNTIME)
  })
})
