import { describe, expect, it } from 'vitest'
import { DEFAULT_RUNTIME, DEFAULT_SCHEDULE } from '../../electron/shared'
import { getScheduleView } from './schedule'
import { isFreshTransition, pauseRuntime, resumeRuntime } from './runtime'

const monday = (hour: number, minute: number, second = 0) => new Date(2026, 9, 26, hour, minute, second).getTime()

describe('controles de foco e notificações', () => {
  it('pausa com o tempo restante e retoma a mesma sessão mesmo após o limite agendado', () => {
    const before = getScheduleView(monday(9, 44), DEFAULT_SCHEDULE)
    const paused = pauseRuntime(DEFAULT_RUNTIME, before, monday(9, 44))
    expect(paused.paused).toBe(true)
    expect(paused.frozenRemainingMs).toBe(60_000)
    const resumed = resumeRuntime(paused, monday(9, 50))
    expect(resumed.paused).toBe(false)
    expect(resumed.manual).toEqual({ name: 'Projetos em andamento', endAt: monday(9, 51) })
  })

  it('não reanuncia um mesmo bloco ao processar o instante mais de uma vez', () => {
    const boundary = monday(9, 45)
    const view = getScheduleView(boundary, DEFAULT_SCHEDULE)
    expect(isFreshTransition('2026-9-26:projetos-manha-1', '2026-9-26:dsa', boundary, view.startAt, false)).toBe(true)
    expect(isFreshTransition('2026-9-26:dsa', '2026-9-26:dsa', boundary, view.startAt, false)).toBe(false)
  })

  it('suprime avisos recuperados após suspensão ou reinicialização', () => {
    const boundary = monday(9, 45)
    const view = getScheduleView(boundary, DEFAULT_SCHEDULE)
    expect(isFreshTransition('antiga', 'atual', boundary, view.startAt, true)).toBe(false)
    expect(isFreshTransition('antiga', 'atual', boundary + 120_000, view.startAt, false)).toBe(false)
  })
})
