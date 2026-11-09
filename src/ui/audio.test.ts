import { describe, expect, it, vi } from 'vitest'
import { AudioContextLike, createChimePlayer } from './audio'

function fakeContext(initial = 'running') {
  const context = {
    state: initial, currentTime: 1, destination: {},
    resume: vi.fn(async () => { context.state = 'running' }),
    close: vi.fn(async () => { context.state = 'closed' }),
    createOscillator: vi.fn(() => ({ type: '', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() })),
    createGain: vi.fn(() => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() })),
  }
  return context as AudioContextLike & typeof context
}

const manualTimers = () => {
  const pending: { callback: () => void; handle: number }[] = []
  let next = 1
  return {
    timers: { set: (callback: () => void) => { const handle = next++; pending.push({ callback, handle }); return handle }, clear: (handle: unknown) => { const index = pending.findIndex(item => item.handle === handle); if (index >= 0) pending.splice(index, 1) } },
    fire: () => pending.splice(0).forEach(item => item.callback()),
    count: () => pending.length,
  }
}

describe('chime player lifecycle', () => {
  it('plays repeated chimes on one context instead of closing it after the first (previous bug)', async () => {
    const context = fakeContext()
    const factory = vi.fn(() => context)
    const clock = manualTimers()
    const player = createChimePlayer(factory, 30_000, clock.timers)
    expect(await player.play()).toBe(true)
    expect(await player.play()).toBe(true)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(context.createOscillator).toHaveBeenCalledTimes(2)
    expect(context.close).not.toHaveBeenCalled()
    expect(clock.count()).toBe(1) // a single rolling idle timer
  })

  it('releases the audio device after the idle period and transparently creates a new context', async () => {
    const first = fakeContext(), second = fakeContext()
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const clock = manualTimers()
    const player = createChimePlayer(factory, 30_000, clock.timers)
    await player.play()
    clock.fire()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(player.isOpen).toBe(false)
    expect(await player.play()).toBe(true)
    expect(second.createOscillator).toHaveBeenCalledTimes(1)
  })

  it('resumes a suspended context and recovers from a context that was closed externally', async () => {
    const suspended = fakeContext('suspended')
    const player = createChimePlayer(() => suspended, 30_000, manualTimers().timers)
    await player.play()
    expect(suspended.resume).toHaveBeenCalled()
    suspended.state = 'closed'
    const replacement = fakeContext()
    const again = createChimePlayer(vi.fn().mockReturnValueOnce(suspended).mockReturnValueOnce(replacement), 30_000, manualTimers().timers)
    await again.play()
    suspended.state = 'closed'
    await again.play()
    expect(replacement.createOscillator).toHaveBeenCalled()
  })

  it('swallows audio failures and starts clean next time; dispose is idempotent', async () => {
    const broken = fakeContext()
    broken.createOscillator.mockImplementation(() => { throw new Error('no device') })
    const good = fakeContext()
    const factory = vi.fn().mockReturnValueOnce(broken).mockReturnValueOnce(good)
    const player = createChimePlayer(factory, 30_000, manualTimers().timers)
    expect(await player.play()).toBe(false)
    expect(await player.play()).toBe(true)
    player.dispose(); player.dispose()
    expect(good.close).toHaveBeenCalledTimes(1)
  })
})
