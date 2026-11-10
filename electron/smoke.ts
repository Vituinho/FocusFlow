import { screen } from 'electron'
import type { App, BrowserWindow, Tray } from 'electron'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import type { HardwareSnapshot } from './hardwareTypes'
import type { Logger } from './logger'
import type { AppData, StartupStatus } from './shared'
import { runSoak, SoakActions, workerProcesses } from './soak'
import { runWidgetScenario, WidgetScenarioActions } from './widgetScenario'
import type { TrayIconReport } from './trayIcon'

export type SmokeContext = {
  app: App
  logger: Logger
  trayReport: () => TrayIconReport | null
  tray: () => Tray | null
  dashboard: () => BrowserWindow | null
  widget: () => BrowserWindow | null
  hardware: () => HardwareSnapshot
  data: () => AppData
  startupStatus: () => StartupStatus
  applyLoginItem: (enabled: boolean) => void
  launchedHidden: boolean
  quit: () => void
  userData: string
  stats: { ticks: number; maxGapMs: number; stalls: number; notifications: number }
  actions: SoakActions
  widgetActions: Omit<WidgetScenarioActions, 'hideWidget' | 'openDashboard' | 'hideDashboard' | 'setSettings'>
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/** capturePage() never resolves for a hidden window; a screenshot must not be able to hang the whole check. */
const withTimeout = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])

/**
 * Developer/CI smoke check enabled only by the FOCUSFLOW_SMOKE environment variable (value = report path).
 * It inspects the real running app (tray icon, windows, hardware sampling, optional startup registration and renderer crash
 * recovery), writes a JSON report and quits. It never runs in normal use and sends nothing anywhere.
 */
