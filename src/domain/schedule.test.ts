import { describe, expect, it } from 'vitest'
import { DEFAULT_SCHEDULE } from '../../electron/shared'
import { getScheduleView, progressPercent, remainingMs, validateSchedule } from './schedule'

function localDate(day: number, hour: number, minute = 0, second = 0) {
  return new Date(2026, 9, day, hour, minute, second).getTime()
}

describe('agenda FocusFlow', () => {
  it('seleciona atividades pelos horários locais e cruza blocos corretamente', () => {
    expect(getScheduleView(localDate(26, 8, 0), DEFAULT_SCHEDULE).activity?.id).toBe('planejamento')
    expect(getScheduleView(localDate(26, 9, 45), DEFAULT_SCHEDULE).activity?.id).toBe('dsa')
    expect(getScheduleView(localDate(26, 10, 25), DEFAULT_SCHEDULE).activity?.id).toBe('projetos-manha-2')
    expect(getScheduleView(localDate(26, 17, 59), DEFAULT_SCHEDULE).activity?.id).toBe('encerramento')
  })

  it('trata almoço e café como blocos agendados', () => {
    expect(getScheduleView(localDate(26, 12, 30), DEFAULT_SCHEDULE).activity?.id).toBe('almoco')
    expect(getScheduleView(localDate(26, 15, 20), DEFAULT_SCHEDULE).activity?.id).toBe('cafe')
  })

  it('mostra descanso nos fins de semana e encerramento após o último bloco', () => {
    expect(getScheduleView(localDate(24, 10), DEFAULT_SCHEDULE).kind).toBe('rest')
    expect(getScheduleView(localDate(26, 18), DEFAULT_SCHEDULE).kind).toBe('finished')
  })

  it('mostra a próxima atividade antes do início e em intervalos personalizados', () => {
    const before = getScheduleView(localDate(26, 7, 30), DEFAULT_SCHEDULE)
    expect(before.kind).toBe('before')
    expect(before.next?.id).toBe('planejamento')
    const custom = [DEFAULT_SCHEDULE[0], { ...DEFAULT_SCHEDULE[1], start: '08:30' }]
    const gap = getScheduleView(localDate(26, 8, 20), custom)
    expect(gap.kind).toBe('before')
    expect(gap.activity).toBeNull()
    expect(gap.next?.id).toBe('projetos-manha-1')
  })

  it('calcula restante e progresso a partir do relógio real', () => {
    const view = getScheduleView(localDate(26, 8, 7, 30), DEFAULT_SCHEDULE)
    expect(remainingMs(view.endAt, localDate(26, 8, 7, 30))).toBe(7.5 * 60_000)
    expect(progressPercent(view.startAt, view.endAt, localDate(26, 8, 7, 30))).toBe(50)
  })

  it('valida horários, nomes e sobreposições antes de salvar a agenda', () => {
    expect(validateSchedule(DEFAULT_SCHEDULE)).toBeNull()
    expect(validateSchedule([{ ...DEFAULT_SCHEDULE[0], end: '07:00' }])).toContain('Horário inválido')
    expect(validateSchedule([DEFAULT_SCHEDULE[0], { ...DEFAULT_SCHEDULE[1], start: '08:10' }])).toContain('se sobrepõe')
  })
})
