import type { RuntimeCommand, RuntimeState, ScheduleView } from '../../electron/shared'

export function pauseRuntime(runtime: RuntimeState, view: ScheduleView, now: number): RuntimeState {
  if (runtime.paused) return runtime
  return {
    ...runtime,
    paused: true,
    pausedAt: now,
    frozenRemainingMs: Math.max(0, (view.endAt ?? now) - now),
    pausedActivityName: view.activity?.name ?? 'Sessão de foco',
  }
}

export function resumeRuntime(runtime: RuntimeState, now: number): RuntimeState {
  if (!runtime.paused) return runtime
  return {
    ...runtime,
    paused: false,
    pausedAt: undefined,
    manual: { name: runtime.pausedActivityName ?? 'Sessão de foco', endAt: now + Math.max(0, runtime.frozenRemainingMs ?? 0), startedAt: now },
    frozenRemainingMs: undefined,
    pausedActivityName: undefined,
  }
}

export function isFreshTransition(previousKey: string, currentKey: string, now: number, startAt: number | null, suppressed: boolean): boolean {
  return !suppressed && previousKey !== currentKey && startAt !== null && now >= startAt && now - startAt < 70_000
}

const cleared = (runtime: RuntimeState): RuntimeState => ({ ...runtime, paused: false, pausedAt: undefined, frozenRemainingMs: undefined, pausedActivityName: undefined })

/** Pure reducer for user commands. `view` is the effective view (manual sessions included) at `now`. */
export function applyRuntimeCommand(runtime: RuntimeState, command: RuntimeCommand, view: ScheduleView, now: number): RuntimeState {
  switch (command.type) {
    case 'pause': return pauseRuntime(runtime, view, now)
    case 'resume': return resumeRuntime(runtime, now)
    case 'manual': return { ...cleared(runtime), manual: { name: command.name.trim(), endAt: now + command.minutes * 60_000, startedAt: now } }
    case 'extend':
      if (!view.activity) return runtime
      return { ...runtime, paused: false, manual: { name: view.activity.name, endAt: (view.endAt ?? now) + command.minutes * 60_000, startedAt: view.startAt ?? now } }
    case 'skip': {
      const base = { ...cleared(runtime), manual: undefined }
      if (!view.next) return base
      const [hours, minutes] = view.next.end.split(':').map(Number)
      const endAt = new Date(now)
      endAt.setHours(hours, minutes, 0, 0)
      if (endAt.getTime() <= now) endAt.setDate(endAt.getDate() + 1)
      return { ...base, manual: { name: view.next.name, endAt: endAt.getTime(), startedAt: now } }
    }
    case 'automatic': return { ...cleared(runtime), manual: undefined }
    case 'focus-mode': return { ...runtime, focusMode: command.enabled }
  }
}
