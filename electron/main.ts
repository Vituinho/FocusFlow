import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, screen, session, shell, Tray } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fitBoundsToDisplays, isRect, minimumSizeFor, Rect } from './bounds'
import { HardwareMonitor } from './hardware'
import { sumCpuTimes } from './hardwareParse'
import { EMPTY_HARDWARE, HardwareSnapshot, validateHardwareSnapshot } from './hardwareTypes'
import { attachCloseToTray, attachRendererRecovery, QuitState, RestartBudget } from './lifecycle'
import { createLogger, Logger } from './logger'
import { createPerfWorker } from './perfWorker'
import { SessionSentinel } from './session'
import { AppData, AppSettings, AppStatus, DEFAULT_SCHEDULES, RuntimeCommand, ScheduleKind, ScheduleSaveResult, Snapshot, StartupStatus, TransitionPayload } from './shared'
import { JsonStore } from './store'
import { loadTrayIcon, TrayIconReport } from './trayIcon'
import { ScheduleEngine, EngineEvent, effectiveView, STALL_MS } from '../src/domain/engine'
import { defaultData, migrateData, needsMigrationBackup, parseActivities } from '../src/domain/migration'
import { applyRuntimeCommand } from '../src/domain/runtime'
import { runSmoke } from './smoke'
import { WidgetController, WidgetWindow } from './widgetController'
import { listFocusFlowProcesses, offerTakeover } from './instances'

// ---------------------------------------------------------------------------------------------------------------------
// Process setup. Everything that touches disk happens after the single-instance lock is held, so a second launch can
// never read, overwrite or race the real configuration.
// ---------------------------------------------------------------------------------------------------------------------

const devUrl = process.env.VITE_DEV_SERVER_URL
const launchedHidden = process.argv.includes('--hidden')
const LOGIN_ARGS = ['--hidden']
const isDevelopment = !app.isPackaged

// The interface is Brazilian Portuguese: make native controls (24-hour time pickers, date formats) match it on any system language.
app.commandLine.appendSwitch('lang', 'pt-BR')
if (process.env.FOCUSFLOW_USER_DATA) app.setPath('userData', path.resolve(process.env.FOCUSFLOW_USER_DATA))

const quit = new QuitState()
const engine = new ScheduleEngine()
let logger: Logger
let store: JsonStore
let sentinel: SessionSentinel
let data: AppData = defaultData()
let loaded = false
let dashboard: BrowserWindow | null = null
let widget: BrowserWindow | null = null
let tray: Tray | null = null
let trayReport: TrayIconReport | null = null
let tickHandle: NodeJS.Timeout | undefined
let hardware: HardwareMonitor | null = null
let revision = 0
let lastSignature = ''
let lastTrayKey = ''
let recoveries = 0
let previousSessionCrashed = false
let suspended = false
let displayTimer: NodeJS.Timeout | undefined
let lastHardware: HardwareSnapshot = EMPTY_HARDWARE
/** Set once the user (or a manual reload) asked for the dashboard, so a hidden start never hides a requested window. */
let recoveriesShouldShow = false
const notifications = new Set<Notification>()
let widgetController: WidgetController
const windowBudgets = { dashboard: new RestartBudget(3, 5 * 60_000), widget: new RestartBudget(3, 5 * 60_000) }

// ---------------------------------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------------------------------

function persist() { revision++; store.schedule(() => data) }

function loadData() {
  const result = store.load()
  const migration = migrateData(result.raw)
  if (result.source === 'none' && result.quarantined) {
    logger.error(`Configuration was unreadable and has been preserved as ${result.quarantined}; defaults are in use`)
  } else if (result.source === 'backup') logger.warn('Configuration restored from the last known good backup')
  if (migration.migratedFrom !== null && needsMigrationBackup(migration)) {
    const backup = store.backupForMigration(`v${migration.migratedFrom}`)
    logger.info(`Migrated configuration from v${migration.migratedFrom} to v${migration.data.version}${backup ? `; original kept at ${backup}` : ''}`)
  }
  for (const warning of migration.warnings) logger.warn(`Configuration: ${warning}`)
  data = migration.data
  loaded = true
  store.writeNow(data)
  store.refreshBackup()
}

// ---------------------------------------------------------------------------------------------------------------------
// Trusted windows and IPC plumbing
// ---------------------------------------------------------------------------------------------------------------------

function isTrustedUrl(url: string) {
  try {
    const candidate = new URL(url)
    if (devUrl) return candidate.origin === new URL(devUrl).origin
    return candidate.protocol === 'file:' && candidate.pathname.toLowerCase().endsWith('/dist/index.html')
  } catch { return false }
}

const liveWindows = () => [dashboard, widget].filter((window): window is BrowserWindow => !!window && !window.isDestroyed())

