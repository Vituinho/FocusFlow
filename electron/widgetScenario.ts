import { BrowserWindow, desktopCapturer, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings } from './shared'

export type WidgetScenarioActions = {
  reveal(reason: string): Promise<{ ok: boolean; reason?: string; recreated: boolean; steps: string[] }>
  hideWidget(): void
  openDashboard(): void
  hideDashboard(): void
  setSettings(patch: Partial<AppSettings>): void
  heal(reason: string): void
  windows(): { dashboard: BrowserWindow | null; widget: BrowserWindow | null }
  trayMenuClick(pattern: RegExp): boolean
}

export type StepResult = { name: string; ok: boolean; detail?: string }

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const PANEL = { r: 23, g: 27, b: 32 } // .widget-shell background in the dark theme

/**
 * What the USER would see: crops the real screen contents under the widget (from the compositor, so windows stacked above it count)
 * and measures how much of it is the widget's panel colour. Only this crop is ever inspected or written; nothing else of the screen.
 */
export async function widgetOnScreen(window: BrowserWindow, shotsDir?: string, name?: string): Promise<{ fraction: number; content: number; detail: string }> {
  const bounds = window.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const scale = display.scaleFactor
  const size = { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const source = sources.find(item => item.display_id === String(display.id)) ?? sources[0]
  if (!source) return { fraction: 0, content: 0, detail: 'no screen source' }
  const thumb = source.thumbnail.getSize()
  const ratio = thumb.width / display.bounds.width
  const rect = {
    x: Math.max(0, Math.round((bounds.x - display.bounds.x) * ratio)), y: Math.max(0, Math.round((bounds.y - display.bounds.y) * ratio)),
    width: Math.round(bounds.width * ratio), height: Math.round(bounds.height * ratio),
  }
  rect.width = Math.max(1, Math.min(rect.width, thumb.width - rect.x)); rect.height = Math.max(1, Math.min(rect.height, thumb.height - rect.y))
  const crop = source.thumbnail.crop(rect)
  const pixels = crop.toBitmap()
  let close = 0, total = 0, bright = 0
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    total++
    const db = pixels[index] - PANEL.b, dg = pixels[index + 1] - PANEL.g, dr = pixels[index + 2] - PANEL.r
    if (dr * dr + dg * dg + db * db <= 14 * 14) close++
    else if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 3 * 150) bright++
  }
  if (shotsDir && name) { fs.mkdirSync(shotsDir, { recursive: true }); fs.writeFileSync(path.join(shotsDir, `${name}.png`), crop.toPNG()) }
  return { fraction: total ? close / total : 0, content: total ? bright / total : 0, detail: `crop ${rect.width}x${rect.height} at ${rect.x},${rect.y} of ${thumb.width}x${thumb.height}` }
}

/** A solid-colour, non-topmost window over the widget: the "widget is open but buried under other windows" situation. */
function coverFor(widget: BrowserWindow): BrowserWindow {
  const display = screen.getDisplayMatching(widget.getBounds())
  const cover = new BrowserWindow({ ...display.workArea, frame: false, show: false, alwaysOnTop: false, skipTaskbar: true, backgroundColor: '#ff00ff', focusable: true })
  void cover.loadURL('data:text/html,<body style="background:%23ff00ff;margin:0"></body>')
  cover.show()
  cover.moveTop()
  return cover
}

/**
 * End-to-end widget behaviour inside the real app (packaged or not): every step checks what is really on screen, not just window flags.
 */
