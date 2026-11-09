import type { RuntimeState, ScheduleSet, ScheduleView } from '../../electron/shared'
import { getScheduleView } from './schedule'
import { isFreshTransition } from './runtime'

const MINUTE = 60_000
/** A tick later than this after the previous one means the computer slept or the clock jumped. */
export const STALL_MS = 15_000

export type EngineEvent =
  | { type: 'transition'; name: string; nextName: string }
  | { type: 'warning'; name: string; nextName: string }

export type EngineInput = {
  now: number
  schedules: ScheduleSet
  workingDays: number[]
  runtime: RuntimeState
  warningsEnabled: boolean
}

export type EngineResult = {
  events: EngineEvent[]
  /** The calendar day changed since the previous tick: manual/paused state from yesterday must be discarded. */
  dayChanged: boolean
  /** Manual session that has ended and should be removed from persisted state. */
  manualExpired: boolean
  view: ScheduleView
}

export const dayKey = (now: number) => {
  const date = new Date(now)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export const activityKey = (now: number, view: ScheduleView) => view.activity ? `${dayKey(now)}:${view.activity.id}` : `${dayKey(now)}:${view.kind}`

const formatHm = (timestamp: number) => {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Schedule view with an active manual session layered on top. Pure: expiry is reported, never applied here. */
export function effectiveView(now: number, schedules: ScheduleSet, workingDays: number[], runtime: RuntimeState): ScheduleView {
  const view = getScheduleView(now, schedules, workingDays)
  const manual = runtime.manual
  if (!manual || manual.endAt <= now) return view
  const startAt = Math.min(manual.startedAt ?? now, now)
  return {
    ...view, kind: 'activity', next: null, startAt, endAt: manual.endAt, nextAt: manual.endAt,
    activity: { id: 'manual', name: manual.name, start: formatHm(startAt), end: formatHm(manual.endAt), color: '#58d5bd', icon: 'sparkles' },
  }
}

/**
 * Decides which notifications are due. Holds only the memory needed to avoid repeats; everything else is derived from
 * the wall clock, so restarts, sleep/resume and clock changes cannot replay or stack announcements.
 */
export class ScheduleEngine {
  private initialized = false
  private lastActivityKey = ''
  private lastWarningKey = ''
  private currentDay = ''
  private lastTickAt = 0
  private forceSuppress = true

  /** Call after the computer resumes or unlocks: the next tick records the new state without announcing it. */
  markResumed() { this.forceSuppress = true }

  /** Call after the agenda changed so an edit does not trigger an announcement. */
  markExternalChange() { this.forceSuppress = true }

  tick(input: EngineInput, suppress = false): EngineResult {
    const { now, schedules, workingDays } = input
    const events: EngineEvent[] = []
    const key = dayKey(now)
    const dayChanged = !!this.currentDay && this.currentDay !== key
    this.currentDay = key
    const gap = this.lastTickAt ? now - this.lastTickAt : 0
    this.lastTickAt = now
    if (this.forceSuppress || gap > STALL_MS || gap < -2000) suppress = true
    this.forceSuppress = false

    const runtime = dayChanged ? { ...input.runtime, manual: undefined, paused: false, frozenRemainingMs: undefined, pausedAt: undefined, pausedActivityName: undefined, skippedKeys: [] } : input.runtime
    const manualExpired = !!runtime.manual && runtime.manual.endAt <= now
    const view = effectiveView(now, schedules, workingDays, runtime)
    const currentKey = activityKey(now, view)

    if (!this.initialized) {
      this.initialized = true
      this.lastActivityKey = currentKey
    } else if (currentKey !== this.lastActivityKey) {
      if (!runtime.paused && view.kind === 'activity' && view.activity && view.activity.id !== 'manual' && isFreshTransition(this.lastActivityKey, currentKey, now, view.startAt, suppress)) {
        events.push({ type: 'transition', name: view.activity.name, nextName: view.next?.name ?? '' })
      }
      this.lastActivityKey = currentKey
    }

    if (view.activity && view.endAt !== null && view.startAt !== null && !runtime.paused) {
      const remaining = view.endAt - now
      const warningKey = `${currentKey}:warning`
      // Only blocks longer than five minutes get a heads-up, and a missed window (sleep, restart) is consumed silently.
      if (remaining <= 5 * MINUTE && view.endAt - view.startAt > 5 * MINUTE && this.lastWarningKey !== warningKey) {
        this.lastWarningKey = warningKey
        if (input.warningsEnabled && !suppress && remaining > 4 * MINUTE) events.push({ type: 'warning', name: view.activity.name, nextName: view.next?.name ?? '' })
      }
    }
    return { events, dayChanged, manualExpired, view }
  }
}
