import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, screen, Tray, powerMonitor } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { Activity, AppData, AppSettings, DEFAULT_RUNTIME, DEFAULT_SCHEDULE, DEFAULT_SETTINGS, RuntimeCommand, RuntimeState, Snapshot } from './shared'
import { getScheduleView, validateSchedule } from '../src/domain/schedule'
import { isFreshTransition, pauseRuntime, resumeRuntime } from '../src/domain/runtime'

const devUrl = process.env.VITE_DEV_SERVER_URL
const storePath = () => path.join(app.getPath('userData'), 'focusflow.json')
let data: AppData = { schedule: DEFAULT_SCHEDULE, settings: DEFAULT_SETTINGS, runtime: DEFAULT_RUNTIME }
let dashboard: BrowserWindow | null = null
let widget: BrowserWindow | null = null
let tray: Tray | null = null
let tickHandle: NodeJS.Timeout | undefined
let boundsSaveHandle: NodeJS.Timeout | undefined
let lastActivityKey = ''
let lastWarningKey = ''
let initializedEngine = false
let currentDay = ''
let isQuitting = false

function readData(): AppData {
  try {
    const saved = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Partial<AppData>
    const schedule = Array.isArray(saved.schedule) && !validateSchedule(saved.schedule) ? saved.schedule : DEFAULT_SCHEDULE
    const settings = { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) }
    const workingDays = settings.workingDays.filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    const widgetBounds = saved.widgetBounds && [saved.widgetBounds.x, saved.widgetBounds.y, saved.widgetBounds.width, saved.widgetBounds.height].every(Number.isFinite) ? saved.widgetBounds : undefined
    return { schedule, settings: { ...settings, workingDays: workingDays.length ? workingDays : DEFAULT_SETTINGS.workingDays }, runtime: { ...DEFAULT_RUNTIME, ...(saved.runtime ?? {}) }, widgetBounds }
  } catch { return { schedule: DEFAULT_SCHEDULE, settings: DEFAULT_SETTINGS, runtime: DEFAULT_RUNTIME } }
}

function writeData() {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true })
    fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf8')
  } catch (error) { console.error('Não foi possível salvar os dados locais do FocusFlow:', error) }
}

function isTrustedUrl(url: string) {
  try {
    const candidate = new URL(url)
    if (devUrl) return candidate.origin === new URL(devUrl).origin
    return candidate.protocol === 'file:' && candidate.pathname.toLowerCase().endsWith('/dist/index.html')
  } catch { return false }
}

function isValidSender(event: Electron.IpcMainInvokeEvent) {
  return [dashboard, widget].some(window => window && !window.isDestroyed() && window.webContents.id === event.sender.id && isTrustedUrl(event.sender.getURL()))
}

function guardWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (!isTrustedUrl(url)) event.preventDefault() })
}

