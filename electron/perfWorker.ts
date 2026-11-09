import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import type { PerfProvider } from './hardware'
import { Logger, nullLogger } from './logger'

/**
 * One long-lived, hidden Windows PowerShell process that answers "sample" requests on stdin with a single JSON line.
 * It reads the same raw performance counters Task Manager uses through CIM (class and property names are not localised,
 * unlike typeperf/Get-Counter paths) and computes the deltas itself, which costs ~30 ms of CPU per sample instead of ~600 ms for
 * the pre-formatted classes. No native module is needed and the process exits by itself when this one goes away.
 * Disk activity is the busiest physical disk (100 - idle time); GPU activity is per engine, as in Task Manager.
 * Nothing leaves the machine and no network access is involved.
 */
export const PERF_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.AutoFlush = $true
$diskPrev = @{}
$gpuPrev = @{}
$primed = $false
while ($true) {
  if ($primed) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
  } else { $line = 'prime' }
  $r = @{}
  try {
    $busiest = $null
    $nowDisk = @{}
    $disks = @(Get-CimInstance -ClassName Win32_PerfRawData_PerfDisk_PhysicalDisk -Property Name,PercentIdleTime,Timestamp_Sys100NS)
    foreach ($d in $disks) {
      if ($d.Name -eq '_Total') { continue }
      $v = [double]$d.PercentIdleTime; $t = [double]$d.Timestamp_Sys100NS
      $nowDisk[$d.Name] = @($v, $t)
      if ($diskPrev.ContainsKey($d.Name)) {
        $p = $diskPrev[$d.Name]; $dt = $t - $p[1]
        if ($dt -gt 0) { $active = 100 - 100 * ($v - $p[0]) / $dt; if ($null -eq $busiest -or $active -gt $busiest) { $busiest = $active } }
      }
    }
    $diskPrev = $nowDisk
    if ($nowDisk.Count -eq 0) { $r.diskError = 'No physical disk counters' }
    elseif ($null -ne $busiest) { $r.disk = [math]::Round($busiest, 1) }
  } catch { $r.diskError = $_.Exception.Message }
  try {
    $g = @(Get-CimInstance -ClassName Win32_PerfRawData_GPUPerformanceCounters_GPUEngine -Property Name,UtilizationPercentage,Timestamp_Sys100NS)
    $busy = New-Object System.Collections.ArrayList
    $nowGpu = @{}
    foreach ($e in $g) {
      $v = [double]$e.UtilizationPercentage; $t = [double]$e.Timestamp_Sys100NS
      $nowGpu[$e.Name] = @($v, $t)
      if ($gpuPrev.ContainsKey($e.Name)) {
        $p = $gpuPrev[$e.Name]; $dt = $t - $p[1]
        if ($dt -gt 0) { $u = 100 * ($v - $p[0]) / $dt; if ($u -gt 0.05) { [void]$busy.Add(@{ n = [string]$e.Name; u = [math]::Round($u, 1) }) } }
      }
    }
    $gpuPrev = $nowGpu
    $r.gpuCount = $g.Count
    $r.gpu = @($busy)
  } catch { $r.gpuError = $_.Exception.Message }
  if ($line -like '*volumes*') {
    try {
      $v = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -Property DeviceID,VolumeName,Size,FreeSpace)
      $r.volumes = @($v | ForEach-Object { @{ id = [string]$_.DeviceID; label = [string]$_.VolumeName; size = [double]$_.Size; free = [double]$_.FreeSpace } })
    } catch { $r.volumesError = $_.Exception.Message }
  }
  if ($primed) { $out.WriteLine(($r | ConvertTo-Json -Compress -Depth 5)) } else { $primed = $true }
}
`

export function powershellPath(): string {
  const root = process.env.SystemRoot || process.env.windir
  return root ? path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
}

export type PerfWorkerOptions = { logger?: Logger; spawnFn?: typeof spawn; platform?: NodeJS.Platform }

export function createPerfWorker(options: PerfWorkerOptions = {}): PerfProvider {
  const logger = options.logger ?? nullLogger
  const spawnFn = options.spawnFn ?? spawn
  const platform = options.platform ?? process.platform
  let child: ChildProcess | null = null
  let buffer = ''
  let pending: { resolve(value: unknown): void; reject(error: Error): void } | null = null

  const fail = (error: Error) => { const current = pending; pending = null; current?.reject(error) }

  const ensure = (): ChildProcess => {
    if (child && child.exitCode === null && !child.killed) return child
    const encoded = Buffer.from(PERF_SCRIPT, 'utf16le').toString('base64')
    const spawned = spawnFn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    })
    buffer = ''
    spawned.stdout?.setEncoding('utf8')
    spawned.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 1_000_000) { buffer = ''; fail(new Error('Performance worker output too large')); return }
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        const current = pending
        pending = null
        try { current?.resolve(JSON.parse(line)) } catch (error) { current?.reject(error as Error) }
      }
    })
    spawned.stdin?.on('error', () => undefined) // EPIPE after the worker exits is handled via 'exit'
    spawned.on('error', error => { logger.warn('Performance worker could not start', error); if (child === spawned) child = null; fail(error) })
    spawned.on('exit', code => { if (child === spawned) child = null; fail(new Error(`Performance worker exited (${code})`)) })
    child = spawned
    return spawned
  }

  return {
    sample(includeVolumes: boolean) {
      if (platform !== 'win32') return Promise.reject(new Error('Hardware counters need Windows'))
      if (pending) return Promise.reject(new Error('A sample is already in progress'))
      return new Promise<unknown>((resolve, reject) => {
        try {
          const worker = ensure()
          pending = { resolve, reject }
          worker.stdin?.write(includeVolumes ? 'sample volumes\n' : 'sample\n')
        } catch (error) { pending = null; reject(error as Error) }
      })
    },
    dispose() {
      const current = child
      child = null
      fail(new Error('Performance worker stopped'))
      try { current?.stdin?.end(); current?.kill() } catch { /* already exited */ }
    },
  }
}