function isValidSender(event: Electron.IpcMainInvokeEvent) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false
  return liveWindows().some(window => window.webContents.id === event.sender.id) && isTrustedUrl(event.sender.getURL())
}

function guardWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (!isTrustedUrl(url)) event.preventDefault() })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
}

function send(channel: string, payload: unknown, onlyVisible = false) {
  for (const window of liveWindows()) {
    if (onlyVisible && !window.isVisible()) continue
    try { window.webContents.send(channel, payload) } catch (error) { logger.warn(`Could not send ${channel}`, error) }
  }
}

function handle<T>(channel: string, fallback: T, fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isValidSender(event)) { logger.warn(`Rejected IPC ${channel} from an untrusted sender`); return fallback }
    try { return await fn(event, ...args) } catch (error) { logger.error(`IPC ${channel} failed`, error); return fallback }
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// State -> snapshots, notifications
// ---------------------------------------------------------------------------------------------------------------------

function snapshot(now = Date.now()): Snapshot {
  return { data, view: effectiveView(now, data.schedules, data.settings.workingDays, data.runtime), now }
}

function broadcastSnapshot() { send('snapshot:updated', snapshot()) }

function notify(event: EngineEvent) {
  stats.notifications++
  const warning = event.type === 'warning'
  const payload: TransitionPayload = { name: event.name, nextName: event.nextName, warning, sound: data.settings.sound, speech: data.settings.speech }
  if (data.settings.notifications && Notification.isSupported()) {
    try {
      const toast = new Notification({
        title: warning ? 'Faltam 5 minutos' : 'Atividade iniciada',
        body: warning ? `${event.name} termina em breve.` : `Agora: ${event.name}${event.nextName ? ` · em seguida: ${event.nextName}` : ''}`,
        silent: true,
      })
      notifications.add(toast) // keep a reference: unreferenced toasts may be collected before the user clicks them
      toast.on('click', () => openDashboard())
      toast.on('close', () => notifications.delete(toast))
      toast.on('failed', () => notifications.delete(toast))
      toast.show()
    } catch (error) { logger.warn('Could not show the notification', error) }
  }
  send('activity:transition', payload)
}

/** Counters for the soak/smoke checks and for diagnosing timer stalls (sleep/resume, heavy load). */
const stats = { ticks: 0, maxGapMs: 0, stalls: 0, lastTickAt: 0, notifications: 0 }

