import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HardwareMonitor, PerfProvider } from './hardware'
import { aggregateGpu, cpuPercent, parsePerfSample, sumCpuTimes } from './hardwareParse'
import { createPerfWorker } from './perfWorker'
import { formatBytes, formatPercent, validateHardwareSnapshot } from './hardwareTypes'

const gpuName = (adapter: string, engine: number, type: string, pid = 1) => `pid_${pid}_luid_0x00000000_0x0000${adapter}_phys_0_eng_${engine}_engtype_${type}`

describe('CPU sampling', () => {
  it('derives system-wide utilisation from idle and total time deltas', () => {
    const first = sumCpuTimes([{ times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 } }])
    const second = sumCpuTimes([{ times: { user: 200, nice: 0, sys: 200, idle: 900, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 1200, irq: 0 } }])
    expect(cpuPercent(first, second)).toBeCloseTo(40, 5)
  })
  it('reports N/D without a baseline or when the counters did not advance', () => {
    const times = { idle: 10, total: 100 }
    expect(cpuPercent(null, times)).toBeNull()
    expect(cpuPercent(times, times)).toBeNull()
    expect(cpuPercent(times, { idle: 5, total: 200 })).toBeNull()
  })
})

describe('GPU aggregation', () => {
  it('sums processes per engine and takes the busiest engine of each adapter', () => {
    const reading = aggregateGpu([
      { name: gpuName('A1', 0, '3D', 10), value: 30 }, { name: gpuName('A1', 0, '3D', 11), value: 25 },
      { name: gpuName('A1', 1, 'VideoDecode', 12), value: 20 },
    ], 40)
    expect(reading).toMatchObject({ supported: true, percent: 55, adapters: [{ id: 'GPU 0', percent: 55 }] })
  })
  it('keeps adapters separate and reports the busiest one', () => {
    const reading = aggregateGpu([{ name: gpuName('A1', 0, '3D'), value: 12 }, { name: gpuName('B2', 0, '3D'), value: 80 }], 10)
    expect(reading.adapters.map(item => item.percent)).toEqual([12, 80])
    expect(reading.percent).toBe(80)
  })
  it('caps at 100 and treats existing but idle counters as 0, not N/D', () => {
    expect(aggregateGpu([{ name: gpuName('A1', 0, '3D', 1), value: 90 }, { name: gpuName('A1', 0, '3D', 2), value: 90 }], 2).percent).toBe(100)
    expect(aggregateGpu([], 120)).toMatchObject({ supported: true, percent: 0 })
  })
  it('reports N/D when counters do not exist or cannot be understood', () => {
    expect(aggregateGpu([], 0)).toEqual({ supported: false, percent: null, adapters: [] })
    expect(aggregateGpu([{ name: 'something else', value: 5 }], 3).percent).toBeNull()
  })
})

describe('performance sample validation', () => {
  it('accepts a normal sample and clamps out-of-range disk activity', () => {
    const sample = parsePerfSample({ disk: 187.3, gpuCount: 4, gpu: [{ n: gpuName('A1', 0, '3D'), u: 7 }], volumes: [{ id: 'c:', label: 'OS', size: 1000, free: 250 }] })
    expect(sample.diskPercent).toBe(100)
    expect(sample.gpu.percent).toBe(7)
    expect(sample.volumes).toEqual([{ id: 'C:', label: 'OS', usedBytes: 750, totalBytes: 1000 }])
  })
  it('tolerates PowerShell collapsing single-element arrays into objects', () => {
    const sample = parsePerfSample({ disk: 1, gpuCount: 1, gpu: { n: gpuName('A1', 0, '3D'), u: 3 }, volumes: { id: 'D:', label: '', size: 10, free: 5 } })
    expect(sample.gpu.percent).toBe(3)
    expect(sample.volumes?.[0].usedBytes).toBe(5)
  })
  it('turns counter errors into N/D plus a short reason and never invents numbers', () => {
    const sample = parsePerfSample({ diskError: 'Invalid class', gpuError: 'Invalid namespace' })
    expect(sample.diskPercent).toBeNull()
    expect(sample.gpu.percent).toBeNull()
    expect(sample.errors).toEqual(['Disk activity counter unavailable', 'GPU counters unavailable'])
  })
  it('rejects malformed payloads and drops impossible volumes', () => {
    expect(() => parsePerfSample('nope')).toThrow()
    expect(() => parsePerfSample(null)).toThrow()
    const sample = parsePerfSample({ disk: 'x', volumes: [{ id: '../x', size: 1, free: 1 }, { id: 'E:', size: 5, free: 10 }, { id: 'F:', size: Number.NaN, free: 1 }] })
    expect(sample.diskPercent).toBeNull()
    expect(sample.volumes).toEqual([{ id: 'E:', label: '', usedBytes: null, totalBytes: null }, { id: 'F:', label: '', usedBytes: null, totalBytes: null }])
  })
})

