import { execFile, spawnSync } from 'node:child_process'
import { app } from 'electron'
import type { AppSettings, RuntimeCommand } from './shared'
import type { Logger } from './logger'

export type SoakActions = {
  openDashboard(): void
  hideDashboard(): void
  showWidget(): void
  hideWidget(): void
  reloadWindows(): void
  setSettings(patch: Partial<AppSettings>): void
  command(command: RuntimeCommand): void
  storeWrites(): number
  windowCount(): number
  hardwareRunning(): boolean
}

export type SoakContext = {
  actions: SoakActions
  stats: { ticks: number; maxGapMs: number; stalls: number; notifications: number }
  logger: Logger
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Child PowerShell workers of this process (the hardware sampler). Always 0 or 1 when healthy. */
export function workerProcesses(): number[] {
  const query = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='powershell.exe'" | ForEach-Object { [string]$_.ProcessId + '|' + $_.CommandLine }`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  // The sampler is the only child started with -EncodedCommand; the listing query itself is excluded by its own text.
  return (result.stdout || '').split(String.fromCharCode(10)).map(line => line.trim()).filter(line => line.includes('-EncodedCommand') && !line.includes('Get-CimInstance')).map(line => Number(line.split('|')[0])).filter(Number.isFinite)
}

/** Asynchronous variant for the stress loop: a blocking child process call would stall the very timers the soak is measuring. */
function workerProcessesAsync(): Promise<number[]> {
  const query = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='powershell.exe'" | ForEach-Object { [string]$_.ProcessId + '|' + $_.CommandLine }`
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (_error, stdout) => {
      resolve(String(stdout || '').split(String.fromCharCode(10)).map(line => line.trim()).filter(line => line.includes('-EncodedCommand') && !line.includes('Get-CimInstance')).map(line => Number(line.split('|')[0])).filter(Number.isFinite))
    })
  })
}

async function killWorkers(): Promise<number> {
  const pids = await workerProcessesAsync()
  for (const pid of pids) execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }, () => undefined)
  return pids.length
}

type Sample = { t: number; cpu: number; workingSetMB: number; mainRssMB: number; heapMB: number; timers: number; windows: number }

function sample(ctx: SoakContext, started: number): Sample {
  const metrics = app.getAppMetrics()
  const memory = process.memoryUsage()
  const info = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.() ?? []
  return {
    t: Math.round((Date.now() - started) / 1000),
    cpu: Math.round(metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0) * 100) / 100,
    workingSetMB: Math.round(metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024),
    mainRssMB: Math.round(memory.rss / 1048576),
    heapMB: Math.round(memory.heapUsed / 1048576),
    timers: info.filter(name => name === 'Timeout').length,
    windows: ctx.actions.windowCount(),
  }
}

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

/**
 * Bounded stress loop used only by the smoke harness: repeatedly hides/shows windows, flips settings (including the hardware
 * monitor), pauses/resumes, reloads windows and kills the hardware worker, while sampling CPU, memory, timers and window counts.
 */
export async function runSoak(seconds: number, ctx: SoakContext) {
  const { actions, stats } = ctx
  const started = Date.now()
  const samples: Sample[] = []
  let cycle = 0, workersKilled = 0, maxWorkers = 0
  const startedTicks = stats.ticks
  samples.push(sample(ctx, started))
  let nextSample = Date.now() + 5000, nextWorkerCheck = Date.now() + 15_000
  const compact = { value: false }, theme = { value: false }
  while (Date.now() - started < seconds * 1000) {
    switch (cycle % 12) {
      case 0: actions.hideDashboard(); break
      case 1: actions.openDashboard(); break
      case 2: actions.hideWidget(); break
      case 3: actions.showWidget(); break
      case 4: compact.value = !compact.value; actions.setSettings({ compactWidget: compact.value }); break
      case 5: actions.setSettings({ hardwareMonitor: false }); break
      case 6: actions.setSettings({ hardwareMonitor: true }); break
      case 7: theme.value = !theme.value; actions.setSettings({ theme: theme.value ? 'light' : 'dark' }); break
      case 8: actions.command({ type: 'manual', name: 'Soak', minutes: 5 }); break
      case 9: actions.command({ type: 'pause' }); break
      case 10: actions.command({ type: 'resume' }); break
      case 11: if (cycle % 36 === 35) actions.reloadWindows(); else void killWorkers().then(count => { workersKilled += count }); break
    }
    cycle++
    await wait(1200)
    if (Date.now() >= nextSample) { samples.push(sample(ctx, started)); nextSample += 5000 }
    if (Date.now() >= nextWorkerCheck) { maxWorkers = Math.max(maxWorkers, (await workerProcessesAsync()).length); nextWorkerCheck += 15_000 }
  }
  actions.command({ type: 'automatic' })
  actions.setSettings({ hardwareMonitor: true, compactWidget: false, theme: 'dark' })
  actions.openDashboard()
  await wait(4000)
  samples.push(sample(ctx, started))
  maxWorkers = Math.max(maxWorkers, (await workerProcessesAsync()).length)

  const third = Math.max(1, Math.floor(samples.length / 3))
  const early = samples.slice(1, 1 + third), late = samples.slice(-third)
  const elapsed = (Date.now() - started) / 1000
  const errors = ctx.logger.recent().filter(entry => entry.level === 'error').map(entry => entry.message)
  return {
    seconds: Math.round(elapsed), cycles: cycle, workersKilled, maxWorkerProcesses: maxWorkers, samples,
    cpu: { earlyMean: Math.round(mean(early.map(item => item.cpu)) * 100) / 100, lateMean: Math.round(mean(late.map(item => item.cpu)) * 100) / 100 },
    memory: { earlyWorkingSetMB: Math.round(mean(early.map(item => item.workingSetMB))), lateWorkingSetMB: Math.round(mean(late.map(item => item.workingSetMB))), earlyHeapMB: Math.round(mean(early.map(item => item.heapMB))), lateHeapMB: Math.round(mean(late.map(item => item.heapMB))) },
    timers: { min: Math.min(...samples.map(item => item.timers)), max: Math.max(...samples.map(item => item.timers)) },
    maxWindows: Math.max(...samples.map(item => item.windows)),
    ticks: { total: stats.ticks - startedTicks, expected: Math.round(elapsed), maxGapMs: stats.maxGapMs, stalls: stats.stalls },
    storeWrites: actions.storeWrites(),
    errors, notifications: stats.notifications,
    hardwareRunningAtEnd: actions.hardwareRunning(),
  }
}
