// Validates the hardware monitor against an independent reference and measures its overhead. Run after `npm run build`.
//   node scripts/validate-hardware.mjs [seconds=45]
//
// Reference: Windows' own pre-formatted performance classes (queried by a separate PowerShell process), which compute the
// percentages with a different code path than the monitor's raw-counter deltas. RAM is compared with Win32_OperatingSystem.
// Overhead: CPU time of the monitor's PowerShell worker and event-loop delay of this (main-like) process while sampling.
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { HardwareMonitor } = require('../dist-electron/electron/hardware.js')
const { createPerfWorker } = require('../dist-electron/electron/perfWorker.js')
const { sumCpuTimes, aggregateGpu } = require('../dist-electron/electron/hardwareParse.js')

const seconds = Number(process.argv[2] || 45)
const sleep = ms => new Promise(done => setTimeout(done, ms))
const REFERENCE = `
$ProgressPreference='SilentlyContinue'
while ($true) {
  $r = @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $c = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -Property PercentProcessorTime
  $r.cpu = [double]$c.PercentProcessorTime
  $o = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,FreePhysicalMemory
  $r.ram = 100 * (1 - $o.FreePhysicalMemory / $o.TotalVisibleMemorySize)
  $d = @(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Property Name,PercentIdleTime | Where-Object { $_.Name -ne '_Total' })
  $r.disk = ($d | ForEach-Object { 100 - [double]$_.PercentIdleTime } | Measure-Object -Maximum).Maximum
  $g = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Property Name,UtilizationPercentage)
  $r.gpuCount = $g.Count
  $r.gpu = @($g | Where-Object { $_.UtilizationPercentage -gt 0 } | ForEach-Object { @{ n = [string]$_.Name; u = [double]$_.UtilizationPercentage } })
  [Console]::Out.WriteLine(($r | ConvertTo-Json -Compress -Depth 4))
  Start-Sleep -Milliseconds 2500
}`
const reference = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(REFERENCE, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
const refSamples = []
let buffer = ''
reference.stdout.setEncoding('utf8')
reference.stdout.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); try { if (line) refSamples.push(JSON.parse(line)) } catch { /* ignore */ } } })