describe('IPC snapshot validation', () => {
  const valid = { timestamp: 5, status: 'ok', cpu: 12.34, ram: { percent: 50, usedBytes: 8, totalBytes: 16 }, gpu: { percent: null, adapters: [] }, disk: { activityPercent: 3, volumes: [{ id: 'c:', label: 'Sys\u0000tem', usedBytes: 1, totalBytes: 2 }] }, notes: ['x'] }
  it('sanitises values coming through IPC', () => {
    const result = validateHardwareSnapshot(valid)
    expect(result?.disk.volumes[0]).toEqual({ id: 'C:', label: 'System', usedBytes: 1, totalBytes: 2 })
    expect(result?.gpu.percent).toBeNull()
  })
  it('rejects malformed snapshots and nulls out inconsistent byte counts', () => {
    expect(validateHardwareSnapshot(null)).toBeNull()
    expect(validateHardwareSnapshot({ ...valid, status: 'weird' })).toBeNull()
    expect(validateHardwareSnapshot({ ...valid, timestamp: 'now' })).toBeNull()
    expect(validateHardwareSnapshot({ ...valid, ram: { percent: 400, usedBytes: 20, totalBytes: 10 } })?.ram).toEqual({ percent: 100, usedBytes: null, totalBytes: null })
  })
  it('formats N/D and sizes', () => {
    expect(formatPercent(null)).toBe('N/D')
    expect(formatPercent(41.6)).toBe('42%')
    expect(formatBytes(null)).toBe('N/D')
    expect(formatBytes(16 * 1024 ** 3)).toBe('16.0 GB')
  })
})