function dayKey(now: number) {
  const date = new Date(now)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function snapshot(now = Date.now()): Snapshot {
  const view = getScheduleView(now, data.schedule, data.settings.workingDays)
  const runtime = data.runtime
  if (runtime.manual && runtime.manual.endAt <= now) {
    runtime.manual = undefined
    writeData()
  }
  if (runtime.manual && runtime.manual.endAt > now) {
    const startAt = runtime.manual.endAt - Math.max(0, runtime.manual.endAt - now)
    view.kind = 'activity'
    view.activity = { id: 'manual', name: runtime.manual.name, start: new Date(startAt).toTimeString().slice(0, 5), end: new Date(runtime.manual.endAt).toTimeString().slice(0, 5), color: '#58d5bd', icon: 'sparkles' }
    view.next = null
    view.startAt = now
    view.endAt = runtime.manual.endAt
    view.nextAt = runtime.manual.endAt
  }
  return { data, view, now }
}

function activityKey(now: number, view: Snapshot['view']) {
  const item = view.activity
  return item ? `${dayKey(now)}:${item.id}` : `${dayKey(now)}:${view.kind}`
}

function broadcastSnapshot() {
  const value = snapshot()
  for (const window of [dashboard, widget]) {
    if (window && !window.isDestroyed()) window.webContents.send('snapshot:updated', value)
  }
}

function transition(name: string, nextName: string, warning = false) {
  const payload = { name, nextName, warning }
  if (data.settings.notifications && Notification.isSupported()) {
    const title = warning ? 'Faltam 5 minutos' : 'Atividade iniciada'
    new Notification({ title, body: warning ? `${name} termina em breve.` : `Agora: ${name}${nextName ? ` · em seguida: ${nextName}` : ''}`, silent: true }).show()
  }
  for (const window of [dashboard, widget]) {
    if (window && !window.isDestroyed()) window.webContents.send('activity:transition', payload)
  }
}

function runEngine(suppressEvents = false) {
  const now = Date.now()
  const key = dayKey(now)
  if (!currentDay) currentDay = key
  else if (currentDay !== key) {
    currentDay = key
    data.runtime.skippedKeys = []
    data.runtime.manual = undefined
    data.runtime.paused = false
    data.runtime.frozenRemainingMs = undefined
    writeData()
  }
  const current = snapshot(now).view
  const currentKey = activityKey(now, current)
  if (!initializedEngine) {
    lastActivityKey = currentKey
    initializedEngine = true
  } else if (currentKey !== lastActivityKey) {
    if (!data.runtime.paused && current.kind === 'activity' && current.activity && isFreshTransition(lastActivityKey, currentKey, now, current.startAt, suppressEvents)) {
      transition(current.activity.name, current.next?.name ?? '')
    }
    lastActivityKey = currentKey
  }
  if (!suppressEvents && !data.runtime.paused && data.settings.warnings && current.activity && current.endAt) {
    const remaining = current.endAt - now
    const warningKey = `${currentKey}:warning`
    if (remaining <= 5 * 60_000 && remaining > 4 * 60_000 && lastWarningKey !== warningKey) {
      lastWarningKey = warningKey
      transition(current.activity.name, current.next?.name ?? '', true)
    }
  }
  broadcastSnapshot()
}

function iconImage() {
  return nativeImage.createFromDataURL('data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="3" y="3" width="58" height="58" rx="18" fill="#58d5bd"/><path d="M20 34a12 12 0 1 0 2-7" fill="none" stroke="#101317" stroke-width="5" stroke-linecap="round"/><path d="M18 20v9h9" fill="none" stroke="#101317" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 22v11l8 5" fill="none" stroke="#101317" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>'))
}

