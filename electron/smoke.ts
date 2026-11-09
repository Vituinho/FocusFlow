import type { App, BrowserWindow, Tray } from 'electron'
import fs from 'node:fs'
import type { HardwareSnapshot } from './hardwareTypes'
import type { Logger } from './logger'
import type { AppData, StartupStatus } from './shared'
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
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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
    for (let index = 0; index < 40 && !(ctx.widget()?.isVisible() ?? false); index++) await wait(500)
    if (!ctx.launchedHidden) for (let index = 0; index < 40 && !(ctx.dashboard()?.isVisible() ?? false); index++) await wait(500)
    const tray = ctx.tray()
    const trayReport = ctx.trayReport()
    report.tray = { created: !!tray && !tray.isDestroyed(), icon: trayReport, bounds: tray && !tray.isDestroyed() ? tray.getBounds() : null }
    const dashboard = ctx.dashboard(), widget = ctx.widget()
    report.windows = {
      launchedHidden: ctx.launchedHidden,
      dashboard: dashboard && !dashboard.isDestroyed() ? { visible: dashboard.isVisible(), bounds: dashboard.getBounds(), url: dashboard.webContents.getURL() } : null,
      widget: widget && !widget.isDestroyed() ? { visible: widget.isVisible(), bounds: widget.getBounds(), url: widget.webContents.getURL() } : null,
    }
    const settings = ctx.data().settings
    report.settings = { workingDays: settings.workingDays, hardwareMonitor: settings.hardwareMonitor, launchAtStartup: settings.launchAtStartup }
    report.dataVersion = ctx.data().version
    report.saturdayAgenda = ctx.data().schedules.saturday.map(item => `${item.start}-${item.end} ${item.name}`)

    if (process.env.FOCUSFLOW_SMOKE_STARTUP) {
      const before = ctx.startupStatus()
      ctx.applyLoginItem(true)
      const enabled = ctx.startupStatus()
      ctx.applyLoginItem(false)
      report.startup = { before, enabled, after: ctx.startupStatus() }
    } else report.startup = ctx.startupStatus()

    if (process.env.FOCUSFLOW_SMOKE_CRASH && widget && !widget.isDestroyed()) {
      let loads = 0
      widget.webContents.on('did-finish-load', () => { loads++ })
      widget.webContents.forcefullyCrashRenderer()
      await wait(5000)
      report.crashRecovery = { reloadedAfterCrash: loads >= 1, loadsAfterCrash: loads, stillAlive: !widget.isDestroyed() && !widget.webContents.isCrashed() }
    }

    for (let index = 0; index < 20 && ctx.hardware().status !== 'ok'; index++) await wait(500)
    await wait(3500)
    report.hardware = ctx.hardware()
    const shots = process.env.FOCUSFLOW_SMOKE_SHOTS
    if (shots) {
      fs.mkdirSync(shots, { recursive: true })
      for (const [name, window] of [['dashboard', ctx.dashboard()], ['widget', ctx.widget()]] as const) {
        if (window && !window.isDestroyed()) fs.writeFileSync(`${shots}/${name}.png`, (await window.webContents.capturePage()).toPNG())
      }
      const dash = ctx.dashboard()
      if (dash && !dash.isDestroyed()) {
        const click = (text: string) => dash.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim().startsWith(${JSON.stringify(text)})); b?.click(); return !!b })()`)
        for (const [label, file] of [['Agenda', 'agenda-weekday'], ['Sábado', 'agenda-saturday']] as const) {
          await click(label)
          await wait(700)
          fs.writeFileSync(`${shots}/${file}.png`, (await dash.webContents.capturePage()).toPNG())
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