const workerCpu = () => {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match '-EncodedCommand' } | ForEach-Object { "$($_.ProcessId) $($_.KernelModeTime + $_.UserModeTime) $($_.WorkingSetSize)" }`], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\r?\n/).filter(Boolean)[0]
  if (!out) return null
  const [pid, ticks, ws] = out.split(' ').map(Number)
  return { pid, seconds: ticks / 1e7, workingSetMB: Math.round(ws / 1048576), at: Date.now() }
}

const histogram = monitorEventLoopDelay({ resolution: 10 })
const monitor = new HardwareMonitor({
  provider: createPerfWorker(),
  readCpuTimes: () => sumCpuTimes(os.cpus()),
  readMemory: () => ({ total: os.totalmem(), free: os.freemem() }),
})
const ours = []
monitor.on('update', snapshot => { if (snapshot.status === 'ok') ours.push({ at: Date.now(), snapshot }) })
histogram.enable()
monitor.start()
await sleep(8000) // warm-up: first deltas and PowerShell start-up
const cpuStart = workerCpu()
const startedAt = Date.now()
await sleep(seconds * 1000)
const cpuEnd = workerCpu()
histogram.disable()
monitor.stop()
reference.kill()

const diffs = { cpu: [], ram: [], disk: [], gpu: [] }
const pairs = { cpu: [], ram: [], disk: [], gpu: [] }
for (const entry of ours.filter(item => item.at > startedAt)) {
  const ref = refSamples.filter(item => Math.abs(item.t - entry.at) < 2500).sort((a, b) => Math.abs(a.t - entry.at) - Math.abs(b.t - entry.at))[0]
  if (!ref) continue
  const { snapshot } = entry
  if (snapshot.cpu !== null) { diffs.cpu.push(Math.abs(snapshot.cpu - ref.cpu)); pairs.cpu.push([snapshot.cpu, ref.cpu]) }
  if (snapshot.ram.percent !== null) { diffs.ram.push(Math.abs(snapshot.ram.percent - ref.ram)); pairs.ram.push([snapshot.ram.percent, ref.ram]) }
  if (snapshot.disk.activityPercent !== null && ref.disk !== null) diffs.disk.push(Math.abs(Math.min(100, snapshot.disk.activityPercent) - Math.min(100, ref.disk)))
  const refGpu = aggregateGpu(ref.gpu.map(item => ({ name: item.n, value: item.u })), ref.gpuCount)
  if (snapshot.gpu.percent !== null && refGpu.percent !== null) diffs.gpu.push(Math.abs(snapshot.gpu.percent - refGpu.percent))
}
const mean = list => list.reduce((a, b) => a + b, 0) / (list.length || 1)
const bias = list => list.length ? { meanOurs: +mean(list.map(p => p[0])).toFixed(1), meanReference: +mean(list.map(p => p[1])).toFixed(1) } : {}
const stat = list => list.length ? { n: list.length, meanAbsDiff: +(list.reduce((a, b) => a + b, 0) / list.length).toFixed(1), maxAbsDiff: +Math.max(...list).toFixed(1) } : { n: 0 }
const wall = cpuStart && cpuEnd ? (cpuEnd.at - cpuStart.at) / 1000 : 0
const result = {
  seconds, samples: ours.length,
  windowMeans: { cpu: bias(pairs.cpu), ram: bias(pairs.ram) },
  accuracyVsWindowsFormattedCounters: { cpu: stat(diffs.cpu), ram: stat(diffs.ram), disk: stat(diffs.disk), gpu: stat(diffs.gpu) },
  workerOverhead: cpuStart && cpuEnd && cpuStart.pid === cpuEnd.pid ? { cpuSecondsUsed: +(cpuEnd.seconds - cpuStart.seconds).toFixed(2), percentOfOneCore: +(((cpuEnd.seconds - cpuStart.seconds) / wall) * 100).toFixed(2), workingSetMB: cpuEnd.workingSetMB } : 'worker restarted or not found',
  eventLoopDelayMs: { mean: +(histogram.mean / 1e6).toFixed(2), p99: +(histogram.percentile(99) / 1e6).toFixed(2), max: +(histogram.max / 1e6).toFixed(2) },
  lastSnapshot: ours.at(-1)?.snapshot,
}
// Load-response check: busy processes must raise the monitor's CPU reading, and the reading must agree with Windows' own
// pre-formatted counter sampled during the same window. (Absolute expectations like "N busy loops = N / cores" do not hold on
// power-limited machines, so Windows' own number is the reference.)
const cores = os.cpus().length
const busyCount = Math.max(1, Math.floor(cores / 2))
const probe = new HardwareMonitor({ provider: createPerfWorker(), readCpuTimes: () => sumCpuTimes(os.cpus()), readMemory: () => ({ total: os.totalmem(), free: os.freemem() }) })
const probeSamples = []
probe.on('update', snapshot => { if (snapshot.cpu !== null) probeSamples.push({ at: Date.now(), cpu: snapshot.cpu }) })
const windowsCpu = () => Number(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\").PercentProcessorTime"], { encoding: 'utf8', windowsHide: true }).stdout.trim())
probe.start()
await sleep(12_000)
const baselineMean = mean(probeSamples.map(item => item.cpu))
const loadStart = Date.now()
const busy = Array.from({ length: busyCount }, () => spawn(process.execPath, ['-e', 'while (true) {}'], { stdio: 'ignore' }))
await sleep(5000)
const windowsReadings = []
for (let index = 0; index < 5; index++) { windowsReadings.push(windowsCpu()); await sleep(1500) }
const loaded = probeSamples.filter(item => item.at > loadStart + 5000).map(item => item.cpu)
busy.forEach(child => child.kill())
probe.stop()
result.loadResponse = { cores, busyProcesses: busyCount, baselineMean: +baselineMean.toFixed(1), loadedMeanOurs: +mean(loaded).toFixed(1), loadedMeanWindowsCounter: +mean(windowsReadings).toFixed(1), observedIncrease: +(mean(loaded) - baselineMean).toFixed(1) }
console.log(JSON.stringify(result, null, 2))
const ok = result.samples >= seconds / 4 && (typeof result.workerOverhead === 'object' ? result.workerOverhead.percentOfOneCore < 3 : false) && result.eventLoopDelayMs.p99 < 100
  && (diffs.ram.length ? stat(diffs.ram).meanAbsDiff < 3 : false) && result.loadResponse.observedIncrease >= 8 && Math.abs(result.loadResponse.loadedMeanOurs - result.loadResponse.loadedMeanWindowsCounter) <= 10
console.log(ok ? 'PASS  hardware monitor accuracy and overhead within limits' : 'FAIL  hardware monitor outside limits')
process.exit(ok ? 0 : 1)
