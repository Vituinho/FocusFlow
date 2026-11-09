import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachCloseToTray, attachRendererRecovery, QuitState, RestartBudget } from './lifecycle'
import { SessionSentinel } from './session'

class FakeWindow extends EventEmitter {
  hidden = false
  hide() { this.hidden = true }
  /** Mimics BrowserWindow.close(): emits a cancellable 'close' event. */
  close(): boolean {
    let prevented = false
    this.emit('close', { preventDefault: () => { prevented = true } })
    return !prevented
  }
}

class FakeContents extends EventEmitter {
  reloads = 0
  crashed = 0
  destroyed = false
  reload() { this.reloads++ }
  isDestroyed() { return this.destroyed }
  forcefullyCrashRenderer() { this.crashed++; this.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 }) }
}

describe('closing to the tray', () => {
  it('hides instead of closing, repeatedly, until an intentional quit is requested', () => {
    const window = new FakeWindow(), quit = new QuitState()
    const hidden = vi.fn()
    attachCloseToTray(window, quit, hidden)
    expect(window.close()).toBe(false)
    expect(window.hidden).toBe(true)
    expect(window.close()).toBe(false)
    expect(hidden).toHaveBeenCalledTimes(2)
    quit.request()
    expect(window.close()).toBe(true)
  })

  it('lets Windows end the session (logoff/shutdown) without blocking it', () => {
    const window = new FakeWindow(), quit = new QuitState()
    attachCloseToTray(window, quit)
    window.emit('session-end')
    expect(quit.isQuitting).toBe(true)
    expect(window.close()).toBe(true)
  })
})

describe('renderer crash recovery', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  const setup = (max = 3) => {
    const contents = new FakeContents(), quit = new QuitState()
    const budget = new RestartBudget(max, 60_000, () => Date.now())
    const onGiveUp = vi.fn(), onRecovering = vi.fn()
    attachRendererRecovery({ name: 'test', contents, budget, quit, onGiveUp, onRecovering })
    return { contents, quit, budget, onGiveUp, onRecovering }
  }
  const crash = (contents: FakeContents, reason = 'crashed') => contents.emit('render-process-gone', {}, { reason, exitCode: 1 })

  it('reloads a crashed renderer with backoff and stops after the budget is exhausted', () => {
    const { contents, onGiveUp } = setup(3)
    crash(contents); vi.advanceTimersByTime(1000); expect(contents.reloads).toBe(1)
    crash(contents); vi.advanceTimersByTime(2000); expect(contents.reloads).toBe(2)
    crash(contents); vi.advanceTimersByTime(4000); expect(contents.reloads).toBe(3)
    crash(contents); vi.advanceTimersByTime(60_000)
    expect(contents.reloads).toBe(3)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })

  it('allows recovery again once the sliding window has passed', () => {
    const { contents, onGiveUp } = setup(1)
    crash(contents); vi.advanceTimersByTime(1000)
    crash(contents); expect(onGiveUp).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(61_000)
    crash(contents); vi.advanceTimersByTime(1000)
    expect(contents.reloads).toBe(2)
  })

  it('ignores clean exits and everything after an intentional quit', () => {
    const { contents, quit, onRecovering } = setup()
    crash(contents, 'clean-exit'); vi.advanceTimersByTime(10_000)
    expect(contents.reloads).toBe(0)
    quit.request()
    crash(contents); contents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'x', true)
    vi.advanceTimersByTime(10_000)
    expect(contents.reloads).toBe(0)
    expect(onRecovering).not.toHaveBeenCalled()
  })

  it('does not reload when the page is destroyed before the delayed reload fires', () => {
    const { contents } = setup()
    crash(contents); contents.destroyed = true; vi.advanceTimersByTime(5000)
    expect(contents.reloads).toBe(0)
  })

  it('retries failed main-frame loads but ignores aborted navigations and sub-frames', () => {
    const { contents } = setup()
    contents.emit('did-fail-load', {}, -3, 'ABORTED', 'x', true)
    contents.emit('did-fail-load', {}, -105, 'ERR', 'x', false)
    vi.advanceTimersByTime(10_000)
    expect(contents.reloads).toBe(0)
    contents.emit('did-fail-load', {}, -6, 'FILE_NOT_FOUND', 'x', true)
    vi.advanceTimersByTime(1000)
    expect(contents.reloads).toBe(1)
  })

  it('restarts a renderer that stays unresponsive but not one that recovers by itself', () => {
    const { contents } = setup()
    contents.emit('unresponsive'); vi.advanceTimersByTime(5000); contents.emit('responsive'); vi.advanceTimersByTime(20_000)
    expect(contents.crashed).toBe(0)
    contents.emit('unresponsive'); vi.advanceTimersByTime(10_000)
    expect(contents.crashed).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(contents.reloads).toBe(1)
  })
})

describe('RestartBudget', () => {
  it('computes capped exponential backoff', () => {
    let now = 0
    const budget = new RestartBudget(10, 1_000_000, () => now)
    const delays: number[] = []
    for (let index = 0; index < 6; index++) { budget.tryConsume(); delays.push(budget.backoffMs()); now += 10 }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000])
  })
})

describe('SessionSentinel', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusflow-session-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('reports an unexpected end only when the previous session did not exit cleanly', () => {
    const file = path.join(dir, 'session.json')
    expect(new SessionSentinel(file).begin(1)).toEqual({ previousCrashed: false })
    const crashed = new SessionSentinel(file, () => 5).begin(2)
    expect(crashed.previousCrashed).toBe(true)
    const clean = new SessionSentinel(file); clean.begin(3); clean.end()
    expect(new SessionSentinel(file).begin(4).previousCrashed).toBe(false)
  })

  it('bounds self-relaunches and survives a corrupt file', () => {
    const file = path.join(dir, 'session.json')
    let now = 1_000
    const sentinel = new SessionSentinel(file, () => now)
    sentinel.begin(1)
    for (let index = 0; index < 3; index++) { expect(sentinel.canRelaunch()).toBe(true); sentinel.recordRelaunch(); now += 1000 }
    expect(sentinel.canRelaunch()).toBe(false)
    now += 11 * 60_000
    expect(sentinel.canRelaunch()).toBe(true)
    fs.writeFileSync(file, '{not json')
    expect(new SessionSentinel(file).begin(9)).toEqual({ previousCrashed: false })
  })
})
