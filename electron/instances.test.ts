import { describe, expect, it, vi } from 'vitest'
import { compareVersions, findOlderInstances, offerTakeover, ProcessInfo, TakeoverDeps } from './instances'

const own = { pid: 500, exeName: 'FocusFlow.exe', version: '1.1.0' }
const proc = (overrides: Partial<ProcessInfo> = {}): ProcessInfo => ({ pid: 100, path: 'C:\\Users\\x\\AppData\\Local\\Programs\\FocusFlow\\FocusFlow.exe', version: '1.0.0.0', commandLine: '"C:\\...\\FocusFlow.exe"', ...overrides })

describe('compareVersions', () => {
  it('compares numerically, segment by segment', () => {
    expect(compareVersions('1.0.0.0', '1.1.0')).toBe(-1)
    expect(compareVersions('1.1.0.0', '1.1.0')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('', '1.0.0')).toBe(-1)
  })
})

describe('findOlderInstances', () => {
  it('finds an older main process of the same executable', () => {
    expect(findOlderInstances([proc()], own)).toHaveLength(1)
  })
  it('ignores itself, same or newer versions, helper processes and other programs', () => {
    expect(findOlderInstances([
      proc({ pid: 500 }), proc({ version: '1.1.0.0' }), proc({ version: '2.0.0' }),
      proc({ commandLine: '"FocusFlow.exe" --type=renderer --lang=pt-BR' }),
      proc({ path: 'C:\\apps\\FocusFlowTest.exe' }), proc({ path: 'C:\\apps\\notfocusflow.exe' }),
    ], own)).toEqual([])
  })
  it('matches the executable name case-insensitively', () => {
    expect(findOlderInstances([proc({ path: 'c:\\x\\focusflow.EXE' })], own)).toHaveLength(1)
  })
})

function deps(overrides: Partial<TakeoverDeps> = {}) {
  const calls: string[] = []
  const value: TakeoverDeps = {
    own, list: async () => [proc()], confirm: async () => true, kill: async pid => { calls.push(`kill:${pid}`) },
    waitForExit: async () => true, relaunch: () => { calls.push('relaunch') }, log: () => undefined, ...overrides,
  }
  return { value, calls }
}

describe('offerTakeover (old 1.0.0 instance blocking the new build)', () => {
  it('does nothing when no older instance exists (normal second launch of the same version)', async () => {
    const { value, calls } = deps({ list: async () => [proc({ version: '1.1.0' })] })
    expect(await offerTakeover(value)).toBe('none')
    expect(calls).toEqual([])
  })
  it('never closes anything when the user declines', async () => {
    const confirm = vi.fn(async () => false)
    const { value, calls } = deps({ confirm })
    expect(await offerTakeover(value)).toBe('declined')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
  })
  it('closes the older instance and relaunches after an explicit yes', async () => {
    const { value, calls } = deps()
    expect(await offerTakeover(value)).toBe('replaced')
    expect(calls).toEqual(['kill:100', 'relaunch'])
  })
  it('does not relaunch when the older instance cannot be closed or does not exit', async () => {
    const stuck = deps({ waitForExit: async () => false })
    expect(await offerTakeover(stuck.value)).toBe('failed')
    expect(stuck.calls).toEqual(['kill:100'])
    const denied = deps({ kill: async () => { throw new Error('Access is denied') } })
    expect(await offerTakeover(denied.value)).toBe('failed')
    expect(denied.calls).not.toContain('relaunch')
  })
  it('survives an empty or failed process listing', async () => {
    expect(await offerTakeover(deps({ list: async () => [] }).value)).toBe('none')
  })
})