export async function runWidgetScenario(actions: WidgetScenarioActions, shotsDir?: string): Promise<{ ok: boolean; steps: StepResult[] }> {
  const steps: StepResult[] = []
  const record = (name: string, ok: boolean, detail = '') => { steps.push({ name, ok, detail }) }
  const live = () => actions.windows().widget
  const seen = async (label: string, minimum = 0.3) => {
    const widget = live()
    if (!widget || widget.isDestroyed()) return { ok: false, detail: 'no widget window', fraction: 0, content: 0 }
    const { fraction, content, detail } = await widgetOnScreen(widget, shotsDir, label)
    // Visible = the panel colour fills the crop AND there is bright content (text/icons); a blank or crashed window has only the background.
    return { ok: fraction >= minimum && (minimum === 0 || content >= 0.004), detail: `${(fraction * 100).toFixed(0)}% panel, ${(content * 100).toFixed(1)}% content pixels; ${detail}`, fraction, content }
  }
  const eventually = async (label: string, minimum = 0.3, timeoutMs = 20_000) => {
    const end = Date.now() + timeoutMs
    let last = await seen(label, minimum)
    while (!last.ok && Date.now() < end) { await wait(700); last = await seen(label, minimum) }
    return last
  }

  // Startup: the widget must already be on screen with no click at all.
  let seenNow = await eventually('00-startup')
  record('startup: widget is on screen without any click', seenNow.ok && !!live()?.isVisible(), seenNow.detail)

  actions.setSettings({ theme: 'dark', transparency: false, alwaysOnTop: false, compactWidget: false })
  let result = await actions.reveal('scenario-baseline')
  await wait(600)
  seenNow = await eventually('01-baseline')
  record('baseline: widget is visible on screen', result.ok && seenNow.ok, seenNow.detail)

  actions.openDashboard(); await wait(1200)
  const { dashboard } = actions.windows()
  record('dashboard and widget are both visible', !!dashboard?.isVisible() && !!live()?.isVisible())

  // The user's real situation: always-on-top off and another window sitting on the widget. Wait out the temporary top-most pulse of the
  // previous reveal first, otherwise the widget is legitimately still floating above the cover (a race in this check, not in the app).
  await wait(3200)
  const widgetBefore = live()!
  const cover = coverFor(widgetBefore)
  await wait(900)
  seenNow = await seen('02-covered', 0)
  // Hidden = none of the widget's text/icons are on screen. (Any covering window counts, including a dark third-party one: the panel colour alone
  // is not a reliable signal because dark applications have nearly the same background.)
  record('oracle sanity: a covering window really hides the widget', seenNow.content < 0.004, seenNow.detail)
  result = await actions.reveal('scenario-click-while-covered')
  await wait(500)
  seenNow = await eventually('03-after-click')
  record('"Mostrar widget" brings a covered widget to the front', result.ok && seenNow.ok, seenNow.detail)
  await wait(3200) // past the temporary top-most pulse
  seenNow = await seen('04-after-pulse')
  record('widget stays in front after the temporary pulse ends', seenNow.ok, seenNow.detail)
  record('user preference restored (always-on-top stays off)', live()?.isAlwaysOnTop() === false)
  cover.destroy()

  actions.hideWidget(); await wait(500)
  record('hide hides the widget', live()?.isVisible() === false)
  const burst = await Promise.all([1, 2, 3, 4, 5].map(index => actions.reveal(`scenario-burst-${index}`)))
  await wait(500)
  seenNow = await eventually('05-after-burst')
  record('five simultaneous clicks produce one visible widget', burst.every(item => item.ok) && seenNow.ok && actions.windows().widget === widgetBefore, seenNow.detail)
  for (let index = 0; index < 3; index++) await actions.reveal('scenario-repeat')
  record('repeated clicks are idempotent (same window, still visible)', actions.windows().widget === widgetBefore && !!live()?.isVisible())

  // The tray menu: same handlers a user triggers from the notification area.
  record('tray menu offers Ocultar widget while visible', actions.trayMenuClick(/^Ocultar widget$/))
  await wait(500)
  record('tray "Ocultar widget" hides the widget', live()?.isVisible() === false)
  record('tray menu then offers Mostrar widget', actions.trayMenuClick(/^Mostrar widget$/))
  await wait(900)
  seenNow = await eventually('05b-tray-show')
  record('tray "Mostrar widget" shows it on screen', seenNow.ok, seenNow.detail)
  const trayCover = coverFor(live()!)
  await wait(900)
  record('tray menu offers Trazer widget para frente while covered', actions.trayMenuClick(/^Trazer widget para frente$/))
  await wait(700)
  seenNow = await eventually('05c-tray-raise')
  record('tray "Trazer widget para frente" lifts a covered widget', seenNow.ok, seenNow.detail)
  trayCover.destroy()

  live()!.destroy()
  result = await actions.reveal('scenario-after-destroy')
  seenNow = await eventually('06-after-destroy')
  record('widget is recreated after its window was destroyed', result.ok && result.recreated && seenNow.ok, seenNow.detail)

  live()!.webContents.forcefullyCrashRenderer()
  result = await actions.reveal('scenario-after-crash')
  seenNow = await eventually('07-after-crash')
  record('widget is visible and rendered after a renderer crash', result.ok && seenNow.ok, `${result.steps.join(' > ')}; ${seenNow.detail}`)

  actions.hideWidget(); await wait(300)
  live()!.setBounds({ x: 9000, y: 9000, width: 310, height: 220 })
  result = await actions.reveal('scenario-bad-bounds')
  await wait(400)
  const b = live()!.getBounds()
  const onADisplay = screen.getAllDisplays().some(display => b.x >= display.workArea.x - 2 && b.y >= display.workArea.y - 2 && b.x + b.width <= display.workArea.x + display.workArea.width + 2 && b.y + b.height <= display.workArea.y + display.workArea.height + 2)
  seenNow = await eventually('08-bad-bounds')
  record('widget off every display is moved to a visible spot', result.ok && onADisplay && seenNow.ok, `bounds ${b.x},${b.y} ${b.width}x${b.height}; ${seenNow.detail}`)

  live()!.minimize(); live()!.setOpacity(0)
  result = await actions.reveal('scenario-minimized-transparent')
  await wait(400)
  seenNow = await eventually('09-minimized')
  record('minimized, fully transparent widget is restored', result.ok && !live()!.isMinimized() && live()!.getOpacity() > 0.5 && seenNow.ok, `opacity ${live()!.getOpacity()}; ${seenNow.detail}`)

  actions.hideDashboard(); await wait(500)
  seenNow = await seen('10-dashboard-closed')
  record('closing the dashboard leaves the widget visible', seenNow.ok, seenNow.detail)

  for (const patch of [{ compactWidget: true }, { compactWidget: false }, { hardwareMonitor: false }, { hardwareMonitor: true }, { alwaysOnTop: true }, { alwaysOnTop: false }] as Partial<AppSettings>[]) {
    actions.setSettings(patch); await wait(500)
  }
  seenNow = await eventually('11-after-settings')
  record('widget survives compact / hardware / always-on-top setting changes', seenNow.ok && !!live()?.isVisible(), seenNow.detail)

  actions.heal('scenario-resume'); screen.emit('display-metrics-changed', {} as Electron.Event, screen.getPrimaryDisplay(), ['bounds'])
  await wait(1500)
  seenNow = await eventually('12-after-display-event')
  record('widget stays visible after resume / display-change handling', seenNow.ok, seenNow.detail)

  return { ok: steps.every(step => step.ok), steps }
}
