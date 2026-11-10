import { DisplayInfo, fitBoundsToDisplays, isRect, Rect } from './bounds'
import type { RestartBudget } from './lifecycle'
import type { Logger } from './logger'

/** The subset of BrowserWindow the controller needs. Keeping it small makes the whole flow testable with a fake window. */
export type WidgetWindow = {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  restore(): void
  showInactive(): void
  hide(): void
  moveTop(): void
  setAlwaysOnTop(flag: boolean, level?: 'normal' | 'floating' | 'screen-saver'): void
  isAlwaysOnTop(): boolean
  setBounds(bounds: Rect): void
  getBounds(): Rect
  setOpacity(opacity: number): void
  getOpacity(): number
  setIgnoreMouseEvents(ignore: boolean): void
  destroy(): void
  webContents: {
    isLoading(): boolean
    isCrashed(): boolean
    reload(): void
    getURL(): string
    once(event: 'did-finish-load', listener: () => void): unknown
    removeListener(event: 'did-finish-load', listener: () => void): unknown
  }
}

export type WidgetDeps = {
  getWindow(): WidgetWindow | null
  /** Creates (and registers) a brand new widget window. The controller destroys broken ones itself. */
  createWindow(): WidgetWindow
  displays(): DisplayInfo[]
  /** Display under the mouse pointer: where the user is looking right now. */
  activeDisplay(): DisplayInfo
  /** Size (and preferred position) the widget should have. */
  desiredBounds(): Rect
  preferences(): { alwaysOnTop: boolean; opacity: number }
  persistVisible(visible: boolean): void
  notifyFailure(message: string): void
  logger: Logger
  budget: RestartBudget
  sleep?: (ms: number) => Promise<void>
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  loadTimeoutMs?: number
  /** How long the window is held above all others after an explicit request. */
  pulseMs?: number
}

export type RevealOptions = {
  /** Briefly float above every window so the user sees it even when "always on top" is off. */
  pulse?: boolean
  /** Persist visible=true (user intent). Automatic healing passes false. */
  remember?: boolean
}

export type RevealResult = { ok: boolean; reason?: string; recreated: boolean; steps: string[] }

const MIN_OPACITY = 0.3

function describe(window: WidgetWindow | null): string {
  if (!window) return 'window=null'
  if (window.isDestroyed()) return 'window=destroyed'
  try {
    const b = window.getBounds()
    return `visible=${window.isVisible()} minimized=${window.isMinimized()} bounds=${b.x},${b.y} ${b.width}x${b.height} opacity=${window.getOpacity()} onTop=${window.isAlwaysOnTop()} loading=${window.webContents.isLoading()} crashed=${window.webContents.isCrashed()} url=${window.webContents.getURL().split('?')[1] ? 'widget' : window.webContents.getURL() ? 'page' : 'none'}`
  } catch (error) { return `window=unreadable (${error instanceof Error ? error.message : String(error)})` }
}

/**
 * Makes "show the widget" dependable. A request never silently does nothing: it (re)creates the window if needed, waits for a usable
 * renderer, restores opacity and mouse handling, moves the widget onto a visible display, shows it, lifts it above other windows,
 * and verifies the outcome - recreating the window once if verification fails. Concurrent requests share one run, and all work is
 * bounded by a restart budget so a broken environment cannot cause an endless recreate loop.
 */
