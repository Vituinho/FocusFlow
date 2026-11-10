import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Rect } from './bounds'
import { RestartBudget } from './lifecycle'
import { WidgetController, WidgetDeps, WidgetWindow } from './widgetController'

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1032 } }
const left = { id: 2, workArea: { x: -1600, y: 78, width: 1600, height: 852 } }

class FakeWindow implements WidgetWindow {
  visible = false; minimized = false; destroyed = false; onTop = false; opacity = 1; ignoring = false
  bounds: Rect = { x: 1600, y: 300, width: 310, height: 220 }
  loading = false; crashed = false
  /** When true, showInactive() has no effect (simulates a window the OS refuses to show). */
  refuseToShow = false
  calls: string[] = []
  private readonly events = new EventEmitter()
  webContents = {
    isLoading: () => this.loading, isCrashed: () => this.crashed, reload: () => { this.calls.push('reload') }, getURL: () => 'file:///dist/index.html?window=widget',
    once: (event: 'did-finish-load', listener: () => void) => { this.events.once(event, listener) },
    removeListener: (event: 'did-finish-load', listener: () => void) => { this.events.removeListener(event, listener) },
  }
  finishLoad() { this.loading = false; this.events.emit('did-finish-load') }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible && !this.destroyed }
  isMinimized() { return this.minimized }
  restore() { this.minimized = false; this.calls.push('restore') }
  showInactive() { this.calls.push('showInactive'); if (!this.refuseToShow) this.visible = true }
  hide() { this.visible = false; this.calls.push('hide') }
  moveTop() { this.calls.push('moveTop') }
  setAlwaysOnTop(flag: boolean) { this.onTop = flag; this.calls.push(`onTop:${flag}`) }
  isAlwaysOnTop() { return this.onTop }
  setBounds(bounds: Rect) { this.bounds = bounds; this.calls.push('setBounds') }
  getBounds() { return this.bounds }
  setOpacity(value: number) { this.opacity = value }
  getOpacity() { return this.opacity }
  setIgnoreMouseEvents(value: boolean) { this.ignoring = value }
  destroy() { this.destroyed = true; this.calls.push('destroy') }
}

function setup(options: { displays?: typeof primary[]; prefs?: { alwaysOnTop: boolean; opacity: number }; budget?: number; initial?: FakeWindow | null; loadTimeoutMs?: number } = {}) {
  const state = { window: options.initial === undefined ? new FakeWindow() : options.initial, created: [] as FakeWindow[], persisted: [] as boolean[], failures: [] as string[] }
  const timers: { callback: () => void; ms: number; id: number }[] = []
  let timerId = 0
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), recent: () => [], directory: '' }
  const deps: WidgetDeps = {
    getWindow: () => state.window,
    createWindow: () => { const window = new FakeWindow(); window.visible = false; state.window = window; state.created.push(window); return window },
    displays: () => options.displays ?? [primary],
    activeDisplay: () => (options.displays ?? [primary])[0],
    desiredBounds: () => ({ x: 1600, y: 300, width: 310, height: 220 }),
    preferences: () => options.prefs ?? { alwaysOnTop: false, opacity: 1 },
    persistVisible: visible => { state.persisted.push(visible) },
    notifyFailure: message => { state.failures.push(message) },
    logger, budget: new RestartBudget(options.budget ?? 3, 60_000),
    sleep: async () => undefined,
    setTimer: (callback, ms) => { const id = ++timerId; timers.push({ callback, ms, id }); return id },
    clearTimer: handle => { const index = timers.findIndex(timer => timer.id === handle); if (index >= 0) timers.splice(index, 1) },
    loadTimeoutMs: options.loadTimeoutMs ?? 10_000,
  }
  const controller = new WidgetController(deps)
  const fireTimers = () => timers.splice(0).forEach(timer => timer.callback())
  return { controller, state, deps, timers, fireTimers, logger }
}

