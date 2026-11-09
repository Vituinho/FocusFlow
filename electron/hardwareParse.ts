import { clampPercent, HardwareVolume } from './hardwareTypes'

export type CpuTimes = { idle: number; total: number }

/** Sums os.cpus() times across all logical processors (system-wide, not this process). */
export function sumCpuTimes(cpus: { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]): CpuTimes {
  let idle = 0, total = 0
  for (const { times } of cpus) {
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

export function cpuPercent(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (!previous) return null
  const total = current.total - previous.total, idle = current.idle - previous.idle
  if (!(total > 0) || idle < 0) return null
  return clampPercent((1 - idle / total) * 100)
}

export type GpuReading = { supported: boolean; percent: number | null; adapters: { id: string; percent: number }[] }

const GPU_NAME = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)_engtype_(\w+)/i

/**
 * Aggregates "GPU Engine" counter instances the way Task Manager does: utilisation of one engine is the
 * sum over all processes using it; an adapter's utilisation is its busiest engine; the headline value is the
 * busiest adapter. Idle instances may be omitted by the sampler (`totalInstances` tells us counters exist).
 */
export function aggregateGpu(instances: { name: string; value: number }[], totalInstances: number): GpuReading {
  if (!(totalInstances > 0)) return { supported: false, percent: null, adapters: [] }
  const engines = new Map<string, { adapter: string; sum: number }>()
  let parsed = 0
  for (const { name, value } of instances) {
    const match = GPU_NAME.exec(name)
    if (!match || !Number.isFinite(value) || value < 0) continue
    parsed++
    const adapter = `${match[1].toLowerCase()}_${match[2]}`
    const key = `${adapter}|${match[3]}|${match[4].toLowerCase()}`
    engines.set(key, { adapter, sum: (engines.get(key)?.sum ?? 0) + value })
  }
  if (instances.length > 0 && parsed === 0) return { supported: false, percent: null, adapters: [] }
  const perAdapter = new Map<string, number>()
  for (const { adapter, sum } of engines.values()) perAdapter.set(adapter, Math.max(perAdapter.get(adapter) ?? 0, sum))
  const adapters = [...perAdapter.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, percent], index) => ({ id: `GPU ${index}`, percent: clampPercent(percent) ?? 0 }))
  return { supported: true, percent: adapters.length ? Math.max(...adapters.map(item => item.percent)) : 0, adapters }
}

export type PerfSample = {
  diskPercent: number | null
  gpu: GpuReading
  volumes?: HardwareVolume[]
  errors: string[]
}

/** Validates one JSON line from the Windows performance-counter worker. Throws on malformed input. */
export function parsePerfSample(raw: unknown): PerfSample {
  if (!raw || typeof raw !== 'object') throw new Error('Performance sample is not an object')
  const value = raw as Record<string, unknown>
  const errors: string[] = []
  if (typeof value.diskError === 'string') errors.push('Disk activity counter unavailable')
  if (typeof value.gpuError === 'string') errors.push('GPU counters unavailable')
  if (typeof value.volumesError === 'string') errors.push('Drive list unavailable')

  const list = Array.isArray(value.gpu) ? value.gpu : value.gpu && typeof value.gpu === 'object' ? [value.gpu] : []
  const instances = list.flatMap((item: any) => typeof item?.n === 'string' && typeof item?.u === 'number' ? [{ name: item.n, value: item.u }] : [])
  const gpu = typeof value.gpuError === 'string' ? { supported: false, percent: null, adapters: [] } : aggregateGpu(instances, typeof value.gpuCount === 'number' ? value.gpuCount : 0)
  if (!gpu.supported && !errors.includes('GPU counters unavailable')) errors.push('GPU counters unavailable')

  let volumes: HardwareVolume[] | undefined
  if (value.volumes !== undefined && value.volumes !== null) {
    const entries = Array.isArray(value.volumes) ? value.volumes : [value.volumes]
    volumes = entries.slice(0, 26).flatMap((item: any): HardwareVolume[] => {
      const id = typeof item?.id === 'string' ? item.id.toUpperCase() : ''
      if (!/^[A-Z]:$/.test(id)) return []
      const size = typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0 ? item.size : null
      const free = typeof item.free === 'number' && Number.isFinite(item.free) && item.free >= 0 ? item.free : null
      const ok = size !== null && free !== null && free <= size
      return [{ id, label: typeof item.label === 'string' ? item.label : '', usedBytes: ok ? size - free : null, totalBytes: ok ? size : null }]
    })
  }
  return { diskPercent: clampPercent(value.disk), gpu, volumes, errors }
}
