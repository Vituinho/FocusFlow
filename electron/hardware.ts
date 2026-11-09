import { EventEmitter } from 'node:events'
import { cpuPercent, CpuTimes, parsePerfSample, PerfSample } from './hardwareParse'
import { clampPercent, EMPTY_HARDWARE, HardwareSnapshot, HardwareStatus, HardwareVolume } from './hardwareTypes'
import { Logger, nullLogger } from './logger'

/** Source of Windows performance-counter data (disk activity, GPU engines, drive list). */
export type PerfProvider = {
  sample(includeVolumes: boolean): Promise<unknown>
  dispose(): void
}

export type HardwareDeps = {
  provider: PerfProvider
  readCpuTimes(): CpuTimes
  readMemory(): { total: number; free: number }
  /** Used when the performance provider cannot list drives. */
  readSystemVolume?(): Promise<HardwareVolume | null>
  logger?: Logger
  now?: () => number
  intervalMs?: number
  timeoutMs?: number
}

const VOLUME_REFRESH_EVERY = 15
const MAX_FAILURES_BEFORE_UNAVAILABLE = 5

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)
    promise.then(value => { clearTimeout(handle); resolve(value) }, error => { clearTimeout(handle); reject(error) })
  })
}

/**
 * Samples system-wide CPU, physical RAM, GPU and disk activity without ever blocking the main thread:
 * CPU/RAM come from cheap synchronous OS counters, everything else from one asynchronous provider call.
 * Samples never overlap, failures back off, and N/D (null) is reported instead of invented numbers.
 */
export class HardwareMonitor extends EventEmitter {
  private running = false
  private generation = 0
  private timer: NodeJS.Timeout | undefined
  private failures = 0
  private sampleCount = 0
  private previousCpu: CpuTimes | null = null
  private cachedVolumes: HardwareVolume[] = []
  private readonly knownVolumes = new Map<string, string>()
  private current: HardwareSnapshot = EMPTY_HARDWARE
  private readonly logger: Logger
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private lastFailureMessage = ''

  constructor(private readonly deps: HardwareDeps) {
    super()
    this.logger = deps.logger ?? nullLogger
    this.now = deps.now ?? Date.now
    this.intervalMs = Math.min(5000, Math.max(2000, deps.intervalMs ?? 3000))
    this.timeoutMs = deps.timeoutMs ?? 8000
  }

  get isRunning() { return this.running }
  latest(): HardwareSnapshot { return this.current }

  start() {
    if (this.running) return
    this.running = true
    this.generation++
    this.failures = 0
    this.sampleCount = 0
    this.previousCpu = this.deps.readCpuTimes()
    this.publish({ ...EMPTY_HARDWARE, status: 'starting', timestamp: this.now() })
    this.schedule(1000, this.generation)
  }

  stop() {
    if (!this.running && this.current.status === 'off') return
    this.running = false
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    try { this.deps.provider.dispose() } catch { /* already gone */ }
    this.publish({ ...EMPTY_HARDWARE, timestamp: this.now() })
  }

  /** Manual retry from the UI after the provider was marked unavailable. */
  retry() {
    if (!this.running) return
    this.failures = 0
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.schedule(0, this.generation)
  }

  private schedule(delay: number, generation: number) {
    this.timer = setTimeout(() => { void this.tick(generation) }, delay)
    this.timer.unref?.()
  }

  private nextDelay(): number {
    if (this.failures === 0) return this.intervalMs
    if (this.failures >= MAX_FAILURES_BEFORE_UNAVAILABLE) return 5 * 60_000
    return Math.min(60_000, this.intervalMs * 2 ** this.failures)
  }

  private async tick(generation: number) {
    if (!this.running || generation !== this.generation) return
    let cpu: number | null = null
    let ram: HardwareSnapshot['ram'] = { percent: null, usedBytes: null, totalBytes: null }
    const notes: string[] = []
    try {
      const times = this.deps.readCpuTimes()
      cpu = cpuPercent(this.previousCpu, times)
      this.previousCpu = times
    } catch (error) { this.logger.warn('CPU sampling failed', error); notes.push('CPU unavailable') }
    try {
      const { total, free } = this.deps.readMemory()
      if (total > 0 && free >= 0 && free <= total) ram = { percent: clampPercent((1 - free / total) * 100), usedBytes: total - free, totalBytes: total }
      else notes.push('RAM unavailable')
    } catch (error) { this.logger.warn('Memory sampling failed', error); notes.push('RAM unavailable') }

    let perf: PerfSample | null = null
    try {
      const raw = await withTimeout(this.deps.provider.sample(this.sampleCount % VOLUME_REFRESH_EVERY === 0), this.timeoutMs)
      if (!this.running || generation !== this.generation) return
      perf = parsePerfSample(raw)
      this.failures = 0
      this.lastFailureMessage = ''
    } catch (error) {
      if (!this.running || generation !== this.generation) return
      this.failures++
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.lastFailureMessage || this.failures === MAX_FAILURES_BEFORE_UNAVAILABLE) this.logger.warn(`Hardware provider failed (${this.failures}x): ${message}`)
      this.lastFailureMessage = message
      try { this.deps.provider.dispose() } catch { /* respawned on next sample */ }
    }
    this.sampleCount++

    if (perf?.volumes) this.rememberVolumes(perf.volumes)
    else if (!perf && this.cachedVolumes.length === 0 && this.deps.readSystemVolume) {
      try { const volume = await this.deps.readSystemVolume(); if (volume) this.rememberVolumes([volume]) } catch { /* N/D */ }
      if (!this.running || generation !== this.generation) return
    }

    let status: HardwareStatus
    if (!perf) { notes.push('Disk and GPU counters are unavailable'); status = this.failures >= MAX_FAILURES_BEFORE_UNAVAILABLE ? 'unavailable' : 'degraded' }
    else { notes.push(...perf.errors); status = perf.diskPercent === null ? 'degraded' : 'ok' }

    this.publish({
      timestamp: this.now(), status, cpu, ram,
      gpu: { percent: perf?.gpu.percent ?? null, adapters: perf?.gpu.adapters ?? [] },
      disk: { activityPercent: perf?.diskPercent ?? null, volumes: this.volumeList() },
      notes: [...new Set(notes)],
    })
    this.schedule(this.nextDelay(), generation)
  }

  private rememberVolumes(volumes: HardwareVolume[]) {
    this.cachedVolumes = volumes
    for (const volume of volumes) this.knownVolumes.set(volume.id, volume.label)
  }

  /** Drives seen earlier but missing now are reported as N/D rather than silently dropped or reused. */
  private volumeList(): HardwareVolume[] {
    const present = new Map(this.cachedVolumes.map(volume => [volume.id, volume]))
    const list = [...this.knownVolumes.keys()].sort().map(id => present.get(id) ?? { id, label: this.knownVolumes.get(id) ?? '', usedBytes: null, totalBytes: null })
    return list
  }

  private publish(snapshot: HardwareSnapshot) {
    this.current = snapshot
    this.emit('update', snapshot)
  }
}