describe('WidgetController.reveal', () => {
  it('shows a hidden widget, and show/hide/show cycles keep working with one window', async () => {
    const { controller, state } = setup()
    const first = state.window!
    expect((await controller.reveal('test')).ok).toBe(true)
    expect(first.isVisible()).toBe(true)
    controller.hide('test')
    expect(first.isVisible()).toBe(false)
    expect(state.persisted).toEqual([true, false])
    expect((await controller.reveal('test')).ok).toBe(true)
    expect(first.isVisible()).toBe(true)
    expect(state.created).toHaveLength(0)
    expect(state.persisted).toEqual([true, false, true])
  })

  it('lifts a widget that is "visible" but covered by other windows (the reported "does nothing" case), then restores the preference', async () => {
    const { controller, state, fireTimers, timers } = setup({ prefs: { alwaysOnTop: false, opacity: 1 } })
    const window = state.window!
    window.visible = true // already shown, just behind everything
    await controller.reveal('dashboard-button')
    expect(window.calls).toContain('moveTop')
    expect(window.onTop).toBe(true) // floating above all windows right now
    expect(timers).toHaveLength(1)
    fireTimers()
    expect(window.onTop).toBe(false) // user preference restored afterwards
  })

  it('keeps always-on-top when the user wants it and never schedules a downgrade', async () => {
    const { controller, state, timers } = setup({ prefs: { alwaysOnTop: true, opacity: 1 } })
    await controller.reveal('tray')
    expect(state.window!.onTop).toBe(true)
    expect(timers).toHaveLength(0)
  })

  it('does not lift the window for automatic healing (pulse disabled)', async () => {
    const { controller, state } = setup()
    await controller.reveal('resume', { pulse: false, remember: false })
    expect(state.window!.calls).not.toContain('moveTop')
    expect(state.persisted).toEqual([])
  })

  it('joins simultaneous clicks into one run and stays idempotent for repeated clicks', async () => {
    const { controller, state } = setup()
    const window = state.window!
    const results = await Promise.all([1, 2, 3, 4, 5].map(index => controller.reveal(`click-${index}`)))
    expect(results.every(result => result.ok)).toBe(true)
    expect(window.calls.filter(call => call === 'showInactive')).toHaveLength(1)
    for (let index = 0; index < 4; index++) expect((await controller.reveal('again')).ok).toBe(true)
    expect(state.created).toHaveLength(0)
    expect(controller.requestCount).toBe(9)
  })

  it('recreates a destroyed window exactly once and shows it', async () => {
    const { controller, state } = setup()
    state.window!.destroyed = true
    const result = await controller.reveal('test')
    expect(result).toMatchObject({ ok: true, recreated: true })
    expect(state.created).toHaveLength(1)
    expect(state.created[0].isVisible()).toBe(true)
  })

  it('creates the window when none exists (closed or never created)', async () => {
    const { controller, state } = setup({ initial: null })
    expect((await controller.reveal('startup')).ok).toBe(true)
    expect(state.created).toHaveLength(1)
  })

  it('replaces a window whose renderer crashed', async () => {
    const { controller, state } = setup()
    const broken = state.window!
    broken.crashed = true
    const result = await controller.reveal('test')
    expect(result.ok).toBe(true)
    expect(broken.destroyed).toBe(true)
    expect(state.created).toHaveLength(1)
  })

  it('shows a widget immediately while its page is still loading (a slow machine must not delay or recreate it)', async () => {
    const { controller, state } = setup()
    const window = state.window!
    window.loading = true
    const result = await controller.reveal('test')
    expect(result.ok).toBe(true)
    expect(window.isVisible()).toBe(true)
    expect(state.created).toHaveLength(0)
    expect(window.destroyed).toBe(false)
  })

  it('supervises a page that stays loading: one reload, then a user-facing message, never a recreate loop', async () => {
    const { controller, state, timers, logger } = setup({ loadTimeoutMs: 30_000 })
    const window = state.window!
    window.loading = true
    await controller.reveal('test')
    timers.find(timer => timer.ms === 30_000)!.callback()
    expect(window.calls).toContain('reload')
    expect(state.failures).toHaveLength(0)
    timers.filter(timer => timer.ms === 30_000).forEach(timer => timer.callback())
    expect(state.failures).toHaveLength(1)
    expect(logger.error).toHaveBeenCalled()
    expect(window.destroyed).toBe(false)
    expect(state.created).toHaveLength(0)
  })

  it('stops supervising once the page finishes loading', async () => {
    const { controller, state, timers } = setup()
    const window = state.window!
    window.loading = true
    await controller.reveal('test')
    window.finishLoad()
    expect(timers.filter(timer => timer.ms === 30_000)).toHaveLength(0)
    expect(window.calls).not.toContain('reload')
  })

  it('replaces a window whose renderer crashes while it is being shown', async () => {
    const { controller, state } = setup()
    const first = state.window!
    const originalShow = first.showInactive.bind(first)
    first.showInactive = () => { originalShow(); first.crashed = true }
    const result = await controller.reveal('test')
    expect(result.ok).toBe(true)
    expect(first.destroyed).toBe(true)
    expect(state.created).toHaveLength(1)
  })

  it('restores a minimized, almost transparent widget with mouse input enabled', async () => {
    const { controller, state } = setup({ prefs: { alwaysOnTop: false, opacity: 0.88 } })
    const window = state.window!
    Object.assign(window, { minimized: true, opacity: 0, ignoring: true })
    const result = await controller.reveal('test')
    expect(result.ok).toBe(true)
    expect(window.minimized).toBe(false)
    expect(window.opacity).toBe(0.88)
    expect(window.ignoring).toBe(false)
  })

  it.each([
    ['NaN coordinates', { x: Number.NaN, y: 0, width: 310, height: 220 }],
    ['far off-screen', { x: 9000, y: 9000, width: 310, height: 220 }],
    ['zero size', { x: 100, y: 100, width: 0, height: 0 }],
    ['on a monitor that was unplugged', { x: 3000, y: -500, width: 310, height: 220 }],
  ])('moves the widget back onto a connected display (%s)', async (_name, bounds) => {
    const { controller, state } = setup()
    const window = state.window!
    window.bounds = bounds as Rect
    const result = await controller.reveal('display-change')
    expect(result.ok).toBe(true)
    const b = window.getBounds()
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.y).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(1920)
    expect(b.y + b.height).toBeLessThanOrEqual(1032)
  })

  it('keeps the widget on the secondary monitor the user placed it on', async () => {
    const { controller, state } = setup({ displays: [primary, left] })
    state.window!.bounds = { x: -900, y: 200, width: 310, height: 220 }
    await controller.reveal('test')
    expect(state.window!.getBounds()).toMatchObject({ x: -900, y: 200 })
  })

  it('retries once with a fresh window when the OS refuses to show it, then reports a clear failure without looping', async () => {
    const { controller, state, deps } = setup()
    state.window!.refuseToShow = true
    const originalCreate = deps.createWindow
    deps.createWindow = () => { const window = originalCreate() as FakeWindow; window.refuseToShow = true; return window }
    const result = await controller.reveal('test')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('not visible')
    expect(state.created).toHaveLength(1) // exactly one replacement attempt
    expect(state.failures).toHaveLength(1)
    expect(state.persisted).toEqual([]) // never claims it is visible
  })

  it('bounds recreation with the restart budget across repeated failures', async () => {
    const { controller, state, deps } = setup({ budget: 2 })
    state.window!.destroyed = true
    deps.createWindow = () => { const window = new FakeWindow(); window.destroyed = true; state.created.push(window); state.window = window; return window }
    for (let index = 0; index < 6; index++) await controller.reveal('storm')
    expect(state.created.length).toBeLessThanOrEqual(2)
    expect(state.failures.length).toBeGreaterThan(0)
  })

  it('reports (and survives) a window factory that throws', async () => {
    const { controller, state, deps, logger } = setup({ initial: null })
    deps.createWindow = () => { throw new Error('GPU process crashed') }
    const result = await controller.reveal('test')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('GPU process crashed')
    expect(state.failures).toHaveLength(1)
    expect(logger.error).toHaveBeenCalled()
  })

  it('logs the request, the window state before and the outcome', async () => {
    const { controller, logger } = setup()
    await controller.reveal('dashboard-button')
    const lines = logger.info.mock.calls.map(call => String(call[0]))
    expect(lines.some(line => line.includes('show requested (dashboard-button') && line.includes('visible=false') && line.includes('bounds='))).toBe(true)
    expect(lines.some(line => line.includes('shown OK'))).toBe(true)
  })
})
