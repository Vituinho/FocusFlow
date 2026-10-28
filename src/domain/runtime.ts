import { RuntimeState, ScheduleView } from '../../electron/shared'

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
    manual: { name: runtime.pausedActivityName ?? 'Sessão de foco', endAt: now + Math.max(0, runtime.frozenRemainingMs ?? 0) },
    frozenRemainingMs: undefined,
    pausedActivityName: undefined,
  }
}

export function isFreshTransition(previousKey: string, currentKey: string, now: number, startAt: number | null, suppressed: boolean): boolean {
  return !suppressed && previousKey !== currentKey && startAt !== null && now >= startAt && now - startAt < 70_000
}