function tick(suppress = false) {
  try {
    const now = Date.now()
    if (stats.lastTickAt) {
      const gap = now - stats.lastTickAt
      stats.maxGapMs = Math.max(stats.maxGapMs, gap)
      if (gap > STALL_MS) { stats.stalls++; logger.info(`Timer stall of ${Math.round(gap / 1000)} s detected (sleep/resume or heavy load); announcements are suppressed for this tick`) }
    }
    stats.lastTickAt = now
    stats.ticks++
    const result = engine.tick({ now, schedules: data.schedules, workingDays: data.settings.workingDays, runtime: data.runtime, warningsEnabled: data.settings.warnings }, suppress)
    let changed = false
    if (result.dayChanged) {
      data.runtime = { ...data.runtime, manual: undefined, paused: false, pausedAt: undefined, frozenRemainingMs: undefined, pausedActivityName: undefined, skippedKeys: [] }
      changed = true
    } else if (result.manualExpired) {
      data.runtime = { ...data.runtime, manual: undefined }
      changed = true
    }
    if (changed) persist()
    for (const event of result.events) notify(event)
    // The renderers keep their own one-second clock; the main process only pushes when something actually changed.
    const { view } = result
    const signature = `${view.kind}|${view.activity?.id}|${view.startAt}|${view.endAt}|${view.nextAt}|${view.scheduleKind}|${revision}`
    if (signature !== lastSignature) {
      lastSignature = signature
      broadcastSnapshot()
      updateTray()
    }
  } catch (error) { logger.error('Schedule tick failed', error) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------------------------------

const displays = () => screen.getAllDisplays().map(display => ({ id: display.id, workArea: display.workArea }))
const primaryDisplay = () => { const primary = screen.getPrimaryDisplay(); return { id: primary.id, workArea: primary.workArea } }

/** Taller by one row when the hardware summary is shown. */
const HARDWARE_ROW = 26
function widgetSize() {
  const extra = data.settings.hardwareMonitor ? HARDWARE_ROW : 0
  return data.settings.compactWidget ? { width: 286, height: 112 + extra } : { width: 310, height: 220 + extra }
}

function widgetRect(): Rect {
  const size = widgetSize()
  const saved = data.widgetBounds ? { ...data.widgetBounds, ...size } : undefined
  return fitBoundsToDisplays(saved, displays(), primaryDisplay(), size)
}

const DASHBOARD_MINIMUM = { width: 880, height: 650 }

/** Minimum window size adapted to the display the dashboard will be on, so it can always fit. */
function dashboardMinimum(rect: Rect) { return minimumSizeFor(DASHBOARD_MINIMUM, screen.getDisplayMatching(rect).workArea) }

function dashboardRect(): Rect {
  return fitBoundsToDisplays(data.dashboardBounds, displays(), primaryDisplay(), { width: 1220, height: 820 }, DASHBOARD_MINIMUM)
}

function webPreferences() {
  return { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' as const }
}

function loadRenderer(window: BrowserWindow, query?: Record<string, string>) {
  const load = devUrl
    ? window.loadURL(query ? `${devUrl}?${new URLSearchParams(query)}` : devUrl)
    : window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), query ? { query } : undefined)
  load.catch(error => {
    // A window destroyed mid-load (manual reload, quit) rejects its own load: not a failure.
    if (!window.isDestroyed()) logger.warn('Renderer load rejected (recovery will handle it)', error)
  })
}

function watchRenderer(name: 'dashboard' | 'widget', window: BrowserWindow) {
  attachRendererRecovery({
    name, contents: window.webContents, budget: windowBudgets[name], quit, logger,
    onRecovering: () => { recoveries++ },
    onGiveUp: reason => {
      logger.error(`${name} could not be recovered automatically (${reason}); use "Recarregar janelas" in the tray menu`)
      if (Notification.isSupported()) new Notification({ title: 'FocusFlow', body: 'Uma janela do FocusFlow parou de responder. Use “Recarregar janelas” no menu da bandeja.', silent: true }).show()
    },
  })
}

/** Records page load timing and renderer errors in the local log; invaluable when a window stays blank. */
function logRendererEvents(name: string, window: BrowserWindow) {
  const started = Date.now()
  window.webContents.on('did-finish-load', () => logger.info(`${name}: page loaded after ${Date.now() - started} ms`))
  window.once('ready-to-show', () => logger.info(`${name}: ready-to-show event after ${Date.now() - started} ms`))
  window.webContents.on('console-message', event => {
    const { level, message, sourceId, lineNumber } = event as unknown as { level: string | number; message: string; sourceId: string; lineNumber: number }
    if (level === 'error' || level === 3) logger.warn(`${name}: renderer error: ${String(message).slice(0, 300)} (${String(sourceId).split('/').pop()}:${lineNumber})`)
  })
}

/**
 * Runs `show` once the page is ready. Chromium normally emits ready-to-show, but on a loaded machine it can be very late or
 * missing, which would leave the window hidden forever; page load and a hard timeout are therefore fallbacks.
 */
function showWhenReady(name: string, window: BrowserWindow, show: () => void) {
  let done = false
  const go = (reason: string) => {
    if (done || window.isDestroyed()) return
    done = true
    logger.info(`${name}: shown (${reason})`)
    show()
  }
  window.once('ready-to-show', () => go('ready-to-show'))
  window.webContents.once('did-finish-load', () => { setTimeout(() => go('did-finish-load'), 1500).unref() })
  setTimeout(() => go('timeout'), 6000).unref()
}

function trackVisibility(window: BrowserWindow) {
  const changed = () => { syncHardware(); updateTray() }
  window.on('show', changed)
  window.on('hide', changed)
  window.on('minimize', changed)
  window.on('restore', changed)
}

function saveDashboardBounds() {
  if (!dashboard || dashboard.isDestroyed() || dashboard.isMinimized()) return
  const maximized = dashboard.isMaximized()
  const normal = dashboard.getNormalBounds()
  data.dashboardBounds = { ...normal, ...(maximized ? { maximized: true } : {}) }
  store.schedule(() => data)
}

function createDashboard() {
  const rect = dashboardRect()
  const window = new BrowserWindow({
    ...rect, minWidth: dashboardMinimum(rect).width, minHeight: dashboardMinimum(rect).height, title: 'FocusFlow', backgroundColor: '#101317', show: false,
    titleBarStyle: 'hidden', autoHideMenuBar: true, webPreferences: webPreferences(),
  })
  dashboard = window
  guardWindow(window)
  watchRenderer('dashboard', window)
  logRendererEvents('dashboard', window)
  attachCloseToTray(window, quit, saveDashboardBounds)
  trackVisibility(window)
  showWhenReady('dashboard', window, () => {
    if (data.dashboardBounds?.maximized) window.maximize()
    if (!launchedHidden || recoveriesShouldShow) window.show()
  })
  window.on('resize', saveDashboardBounds)
  window.on('move', saveDashboardBounds)
  window.on('closed', () => { if (dashboard === window) dashboard = null })
  loadRenderer(window)
}

function createWidget(): BrowserWindow {
  const window = new BrowserWindow({
    ...widgetRect(), title: 'FocusFlow · Foco', frame: false, resizable: false, alwaysOnTop: data.settings.alwaysOnTop,
    transparent: data.settings.transparency, backgroundColor: data.settings.transparency ? '#00000000' : '#171b20', show: false,
    skipTaskbar: true, titleBarStyle: 'hidden', webPreferences: webPreferences(),
  })
  widget = window
  guardWindow(window)
  watchRenderer('widget', window)
  logRendererEvents('widget', window)
  attachCloseToTray(window, quit)
  trackVisibility(window)
  window.on('moved', () => {
    if (window.isDestroyed()) return
    data.widgetBounds = window.getBounds()
    store.schedule(() => data)
  })
  window.on('closed', () => { if (widget === window) widget = null })
  loadRenderer(window, { window: 'widget' })
  return window
}

function openDashboard() {
  if (!dashboard || dashboard.isDestroyed()) { recoveriesShouldShow = true; createDashboard() }
  const window = dashboard!
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/** Every "show the widget" entry point (dashboard button, tray, second launch) goes through the verified controller. */
function showWidget(reason: string, pulse = true) { return widgetController.reveal(reason, { pulse }) }

function hideWidget(reason = 'tray') { widgetController.hide(reason) }

/** Brings the widget back after something may have moved or hidden it (sleep, display change, recovery) without stealing attention. */
function healWidget(reason: string) {
  if (data.widgetVisible) void widgetController.reveal(reason, { pulse: false, remember: false })
}

/** Manual recovery: replaces both windows with fresh ones and a fresh restart budget. */
function reloadWindows() {
  logger.info('Windows reloaded manually')
  windowBudgets.dashboard = new RestartBudget(3, 5 * 60_000)
  windowBudgets.widget = new RestartBudget(3, 5 * 60_000)
  const dashboardWasVisible = !!dashboard && !dashboard.isDestroyed() && dashboard.isVisible()
  for (const window of liveWindows()) window.destroy()
  dashboard = null; widget = null
  recoveriesShouldShow = dashboardWasVisible || !launchedHidden
  createDashboard(); createWidget()
  if (dashboardWasVisible) recoveriesShouldShow = true
  healWidget('reload-windows')
}

function refitWindows() {
  if (displayTimer) clearTimeout(displayTimer)
  displayTimer = setTimeout(() => {
    try {
      healWidget('display-change')
      if (dashboard && !dashboard.isDestroyed() && !dashboard.isMaximized() && !dashboard.isMinimized()) {
        const rect = dashboardRect()
        const minimum = dashboardMinimum(rect)
        dashboard.setMinimumSize(minimum.width, minimum.height)
        dashboard.setBounds(rect)
      }
      refreshTrayIcon()
    } catch (error) { logger.warn('Could not re-fit windows after a display change', error) }
  }, 400)
}

// ---------------------------------------------------------------------------------------------------------------------
// Tray: created once, updated in place
// ---------------------------------------------------------------------------------------------------------------------

function trayStatusLabel(): string {
  const { view } = snapshot()
  const paused = data.runtime.paused
  if (view.kind === 'rest') return 'Dia de descanso'
  if (view.kind === 'finished') return 'Dia concluído'
  if (view.kind === 'before') return `Próximo: ${view.next?.name ?? 'início da rotina'}`
  return `${paused ? 'Pausado' : 'Agora'}: ${view.activity?.name ?? ''}`
}

function buildTrayMenu() {
  const widgetVisible = !!widget && !widget.isDestroyed() && widget.isVisible()
  return Menu.buildFromTemplate([
    { label: trayStatusLabel().slice(0, 60), enabled: false },
    { type: 'separator' },
    { label: 'Abrir painel', click: () => openDashboard() },
    { label: widgetVisible ? 'Trazer widget para frente' : 'Mostrar widget', click: () => { void showWidget('tray-menu') } },
    { label: 'Ocultar widget', enabled: widgetVisible, click: () => hideWidget('tray-menu') },
    { type: 'separator' },
    { label: 'Manter widget acima das janelas', type: 'checkbox', checked: data.settings.alwaysOnTop, click: () => applySettings({ ...data.settings, alwaysOnTop: !data.settings.alwaysOnTop }) },
    { label: 'Notificações', type: 'checkbox', checked: data.settings.notifications, click: () => applySettings({ ...data.settings, notifications: !data.settings.notifications }) },
    { label: 'Monitor de hardware', type: 'checkbox', checked: data.settings.hardwareMonitor, click: () => applySettings({ ...data.settings, hardwareMonitor: !data.settings.hardwareMonitor }) },
    { type: 'separator' },
    { label: 'Recarregar janelas', click: () => reloadWindows() },
    { label: 'Abrir pasta de logs', click: () => { void shell.openPath(logger.directory) } },
    { type: 'separator' },
    { label: 'Sair do FocusFlow', click: () => requestQuit() },
  ])
}

function trayTooltip(): string {
  const parts = ['FocusFlow', trayStatusLabel()]
  if (data.settings.hardwareMonitor && lastHardware.status === 'ok' && lastHardware.cpu !== null) parts.push(`CPU ${Math.round(lastHardware.cpu)}%`)
  return parts.join(' · ').slice(0, 120)
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return
  const widgetVisible = !!widget && !widget.isDestroyed() && widget.isVisible()
  const key = [trayStatusLabel(), widgetVisible, data.settings.alwaysOnTop, data.settings.notifications, data.settings.hardwareMonitor].join('|')
  if (key !== lastTrayKey) {
    lastTrayKey = key
    tray.setContextMenu(buildTrayMenu())
    tray.setToolTip(trayTooltip())
  }
}

function refreshTrayIcon() {
  if (!tray || tray.isDestroyed()) return
  const { image, report } = loadTrayIcon(logger)
  trayReport = report
  tray.setImage(image)
}

function createTray() {
  const { image, report } = loadTrayIcon(logger)
  trayReport = report
  logger.info(`Tray icon: ${report.source}, empty=${report.empty}, ${report.size.width}x${report.size.height}`)
  tray = new Tray(image)
  tray.setToolTip(trayTooltip())
  tray.setContextMenu(buildTrayMenu())
  lastTrayKey = ''
  updateTray()
  // The context menu opens on right click by itself. A single or double left click opens the dashboard.
  tray.on('click', () => openDashboard())
  tray.on('double-click', () => openDashboard())
}

// ---------------------------------------------------------------------------------------------------------------------
// Start with Windows
// ---------------------------------------------------------------------------------------------------------------------

/** The portable build runs from a temporary folder; the stable path is the portable executable itself. */
const loginExecutable = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath

function startupStatus(): StartupStatus {
  if (!app.isPackaged || process.platform !== 'win32') return { supported: false, enabled: false, willLaunch: false }
  try {
    const settings = app.getLoginItemSettings({ path: loginExecutable(), args: LOGIN_ARGS })
    return { supported: true, enabled: settings.openAtLogin, willLaunch: settings.executableWillLaunchAtLogin ?? settings.openAtLogin }
  } catch (error) { logger.warn('Could not read the startup registration', error); return { supported: true, enabled: false, willLaunch: false } }
}

function applyLoginItem() {
  if (!app.isPackaged || process.platform !== 'win32') return
  try {
    app.setLoginItemSettings({ openAtLogin: data.settings.launchAtStartup, path: loginExecutable(), args: LOGIN_ARGS })
  } catch (error) { logger.error('Could not update the Windows startup registration', error) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Hardware monitor
// ---------------------------------------------------------------------------------------------------------------------

async function readSystemVolume() {
  const drive = `${process.env.SystemDrive || 'C:'}\\`
  const stats = await fs.promises.statfs(drive)
  const total = stats.blocks * stats.bsize
  return { id: drive.slice(0, 2).toUpperCase(), label: '', usedBytes: total - stats.bavail * stats.bsize, totalBytes: total }
}

function ensureHardware(): HardwareMonitor {
  if (hardware) return hardware
  hardware = new HardwareMonitor({
    provider: createPerfWorker({ logger }),
    readCpuTimes: () => sumCpuTimes(os.cpus()),
    readMemory: () => ({ total: os.totalmem(), free: os.freemem() }),
    readSystemVolume, logger,
  })
  hardware.on('update', (value: HardwareSnapshot) => {
    lastHardware = value
    const safe = validateHardwareSnapshot(value)
    if (safe) send('hardware:update', safe, true)
  })
  return hardware
}

/** Sampling only runs while it can be seen: enabled in Settings, awake, and a window is visible. */
function syncHardware() {
  const enabled = data.settings.hardwareMonitor
  const anyVisible = liveWindows().some(window => window.isVisible() && !window.isMinimized())
  if (enabled && !suspended && anyVisible) ensureHardware().start()
  else hardware?.stop()
  if (!enabled) lastHardware = EMPTY_HARDWARE
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------------

function isSettings(value: unknown): value is AppSettings {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AppSettings>
  return (candidate.theme === 'dark' || candidate.theme === 'light') &&
    ['notifications', 'sound', 'speech', 'warnings', 'alwaysOnTop', 'transparency', 'launchAtStartup', 'compactWidget', 'hardwareMonitor', 'crashRecovery'].every(key => typeof candidate[key as keyof AppSettings] === 'boolean') &&
    Array.isArray(candidate.workingDays) && candidate.workingDays.length > 0 && candidate.workingDays.length <= 7 && candidate.workingDays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
}

function applySettings(next: AppSettings) {
  const previous = data.settings
  data.settings = { ...next, workingDays: [...new Set(next.workingDays)].sort() }
  if (previous.launchAtStartup !== next.launchAtStartup) applyLoginItem()
  if (widget && !widget.isDestroyed()) {
    widget.setAlwaysOnTop(next.alwaysOnTop)
    widget.setOpacity(next.transparency ? 0.88 : 1)
    if (previous.compactWidget !== next.compactWidget || previous.hardwareMonitor !== next.hardwareMonitor) widget.setBounds(widgetRect())
  }
  engine.markExternalChange()
  persist()
  syncHardware()
  lastTrayKey = ''
  tick(true)
}

function appStatus(): AppStatus {
  return {
    version: app.getVersion(), packaged: app.isPackaged, startup: startupStatus(), launchedHidden,
    previousSessionEndedUnexpectedly: previousSessionCrashed, recoveries, logDirectory: logger.directory,
    recentIssues: logger.recent().filter((entry): entry is { time: string; level: 'warn' | 'error'; message: string } => entry.level !== 'info').slice(-8),
  }
}

function registerIpc() {
  handle<Snapshot | null>('snapshot:get', null, () => snapshot())
  handle<void>('settings:save', undefined, (_event, value: unknown) => { if (isSettings(value)) applySettings(value) })
  handle<ScheduleSaveResult>('schedule:save', { error: 'Não foi possível salvar a agenda.' }, (_event, kind: unknown, value: unknown) => {
    if (kind !== 'weekday' && kind !== 'saturday') return { error: 'Agenda inválida.' }
    const parsed = parseActivities(value)
    if ('error' in parsed) return { error: parsed.error }
    data.schedules = { ...data.schedules, [kind]: parsed.activities }
    engine.markExternalChange(); persist(); tick(true)
    return { schedule: parsed.activities }
  })
  handle<ScheduleSaveResult>('schedule:reset', { error: 'Não foi possível restaurar a agenda.' }, (_event, kind: unknown) => {
    if (kind !== 'weekday' && kind !== 'saturday') return { error: 'Agenda inválida.' }
    const schedule = JSON.parse(JSON.stringify(DEFAULT_SCHEDULES[kind as ScheduleKind]))
    data.schedules = { ...data.schedules, [kind]: schedule }
    engine.markExternalChange(); persist(); tick(true)
    return { schedule }
  })
  const isCommand = (value: unknown): value is RuntimeCommand => {
    if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return false
    const candidate = value as RuntimeCommand
    if (['pause', 'resume', 'skip', 'automatic'].includes(candidate.type)) return true
    if (candidate.type === 'focus-mode') return typeof candidate.enabled === 'boolean'
    if (candidate.type === 'manual') return typeof candidate.name === 'string' && candidate.name.trim().length > 0 && candidate.name.length <= 80 && Number.isFinite(candidate.minutes) && candidate.minutes >= 1 && candidate.minutes <= 720
    if (candidate.type === 'extend') return Number.isFinite(candidate.minutes) && candidate.minutes >= 1 && candidate.minutes <= 120
    return false
  }
  handle<void>('runtime:command', undefined, (_event, value: unknown) => {
    if (!isCommand(value)) return
    const now = Date.now()
    data.runtime = applyRuntimeCommand(data.runtime, value, effectiveView(now, data.schedules, data.settings.workingDays, data.runtime), now)
    engine.markExternalChange(); persist(); tick(true)
  })
  handle<void>('window:dashboard', undefined, () => openDashboard())
  handle<{ ok: boolean; reason?: string }>('window:widget', { ok: false, reason: 'ipc-error' }, async () => {
    const { ok, reason } = await showWidget('dashboard-button')
    return { ok, reason }
  })
  handle<void>('window:minimize', undefined, () => { dashboard?.hide() })
  handle<void>('window:close', undefined, () => { dashboard?.hide() })
  handle<void>('window:topmost', undefined, () => applySettings({ ...data.settings, alwaysOnTop: !data.settings.alwaysOnTop }))
  handle<void>('window:compact', undefined, (_event, value: unknown) => { if (typeof value === 'boolean') applySettings({ ...data.settings, compactWidget: value }) })
  handle('hardware:get', EMPTY_HARDWARE, () => data.settings.hardwareMonitor ? validateHardwareSnapshot(lastHardware) ?? EMPTY_HARDWARE : EMPTY_HARDWARE)
  handle<void>('hardware:retry', undefined, () => { if (data.settings.hardwareMonitor) { ensureHardware().start(); hardware?.retry() } })
  handle<AppStatus | null>('app:status', null, () => appStatus())
  handle<void>('app:open-logs', undefined, async () => { await shell.openPath(logger.directory) })
}

// ---------------------------------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------------------------------

function requestQuit() {
  quit.request()
  app.quit()
}

function installProcessGuards() {
  const burst = new RestartBudget(3, 60_000)
  const onFatal = (label: string, error: unknown) => {
    logger.error(label, error)
    // Individual exceptions are logged and survived. A burst means the process is in a bad state: relaunch once, bounded.
    if (!burst.tryConsume() && data.settings.crashRecovery && !quit.isQuitting && sentinel.canRelaunch()) {
      logger.error('Repeated main-process errors; relaunching FocusFlow (bounded)')
      sentinel.recordRelaunch()
      store.flush()
      app.relaunch({ args: [...process.argv.slice(1).filter(arg => arg !== '--recovered'), '--recovered'] })
      quit.request()
      app.exit(1)
    }
  }
  process.on('uncaughtException', error => onFatal('Uncaught exception in the main process', error))
  process.on('unhandledRejection', reason => onFatal('Unhandled promise rejection in the main process', reason))
  app.on('child-process-gone', (_event, details) => logger.error(`Child process gone: ${details.type} (${details.reason}, exit ${details.exitCode})`))
}

function boot() {
  const bootStarted = Date.now()
  const userData = app.getPath('userData')
  logger = createLogger({ directory: path.join(userData, 'logs') })
  store = new JsonStore({ directory: userData, logger })
  sentinel = new SessionSentinel(path.join(userData, 'session.json'))
  logger.info(`FocusFlow ${app.getVersion()} starting (packaged=${app.isPackaged}, hidden=${launchedHidden}, electron=${process.versions.electron})`)
  installProcessGuards()
  const session_ = sentinel.begin(process.pid)
  previousSessionCrashed = session_.previousCrashed
  if (previousSessionCrashed) logger.warn(`The previous session did not exit cleanly (started ${new Date(session_.previousStartedAt ?? 0).toISOString()})`)

  loadData()
  logger.info(`Startup: configuration ready after ${Date.now() - bootStarted} ms`)
  if (data.settings.launchAtStartup && startupStatus().supported && !startupStatus().enabled) applyLoginItem()
  if (app.isPackaged) Menu.setApplicationMenu(null)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))

  registerIpc()
  widgetController = new WidgetController({
    getWindow: () => (widget && !widget.isDestroyed() ? (widget as unknown as WidgetWindow) : null),
    createWindow: () => createWidget() as unknown as WidgetWindow,
    displays,
    activeDisplay: () => { const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); return { id: display.id, workArea: display.workArea } },
    desiredBounds: widgetRect,
    preferences: () => ({ alwaysOnTop: data.settings.alwaysOnTop, opacity: data.settings.transparency ? 0.88 : 1 }),
    persistVisible: visible => { if (data.widgetVisible !== visible) { data.widgetVisible = visible; persist() } },
    notifyFailure: message => { if (Notification.isSupported()) new Notification({ title: 'FocusFlow', body: message, silent: true }).show() },
    logger, budget: new RestartBudget(4, 60_000),
  })
  logger.info(`Executable: ${process.execPath}${process.env.PORTABLE_EXECUTABLE_FILE ? ` (portable: ${process.env.PORTABLE_EXECUTABLE_FILE})` : ''}; displays: ${displays().map(d => `#${d.id} ${d.workArea.x},${d.workArea.y} ${d.workArea.width}x${d.workArea.height}`).join(' | ')}`)
  createDashboard()
  createWidget()
  createTray()
  if (data.widgetVisible) void showWidget('startup', false)
  logger.info(`Startup: windows and tray created after ${Date.now() - bootStarted} ms`)
  // Local-only minidumps (nothing is uploaded). Started after the windows are up so it can never delay startup.
  setTimeout(() => { try { crashReporter.start({ uploadToServer: false, compress: true }) } catch (error) { logger.warn('Local crash dumps unavailable', error) } }, 5000).unref()
  tick(true)
  tickHandle = setInterval(() => tick(false), 1000)

  powerMonitor.on('suspend', () => { suspended = true; syncHardware() })
  const resumed = () => {
    suspended = false
    engine.markResumed()
    tick(true)
    syncHardware()
    hardware?.retry()
    setTimeout(() => healWidget('resume'), 2500).unref() // displays and the shell need a moment to settle after wake-up
  }
  powerMonitor.on('resume', resumed)
  powerMonitor.on('unlock-screen', () => { engine.markResumed(); tick(true); healWidget('unlock') })
  screen.on('display-metrics-changed', refitWindows)
  screen.on('display-added', refitWindows)
  screen.on('display-removed', refitWindows)
  nativeTheme.on('updated', refreshTrayIcon)
  syncHardware()

  if (process.env.FOCUSFLOW_SMOKE) {
    void runSmoke(process.env.FOCUSFLOW_SMOKE, {
      app, logger, trayReport: () => trayReport, tray: () => tray, dashboard: () => dashboard, widget: () => widget,
      hardware: () => lastHardware, data: () => data, startupStatus, applyLoginItem: (enabled: boolean) => { data.settings.launchAtStartup = enabled; applyLoginItem() },
      launchedHidden, quit: () => requestQuit(), userData, stats,
      widgetActions: { reveal: reason => widgetController.reveal(reason), heal: healWidget, windows: () => ({ dashboard, widget }) },
      actions: {
        openDashboard, hideDashboard: () => { dashboard?.hide() }, showWidget: () => { void showWidget('harness') }, hideWidget: () => hideWidget('harness'), reloadWindows,
        setSettings: (patch: Partial<AppSettings>) => applySettings({ ...data.settings, ...patch }),
        command: (command: RuntimeCommand) => { const now = Date.now(); data.runtime = applyRuntimeCommand(data.runtime, command, effectiveView(now, data.schedules, data.settings.workingDays, data.runtime), now); engine.markExternalChange(); persist(); tick(true) },
        storeWrites: () => store.writes, windowCount: () => liveWindows().length, hardwareRunning: () => !!hardware?.isRunning,
      },
    })
  }
}

// The Run registry value is named after the AppUserModelID, exactly like 1.0.x, so an existing registration is updated in place
// (no duplicate entries). The startup smoke test uses its own id so it can never touch a real registration.
app.setAppUserModelId(process.env.FOCUSFLOW_SMOKE_STARTUP ? 'br.com.focusflow.desktop.smoketest' : 'br.com.focusflow.desktop')
app.on('before-quit', () => quit.request())
// Windows (dashboard, widget) are hidden rather than closed; even if both disappear the tray keeps the app alive.
app.on('window-all-closed', () => undefined)

/**
 * This launch lost the single-instance lock. Normally the running copy just surfaces its windows. But when that copy is an OLDER build
 * (for example 1.0.0 still sitting in the tray after an upgrade) the new build would exit silently and the user would keep using the
 * old one without noticing. In that case, ask - and only with an explicit yes close the old one and start this version.
 */
async function handleLostLock() {
  const userData = app.getPath('userData')
  const log = createLogger({ directory: path.join(userData, 'logs') })
  log.info(`Second launch of ${app.getVersion()} (pid ${process.pid}): another instance holds the lock`)
  try {
    const outcome = await offerTakeover({
      own: { pid: process.pid, exeName: path.basename(process.execPath), version: app.getVersion() },
      list: listFocusFlowProcesses,
      confirm: async older => {
        if (process.env.FOCUSFLOW_SMOKE) return process.env.FOCUSFLOW_SMOKE_TAKEOVER === 'accept' // automated runs never ask a human
        const { response } = await dialog.showMessageBox({
          type: 'question', title: 'FocusFlow', buttons: ['Fechar a versão anterior e abrir esta', 'Cancelar'], defaultId: 0, cancelId: 1, noLink: true,
          message: `Uma versão anterior do FocusFlow (${older[0].version}) ainda está em execução e impede que a versão ${app.getVersion()} abra.`,
          detail: `Programa: ${older[0].path}\nProcesso: ${older[0].pid}\n\nSuas rotinas e configurações serão mantidas. Deseja fechar a versão anterior agora?`,
        })
        return response === 0
      },
      kill: pid => new Promise<void>((resolve, reject) => { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => error ? reject(error) : resolve()) }),
      waitForExit: async pids => {
        for (let attempt = 0; attempt < 20; attempt++) {
          if (!(await listFocusFlowProcesses()).some(item => pids.includes(item.pid))) return true
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        return false
      },
      relaunch: () => { app.relaunch(); app.exit(0) },
      log: message => log.info(message),
    })
    if (outcome === 'replaced') return
  } catch (error) { log.error('Could not check for an older running instance', error) }
  app.quit()
}

if (!app.requestSingleInstanceLock()) {
  void app.whenReady().then(handleLostLock).catch(() => app.quit())
} else {
  const surface = (reason: string) => { if (!loaded) return; openDashboard(); if (data.widgetVisible) void showWidget(reason) }
  app.on('second-instance', () => surface('second-launch'))
  app.on('activate', () => surface('activate'))
  app.whenReady().then(boot).catch(error => {
    // Bootstrapping failed: record it and leave cleanly instead of a half-initialised process.
    try { logger?.error('FocusFlow failed to start', error) } catch { /* no logger yet */ }
    quit.request()
    app.exit(1)
  })
}

app.on('will-quit', () => {
  if (tickHandle) clearInterval(tickHandle)
  if (displayTimer) clearTimeout(displayTimer)
  if (!loaded) return // a second instance must never touch the real configuration
  try { store.flush(); store.dispose() } catch (error) { logger.error('Final save failed', error) }
  hardware?.stop()
  sentinel.end()
  logger.info('FocusFlow exited cleanly')
  if (tray && !tray.isDestroyed()) tray.destroy()
})