export async function runSmoke(reportPath: string, ctx: SmokeContext) {
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), version: ctx.app.getVersion(), packaged: ctx.app.isPackaged, electron: process.versions.electron, userData: ctx.userData }
  try {
    ctx.app.getAppMetrics() // reset the CPU counters
    await wait(2500)
    // Cold starts (first run after an install, antivirus scans) can be slow: wait for the windows instead of racing them.
    const expectHidden = !!process.env.FOCUSFLOW_SMOKE_EXPECT_HIDDEN
    if (!expectHidden) for (let index = 0; index < 40 && !(ctx.widget()?.isVisible() ?? false); index++) await wait(500)
    if (!ctx.launchedHidden && !expectHidden) for (let index = 0; index < 40 && !(ctx.dashboard()?.isVisible() ?? false); index++) await wait(500)
    const tray = ctx.tray()
    const trayReport = ctx.trayReport()
    report.tray = { created: !!tray && !tray.isDestroyed(), icon: trayReport, bounds: tray && !tray.isDestroyed() ? tray.getBounds() : null }
    const dashboard = ctx.dashboard(), widget = ctx.widget()
    report.windows = {
      launchedHidden: ctx.launchedHidden,
      dashboard: dashboard && !dashboard.isDestroyed() ? { visible: dashboard.isVisible(), bounds: dashboard.getBounds(), url: dashboard.webContents.getURL() } : null,
      widget: widget && !widget.isDestroyed() ? { visible: widget.isVisible(), bounds: widget.getBounds(), url: widget.webContents.getURL() } : null,
    }
    const displays = screen.getAllDisplays().map(display => ({ id: display.id, scale: display.scaleFactor, workArea: display.workArea }))
    // 2 DIP of tolerance: fractional scale factors round window sizes to whole device pixels.
    const inside = (rect: { x: number; y: number; width: number; height: number } | undefined) => !!rect && displays.some(display => rect.x >= display.workArea.x - 2 && rect.y >= display.workArea.y - 2 && rect.x + rect.width <= display.workArea.x + display.workArea.width + 2 && rect.y + rect.height <= display.workArea.y + display.workArea.height + 2)
    report.displays = { count: displays.length, list: displays, dashboardInsideWorkArea: inside(dashboard?.getBounds()), widgetInsideWorkArea: inside(widget?.getBounds()) }
    const settings = ctx.data().settings
    report.settings = { workingDays: settings.workingDays, hardwareMonitor: settings.hardwareMonitor, launchAtStartup: settings.launchAtStartup }
    report.dataVersion = ctx.data().version
    report.weekdayAgenda = ctx.data().schedules.weekday.map(item => `${item.start}-${item.end} ${item.name}`)
    report.migrationFiles = fs.readdirSync(ctx.userData).filter(name => name.startsWith('focusflow.'))
    report.saturdayAgenda = ctx.data().schedules.saturday.map(item => `${item.start}-${item.end} ${item.name}`)

    if (process.env.FOCUSFLOW_SMOKE_STARTUP) {
      const before = ctx.startupStatus()
      ctx.applyLoginItem(true)
      const enabled = ctx.startupStatus()
      // `keep` leaves the registration in place so an uninstall test can prove the uninstaller removes it.
      if (process.env.FOCUSFLOW_SMOKE_STARTUP !== 'keep') ctx.applyLoginItem(false)
      report.startup = { before, enabled, after: ctx.startupStatus() }
    } else report.startup = ctx.startupStatus()

    if (process.env.FOCUSFLOW_SMOKE_CRASH && widget && !widget.isDestroyed()) {
      let loads = 0
      widget.webContents.on('did-finish-load', () => { loads++ })
      widget.webContents.forcefullyCrashRenderer()
      // Recovery waits 1 s and then reloads; on a loaded machine the page can take several seconds, so poll instead of a fixed wait.
      for (let index = 0; index < 40 && loads < 1; index++) await wait(500)
      await wait(500)
      report.crashRecovery = { reloadedAfterCrash: loads >= 1, loadsAfterCrash: loads, stillAlive: !widget.isDestroyed() && !widget.webContents.isCrashed() }
    }

    if (process.env.FOCUSFLOW_SMOKE_STALL) {
      // The harness suspends this process from outside; wait for it to be suspended and resumed, then let the timers settle.
      await wait(Number(process.env.FOCUSFLOW_SMOKE_STALL) * 1000 + 8000)
      report.stall = { ticks: ctx.stats.ticks, stalls: ctx.stats.stalls, maxGapMs: ctx.stats.maxGapMs, notifications: ctx.stats.notifications }
    }
    if (!expectHidden) for (let index = 0; index < 20 && ctx.hardware().status !== 'ok'; index++) await wait(500)
    await wait(3500)
    report.hardware = ctx.hardware()
    report.hardwareWorkers = workerProcesses().length
    report.childProcesses = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${process.pid} } | ForEach-Object { $c = [string]$_.CommandLine; [string]$_.ProcessId + ' ' + $_.Name + ' :: ' + $c.Substring(0, [Math]::Min(100, $c.Length)) }`], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).stdout.split(/\r?\n/).filter(Boolean)
    report.hardwareRunning = ctx.actions.hardwareRunning()
    report.stats = { ...ctx.stats }
    if (process.env.FOCUSFLOW_SMOKE_WIDGET) {
      report.widgetScenario = await runWidgetScenario({ ...ctx.widgetActions, hideWidget: ctx.actions.hideWidget, openDashboard: ctx.actions.openDashboard, hideDashboard: ctx.actions.hideDashboard, setSettings: ctx.actions.setSettings }, process.env.FOCUSFLOW_SMOKE_SHOTS)
    }
    if (process.env.FOCUSFLOW_SMOKE_SOAK) report.soak = await runSoak(Number(process.env.FOCUSFLOW_SMOKE_SOAK), { actions: ctx.actions, stats: ctx.stats, logger: ctx.logger })
    const shots = process.env.FOCUSFLOW_SMOKE_SHOTS
    if (shots) {
      fs.mkdirSync(shots, { recursive: true })
      for (const [name, window] of [['dashboard', ctx.dashboard()], ['widget', ctx.widget()]] as const) {
        try { if (window && !window.isDestroyed() && window.isVisible()) fs.writeFileSync(`${shots}/${name}.png`, (await withTimeout(window.webContents.capturePage(), 10_000)).toPNG()) } catch (error) { report.screenshotNote = String(error) }
      }
      const dash = ctx.dashboard()
      if (dash && !dash.isDestroyed()) {
        const click = (text: string) => dash.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim().startsWith(${JSON.stringify(text)})); b?.click(); return !!b })()`)
        for (const [label, file] of [['Agenda', 'agenda-weekday'], ['Sábado', 'agenda-saturday']] as const) {
          await click(label)
          await wait(700)
          fs.writeFileSync(`${shots}/${file}.png`, (await withTimeout(dash.webContents.capturePage(), 10_000)).toPNG())
        }
      }
      report.screenshots = shots
    }
    report.metrics = ctx.app.getAppMetrics().map(metric => ({ type: metric.type, cpuPercent: Math.round(metric.cpu.percentCPUUsage * 100) / 100, workingSetMB: Math.round(metric.memory.workingSetSize / 1024) }))
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8') } catch (error) { ctx.logger.error('Could not write the smoke report', error) }
  ctx.quit()
}