describe('HardwareMonitor', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  let tickCount = 0
  const makeMonitor = (sample: PerfProvider['sample'], extra: Partial<ConstructorParameters<typeof HardwareMonitor>[0]> = {}) => {
    tickCount = 0
    const provider: PerfProvider = { sample, dispose: vi.fn() }
    const monitor = new HardwareMonitor({
      provider,
      readCpuTimes: () => { tickCount++; return { idle: tickCount * 50, total: tickCount * 100 } },
      readMemory: () => ({ total: 16e9, free: 4e9 }),
      now: () => Date.now(),
      ...extra,
    })
    return { monitor, provider }
  }
  const good = () => Promise.resolve({ disk: 20, gpuCount: 1, gpu: [{ n: gpuName('A1', 0, '3D'), u: 33 }], volumes: [{ id: 'C:', label: 'OS', size: 100, free: 40 }] })

  it('publishes system-wide CPU, RAM, GPU, disk activity and capacity separately', async () => {
    const { monitor } = makeMonitor(good)
    monitor.start()
    expect(monitor.latest().status).toBe('starting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(monitor.latest()).toMatchObject({
      status: 'ok', cpu: 50, ram: { percent: 75, usedBytes: 12e9, totalBytes: 16e9 }, gpu: { percent: 33 },
      disk: { activityPercent: 20, volumes: [{ id: 'C:', usedBytes: 60, totalBytes: 100 }] },
    })
    monitor.stop()
    expect(monitor.latest().status).toBe('off')
    expect(monitor.latest().cpu).toBeNull()
  })

  it('keeps CPU and RAM and marks disk/GPU N/D when the provider fails, then backs off and recovers', async () => {
    let fail = true
    const sample = vi.fn(() => fail ? Promise.reject(new Error('boom')) : good())
    const { monitor, provider } = makeMonitor(sample)
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    let snapshot = monitor.latest()
    expect(snapshot).toMatchObject({ status: 'degraded', cpu: 50, gpu: { percent: null }, disk: { activityPercent: null } })
    expect(snapshot.notes.join(' ')).toContain('unavailable')
    expect(provider.dispose).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000 * 2 - 1)
    expect(sample).toHaveBeenCalledTimes(1) // next attempt only after the 6 s backoff, not every tick
    fail = false
    await vi.advanceTimersByTimeAsync(10_000)
    snapshot = monitor.latest()
    expect(snapshot.status).toBe('ok')
    expect(snapshot.disk.activityPercent).toBe(20)
    monitor.stop()
  })

  it('declares the provider unavailable after repeated failures and retries only on demand or slowly', async () => {
    const sample = vi.fn(() => Promise.reject(new Error('no powershell')))
    const { monitor } = makeMonitor(sample, { intervalMs: 2000 })
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000 + 4000 + 8000 + 16_000 + 32_000)
    expect(monitor.latest().status).toBe('unavailable')
    const calls = sample.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sample.mock.calls.length).toBe(calls)
    monitor.retry()
    await vi.advanceTimersByTimeAsync(1)
    expect(sample.mock.calls.length).toBe(calls + 1)
    monitor.stop()
  })

  it('times out a hung provider instead of blocking, and never overlaps samples', async () => {
    let concurrent = 0, maxConcurrent = 0
    const sample = vi.fn(() => { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); return new Promise<unknown>(() => undefined) })
    const { monitor } = makeMonitor(sample, { timeoutMs: 500 })
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000 + 500)
    expect(monitor.latest().status).toBe('degraded')
    expect(maxConcurrent).toBe(1)
    monitor.stop()
  })

  it('shows previously seen drives as N/D after they are disconnected and falls back to the system drive', async () => {
    let drives = [{ id: 'C:', label: 'OS', size: 100, free: 50 }, { id: 'E:', label: 'USB', size: 10, free: 5 }]
    const sample = vi.fn(() => Promise.resolve({ disk: 1, gpuCount: 0, volumes: drives }))
    const { monitor } = makeMonitor(sample)
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(monitor.latest().gpu.percent).toBeNull() // GPU counters not present: N/D, not 0
    expect(monitor.latest().disk.volumes.map(volume => volume.usedBytes)).toEqual([50, 5])
    drives = [drives[0]]
    for (let index = 0; index < 15; index++) await vi.advanceTimersByTimeAsync(3000)
    expect(monitor.latest().disk.volumes).toEqual([
      { id: 'C:', label: 'OS', usedBytes: 50, totalBytes: 100 },
      { id: 'E:', label: 'USB', usedBytes: null, totalBytes: null },
    ])
    monitor.stop()

    const fallback = makeMonitor(() => Promise.reject(new Error('x')), { readSystemVolume: async () => ({ id: 'C:', label: '', usedBytes: 1, totalBytes: 2 }) })
    fallback.monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fallback.monitor.latest().disk.volumes).toEqual([{ id: 'C:', label: '', usedBytes: 1, totalBytes: 2 }])
    fallback.monitor.stop()
  })

  it('stops cleanly: no sampling after stop and the provider is released', async () => {
    const { monitor, provider } = makeMonitor(good)
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    monitor.stop()
    const calls = (provider.dispose as ReturnType<typeof vi.fn>).mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(monitor.latest().status).toBe('off')
    expect(calls).toBeGreaterThan(0)
  })
})

describe('perf worker', () => {
  it('refuses to run outside Windows', async () => {
    await expect(createPerfWorker({ platform: 'linux' }).sample(false)).rejects.toThrow(/Windows/)
  })

  it('surfaces a missing PowerShell as a rejected sample, not a crash', async () => {
    const { EventEmitter } = await import('node:events')
    const spawnFn = (() => {
      const child = new EventEmitter() as any
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => undefined
      child.stdin = Object.assign(new EventEmitter(), { write: () => { queueMicrotask(() => child.emit('error', new Error('spawn ENOENT'))) }, end: () => undefined })
      child.exitCode = null; child.killed = false; child.kill = () => undefined
      return child
    }) as any
    const worker = createPerfWorker({ platform: 'win32', spawnFn })
    await expect(worker.sample(false)).rejects.toThrow('ENOENT')
    worker.dispose()
  })

  it.runIf(process.platform === 'win32')('reads real counters from this Windows machine (GPU may legitimately be N/D)', async () => {
    const worker = createPerfWorker()
    try {
      await worker.sample(true)
      const sample = parsePerfSample(await worker.sample(true))
      expect(sample.diskPercent === null || (sample.diskPercent >= 0 && sample.diskPercent <= 100)).toBe(true)
      expect(sample.gpu.percent === null || sample.gpu.percent <= 100).toBe(true)
      expect(sample.volumes && sample.volumes.length).toBeGreaterThan(0)
    } finally { worker.dispose() }
  }, 30_000)
})
