import type { Logger } from './logger'
import { nullLogger } from './logger'

/** Tracks whether the user (or the OS) really wants the process to end. */
export class QuitState {
  private quitting = false
  request() { this.quitting = true }
  get isQuitting() { return this.quitting }
}

/** Allows at most `max` attempts inside a sliding window; used to stop restart loops. */
export class RestartBudget {
  private attempts: number[] = []
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  tryConsume(): boolean {
    const now = this.now()
    this.attempts = this.attempts.filter(time => now - time < this.windowMs)
    if (this.attempts.length >= this.max) return false
    this.attempts.push(now)
    return true
  }
  get used() { const now = this.now(); return this.attempts.filter(time => now - time < this.windowMs).length }
  /** Exponential delay: 1 s, 2 s, 4 s … capped at 8 s. */
  backoffMs(): number { return Math.min(8000, 1000 * 2 ** Math.max(0, this.used - 1)) }
}

type Listener = (...args: any[]) => void
export type ClosableWindow = { on(event: string, listener: Listener): unknown; hide(): void }

/**
 * Closing a window sends it to the tray. The real close only goes through once an intentional
 * quit (tray menu, installer, OS session end) was requested.
 */
export function attachCloseToTray(window: ClosableWindow, quit: QuitState, onHidden?: () => void) {
  window.on('close', (event: { preventDefault(): void }) => {
    if (quit.isQuitting) return
    event.preventDefault()
    window.hide()
    onHidden?.()
  })
  window.on('session-end', () => quit.request())
}

export type WebContentsLike = {
  on(event: string, listener: Listener): unknown
  reload(): void
  isDestroyed(): boolean
  forcefullyCrashRenderer?(): void
}

export type RecoveryOptions = {
  name: string
  contents: WebContentsLike
  budget: RestartBudget
  quit: QuitState
  logger?: Logger
  /** Called when the budget is exhausted so the caller can show an error state with a manual retry. */
  onGiveUp?: (reason: string) => void
  /** Called after an automatic recovery was scheduled. */
  onRecovering?: (reason: string) => void
  hangTimeoutMs?: number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Bounded recovery for renderer crashes, hangs and failed loads. Returns a manual `retry`
 * and a `dispose`. Never reloads after an intentional quit and never loops forever.
 */
export function attachRendererRecovery(options: RecoveryOptions) {
  const { name, contents, budget, quit, onGiveUp, onRecovering } = options
  const logger = options.logger ?? nullLogger
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout))
  const hangTimeout = options.hangTimeoutMs ?? 10_000
  let hangHandle: unknown
  let retryHandle: unknown
  let hung = false

  const recover = (reason: string) => {
    if (quit.isQuitting) return
    if (!budget.tryConsume()) {
      logger.error(`${name}: recovery budget exhausted, giving up (${reason})`)
      onGiveUp?.(reason)
      return
    }
    const delay = budget.backoffMs()
    logger.warn(`${name}: recovering in ${delay} ms (${reason})`)
    onRecovering?.(reason)
    if (retryHandle) clearTimer(retryHandle)
    retryHandle = setTimer(() => {
      retryHandle = undefined
      if (quit.isQuitting || contents.isDestroyed()) return
      try { contents.reload() } catch (error) { logger.error(`${name}: reload failed`, error) }
    }, delay)
  }

  contents.on('render-process-gone', (_event: unknown, details: { reason: string; exitCode?: number }) => {
    if (details.reason === 'clean-exit') return
    logger.error(`${name}: renderer process gone (${details.reason}, exit ${details.exitCode ?? '?'})`)
    recover(`renderer ${details.reason}`)
  })
  contents.on('did-fail-load', (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => {
    if (!isMainFrame || code === -3 /* aborted by a newer navigation */) return
    logger.error(`${name}: failed to load ${url} (${code} ${description})`)
    recover(`load failed ${code}`)
  })
  contents.on('unresponsive', () => {
    if (hangHandle || quit.isQuitting) return
    hung = true
    logger.warn(`${name}: renderer is unresponsive`)
    hangHandle = setTimer(() => {
      hangHandle = undefined
      if (!hung || contents.isDestroyed()) return
      logger.error(`${name}: still unresponsive after ${hangTimeout} ms, restarting the renderer`)
      try {
        // Killing the process re-enters the render-process-gone path, which applies the budget.
        if (contents.forcefullyCrashRenderer) contents.forcefullyCrashRenderer(); else recover('unresponsive')
      } catch (error) { logger.error(`${name}: could not restart the renderer`, error) }
    }, hangTimeout)
  })
  contents.on('responsive', () => {
    hung = false
    if (hangHandle) { clearTimer(hangHandle); hangHandle = undefined }
  })

  return {
    retry: () => { if (!contents.isDestroyed()) contents.reload() },
    dispose: () => { if (hangHandle) clearTimer(hangHandle); if (retryHandle) clearTimer(retryHandle) },
  }
}