function createDashboard() {
  dashboard = new BrowserWindow({
    width: 1220, height: 820, minWidth: 880, minHeight: 650,
    title: 'FocusFlow', backgroundColor: '#101317', show: false,
    titleBarStyle: 'hidden', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  guardWindow(dashboard)
  if (devUrl) void dashboard.loadURL(devUrl)
  else void dashboard.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  dashboard.once('ready-to-show', () => dashboard?.show())
  dashboard.on('close', event => { if (!isQuitting) { event.preventDefault(); dashboard?.hide() } })
  dashboard.on('closed', () => { dashboard = null })
}

function widgetBounds() {
  const area = screen.getPrimaryDisplay().workArea
  const bounds = data.widgetBounds ?? { x: area.x + area.width - 340, y: area.y + 40, width: 310, height: 220 }
  const display = screen.getDisplayMatching(bounds)
  const displayArea = display.workArea
  return {
    x: Math.max(displayArea.x, Math.min(bounds.x, displayArea.x + displayArea.width - bounds.width)),
    y: Math.max(displayArea.y, Math.min(bounds.y, displayArea.y + displayArea.height - bounds.height)),
    width: data.settings.compactWidget ? 286 : 310,
    height: data.settings.compactWidget ? 112 : 220,
  }
}

function createWidget() {
  widget = new BrowserWindow({
    ...widgetBounds(), title: 'FocusFlow · Foco', frame: false, resizable: false,
    alwaysOnTop: data.settings.alwaysOnTop, transparent: data.settings.transparency,
    backgroundColor: data.settings.transparency ? '#00000000' : '#171b20', show: false,
    skipTaskbar: true, titleBarStyle: 'hidden',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  guardWindow(widget)
  if (devUrl) void widget.loadURL(`${devUrl}?window=widget`)
  else void widget.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), { query: { window: 'widget' } })
  widget.once('ready-to-show', () => widget?.showInactive())
  widget.on('close', event => { if (!isQuitting) { event.preventDefault(); widget?.hide() } })
  widget.on('moved', () => {
    if (!widget || widget.isDestroyed()) return
    data.widgetBounds = widget.getBounds()
    if (boundsSaveHandle) clearTimeout(boundsSaveHandle)
    boundsSaveHandle = setTimeout(writeData, 350)
  })
  widget.on('closed', () => { widget = null })
}

function createTray() {
  tray?.destroy()
  tray = new Tray(iconImage())
  tray.setToolTip('FocusFlow · sua rotina em fluxo')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir painel', click: () => { dashboard?.show(); dashboard?.focus() } },
    { label: 'Mostrar widget', click: () => { if (!widget) createWidget(); widget?.showInactive() } },
    { label: 'Ocultar widget', click: () => { widget?.hide() } },
    { type: 'separator' },
    { label: 'Manter widget acima das janelas', type: 'checkbox', checked: data.settings.alwaysOnTop, click: () => { data.settings.alwaysOnTop = !data.settings.alwaysOnTop; widget?.setAlwaysOnTop(data.settings.alwaysOnTop); writeData(); createTray(); broadcastSnapshot() } },
    { label: 'Notificações', type: 'checkbox', checked: data.settings.notifications, click: () => { data.settings.notifications = !data.settings.notifications; writeData(); createTray(); broadcastSnapshot() } },
    { type: 'separator' },
    { label: 'Sair do FocusFlow', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('double-click', () => { dashboard?.show(); dashboard?.focus() })
}

function openDashboard() { if (!dashboard) createDashboard(); dashboard?.show(); dashboard?.focus() }

function isSettings(value: unknown): value is AppSettings {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AppSettings>
  return (candidate.theme === 'dark' || candidate.theme === 'light') &&
    ['notifications', 'sound', 'speech', 'warnings', 'alwaysOnTop', 'transparency', 'launchAtStartup', 'compactWidget'].every(key => typeof candidate[key as keyof AppSettings] === 'boolean') &&
    Array.isArray(candidate.workingDays) && candidate.workingDays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
}

function isRuntimeCommand(value: unknown): value is RuntimeCommand {
  if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return false
  const candidate = value as RuntimeCommand
  if (['pause', 'resume', 'skip', 'automatic'].includes(candidate.type)) return true
  if (candidate.type === 'focus-mode') return typeof candidate.enabled === 'boolean'
  if (candidate.type === 'manual') return typeof candidate.name === 'string' && candidate.name.trim().length > 0 && candidate.name.length <= 80 && Number.isFinite(candidate.minutes) && candidate.minutes >= 1 && candidate.minutes <= 720
  if (candidate.type === 'extend') return Number.isFinite(candidate.minutes) && candidate.minutes >= 1 && candidate.minutes <= 120
  return false
}

function registerIpc() {
  ipcMain.handle('snapshot:get', event => isValidSender(event) ? snapshot() : null)
  ipcMain.handle('settings:save', (event, value: unknown) => {
    if (!isValidSender(event) || !isSettings(value)) return
    data.settings = value
    app.setLoginItemSettings({ openAtLogin: app.isPackaged && value.launchAtStartup })
    widget?.setAlwaysOnTop(value.alwaysOnTop)
    widget?.setOpacity(value.transparency ? 0.88 : 1)
    widget?.setBounds(widgetBounds())
    if (tray) createTray()
    writeData(); broadcastSnapshot()
  })
  ipcMain.handle('schedule:save', (event, value: unknown) => {
    if (!isValidSender(event) || !Array.isArray(value)) return { error: 'Agenda inválida.' }
    const error = validateSchedule(value as Activity[])
    if (error) return { error }
    if ((value as Activity[]).some(item => !item.color || !/^#[0-9a-f]{6}$/i.test(item.color) || typeof item.icon !== 'string' || item.icon.length > 24)) return { error: 'Confira a cor e o ícone de cada atividade.' }
    data.schedule = [...value as Activity[]].sort((a, b) => a.start.localeCompare(b.start))
    lastActivityKey = activityKey(Date.now(), snapshot().view)
    writeData(); broadcastSnapshot()
    return {}
  })
  ipcMain.handle('runtime:command', (event, value: unknown) => {
    if (!isValidSender(event) || !isRuntimeCommand(value)) return
    const command = value as RuntimeCommand
    const now = Date.now(), view = snapshot(now).view
    const runtime: RuntimeState = data.runtime
    if (command.type === 'pause' && !runtime.paused) {
      data.runtime = pauseRuntime(runtime, view, now)
    } else if (command.type === 'resume' && runtime.paused) {
      data.runtime = resumeRuntime(runtime, now)
    } else if (command.type === 'manual') {
      runtime.paused = false; runtime.pausedAt = undefined; runtime.frozenRemainingMs = undefined; runtime.pausedActivityName = undefined; runtime.manual = { name: command.name.trim(), endAt: now + command.minutes * 60_000 }
    } else if (command.type === 'extend' && view.activity) {
      runtime.paused = false; runtime.manual = { name: view.activity.name, endAt: (view.endAt ?? now) + command.minutes * 60_000 }
    } else if (command.type === 'skip') {
      runtime.manual = undefined; runtime.paused = false; runtime.pausedAt = undefined; runtime.frozenRemainingMs = undefined; runtime.pausedActivityName = undefined
      if (view.next) {
        const [hours, minutes] = view.next.end.split(':').map(Number)
        const endAt = new Date(now); endAt.setHours(hours, minutes, 0, 0)
        if (endAt.getTime() <= now) endAt.setDate(endAt.getDate() + 1)
        runtime.manual = { name: view.next.name, endAt: endAt.getTime() }
      }
    } else if (command.type === 'automatic') {
      runtime.paused = false; runtime.pausedAt = undefined; runtime.frozenRemainingMs = undefined; runtime.pausedActivityName = undefined; runtime.manual = undefined
    } else if (command.type === 'focus-mode') runtime.focusMode = command.enabled
    writeData(); runEngine(true)
  })
  ipcMain.handle('window:dashboard', event => { if (isValidSender(event)) openDashboard() })
  ipcMain.handle('window:widget', event => { if (isValidSender(event)) { if (!widget) createWidget(); widget?.showInactive() } })
  ipcMain.handle('window:minimize', event => { if (isValidSender(event)) dashboard?.hide() })
  ipcMain.handle('window:close', event => { if (isValidSender(event)) dashboard?.hide() })
  ipcMain.handle('window:topmost', event => {
    if (!isValidSender(event)) return
    data.settings.alwaysOnTop = !data.settings.alwaysOnTop
    widget?.setAlwaysOnTop(data.settings.alwaysOnTop)
    writeData(); createTray(); broadcastSnapshot()
  })
  ipcMain.handle('window:compact', (event, value: unknown) => {
    if (!isValidSender(event) || typeof value !== 'boolean') return
    data.settings.compactWidget = value
    widget?.setBounds(widgetBounds()); writeData(); broadcastSnapshot()
  })
}

app.setAppUserModelId('br.com.focusflow.desktop')
app.on('before-quit', () => { isQuitting = true })
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => openDashboard())
  app.whenReady().then(() => {
    data = readData()
    app.setLoginItemSettings({ openAtLogin: app.isPackaged && data.settings.launchAtStartup })
    registerIpc()
    createDashboard(); createWidget(); createTray()
    runEngine(true)
    tickHandle = setInterval(() => runEngine(false), 1000)
    powerMonitor.on('resume', () => runEngine(true))
    app.on('activate', openDashboard)
  })
}

app.on('will-quit', () => { if (tickHandle) clearInterval(tickHandle); if (boundsSaveHandle) clearTimeout(boundsSaveHandle); writeData(); tray?.destroy() })