export class WidgetController {
  private inflight: Promise<RevealResult> | null = null
  private pulseTimer: unknown
  private requests = 0
  private readonly sleep: (ms: number) => Promise<void>
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: WidgetDeps) {
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.setTimer = deps.setTimer ?? ((callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle })
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout))
  }

  get requestCount() { return this.requests }

  reveal(reason: string, options: RevealOptions = {}): Promise<RevealResult> {
    this.requests++
    if (this.inflight) {
      this.deps.logger.info(`Widget: request "${reason}" joined the one already in progress`)
      return this.inflight
    }
    const run = this.run(reason, options).finally(() => { this.inflight = null })
    this.inflight = run
    return run
  }

  hide(reason: string) {
    const window = this.deps.getWindow()
    this.deps.logger.info(`Widget: hide requested (${reason}); ${describe(window)}`)
    this.deps.persistVisible(false)
    this.cancelPulse()
    if (window && !window.isDestroyed()) window.hide()
  }

  /** Window rectangle that is guaranteed to be on a connected display, preferring where the widget already is. */
  targetBounds(current: Rect | undefined): Rect {
    const desired = this.deps.desiredBounds()
    const size = { width: desired.width, height: desired.height }
    const displays = this.deps.displays()
    const base = isRect(current) ? { ...current, ...size } : desired
    const onScreen = displays.some(display => overlap(base, display.workArea) >= base.width * base.height * 0.5)
    const home = onScreen ? displays.find(display => overlap(base, display.workArea) > 0) ?? this.deps.activeDisplay() : this.deps.activeDisplay()
    // Off every display (unplugged monitor, bad data): start from the default spot on the active display.
    const start = onScreen ? base : { x: home.workArea.x + home.workArea.width - size.width - 24, y: home.workArea.y + 40, ...size }
    return fitBoundsToDisplays(start, displays.length ? displays : [home], home, size)
  }

  private async run(reason: string, options: RevealOptions): Promise<RevealResult> {
    const { logger } = this.deps
    const steps: string[] = []
    let recreated = false
    logger.info(`Widget: show requested (${reason}, pulse=${options.pulse !== false}); ${describe(this.deps.getWindow())}`)
    for (let attempt = 1; attempt <= 2; attempt++) {
      let window = this.deps.getWindow()
      if (!window || window.isDestroyed() || (attempt === 2 && !window.isDestroyed())) {
        if (window && !window.isDestroyed()) { steps.push('destroyed broken window'); try { window.destroy() } catch { /* already gone */ } }
        if (!this.deps.budget.tryConsume()) return this.fail(reason, 'too many widget recreations in a short time', steps, recreated)
        try { window = this.deps.createWindow() } catch (error) { return this.fail(reason, `could not create the window: ${error instanceof Error ? error.message : String(error)}`, steps, recreated) }
        steps.push('created window'); recreated = true
      }
      try {
        const ready = await this.waitUntilUsable(window, steps)
        if (!ready) { steps.push(`attempt ${attempt}: renderer never became usable`); continue }
        this.restore(window, steps)
        window.setBounds(this.targetBounds(safeBounds(window)))
        steps.push('bounds fitted')
        window.showInactive()
        if (options.pulse !== false) this.raise(window)
        await this.sleep(120)
        const problem = this.verify(window)
        if (!problem) {
          if (options.remember !== false) this.deps.persistVisible(true)
          logger.info(`Widget: shown OK (${reason}) after ${steps.join(' > ') || 'no repairs needed'}; ${describe(window)}`)
          return { ok: true, recreated, steps }
        }
        steps.push(`attempt ${attempt}: ${problem}`)
      } catch (error) { steps.push(`attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    return this.fail(reason, steps[steps.length - 1] ?? 'unknown', steps, recreated)
  }

  /** Waits for a loaded, uncrashed renderer. A crashed or stuck page is replaced by the caller on the next attempt. */
  private async waitUntilUsable(window: WidgetWindow, steps: string[]): Promise<boolean> {
    if (window.webContents.isCrashed()) { steps.push('renderer crashed'); return false }
    if (!window.webContents.isLoading()) return true
    steps.push('waiting for the page to load')
    const timeout = this.deps.loadTimeoutMs ?? 10_000
    return new Promise<boolean>(resolve => {
      let settled = false
      const done = (value: boolean) => { if (settled) return; settled = true; this.clearTimer(timer); window.webContents.removeListener('did-finish-load', onLoad); resolve(value) }
      const onLoad = () => done(true)
      const timer = this.setTimer(() => done(false), timeout)
      window.webContents.once('did-finish-load', onLoad)
      if (!window.webContents.isLoading()) done(true)
    })
  }

  private restore(window: WidgetWindow, steps: string[]) {
    if (window.isMinimized()) { window.restore(); steps.push('restored from minimized') }
    const { opacity } = this.deps.preferences()
    if (window.getOpacity() < MIN_OPACITY) steps.push('opacity was nearly transparent')
    window.setOpacity(opacity)
    window.setIgnoreMouseEvents(false)
  }

  /**
   * Windows will not let a background app take the foreground, and the widget has no taskbar button, so a widget that is "visible"
   * but covered looks like nothing happened. Hold it above every window for a moment, then return to the user's preference.
   */
  private raise(window: WidgetWindow) {
    this.cancelPulse()
    window.setAlwaysOnTop(true, 'screen-saver')
    window.moveTop()
    const { alwaysOnTop } = this.deps.preferences()
    if (alwaysOnTop) return
    this.pulseTimer = this.setTimer(() => {
      this.pulseTimer = undefined
      if (!window.isDestroyed()) { window.setAlwaysOnTop(this.deps.preferences().alwaysOnTop); window.moveTop() }
    }, this.deps.pulseMs ?? 2500)
  }

  private cancelPulse() { if (this.pulseTimer) { this.clearTimer(this.pulseTimer); this.pulseTimer = undefined } }

  private verify(window: WidgetWindow): string | null {
    if (window.isDestroyed()) return 'window was destroyed'
    if (!window.isVisible()) return 'window is not visible after show'
    if (window.isMinimized()) return 'window is still minimized'
    if (window.getOpacity() < MIN_OPACITY) return 'window is transparent'
    const bounds = window.getBounds()
    if (!this.deps.displays().some(display => overlap(bounds, display.workArea) >= bounds.width * bounds.height * 0.5)) return 'window is not on any display'
    return null
  }

  private fail(reason: string, why: string, steps: string[], recreated: boolean): RevealResult {
    const message = `Widget could not be shown (${reason}): ${why}`
    this.deps.logger.error(`${message}; steps: ${steps.join(' > ')}; ${describe(this.deps.getWindow())}`)
    this.deps.notifyFailure('Não foi possível exibir o widget. Use “Recarregar janelas” no menu da bandeja ou veja os logs.')
    return { ok: false, reason: why, recreated, steps }
  }
}

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

function safeBounds(window: WidgetWindow): Rect | undefined {
  try { return window.getBounds() } catch { return undefined }
}
