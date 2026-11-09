// One shared AudioContext with an explicit lifecycle: created on demand, resumed if suspended, re-created if it was closed,
// released after a period of inactivity and on page unload.

export type AudioContextLike = {
  state: string
  currentTime: number
  destination: unknown
  resume(): Promise<void>
  close(): Promise<void>
  createOscillator(): { type: string; frequency: { value: number }; connect(node: unknown): void; start(): void; stop(when?: number): void }
  createGain(): { gain: { setValueAtTime(value: number, time: number): void; exponentialRampToValueAtTime(value: number, time: number): void }; connect(node: unknown): void }
}

export type ChimePlayer = { play(): Promise<boolean>; dispose(): void; readonly isOpen: boolean }

export function createChimePlayer(factory: () => AudioContextLike, idleMs = 30_000, timers: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }): ChimePlayer {
  let context: AudioContextLike | null = null
  let idle: unknown

  const dispose = () => {
    if (idle) timers.clear(idle)
    idle = undefined
    const current = context
    context = null
    if (current && current.state !== 'closed') void current.close().catch(() => undefined)
  }

  return {
    get isOpen() { return !!context && context.state !== 'closed' },
    dispose,
    async play() {
      try {
        if (!context || context.state === 'closed') context = factory()
        const active = context
        if (active.state === 'suspended') await active.resume()
        const oscillator = active.createOscillator()
        const gain = active.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.value = 660
        gain.gain.setValueAtTime(0.0001, active.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.065, active.currentTime + 0.025)
        gain.gain.exponentialRampToValueAtTime(0.0001, active.currentTime + 0.38)
        oscillator.connect(gain)
        gain.connect(active.destination)
        oscillator.start()
        oscillator.stop(active.currentTime + 0.4)
        if (idle) timers.clear(idle)
        idle = timers.set(dispose, idleMs)
        return true
      } catch {
        // Audio is optional (no output device, policy). Drop the context so the next attempt starts clean.
        dispose()
        return false
      }
    },
  }
}

let shared: ChimePlayer | null = null

export function playChime(): Promise<boolean> {
  if (!shared) {
    shared = createChimePlayer(() => new AudioContext() as unknown as AudioContextLike)
    window.addEventListener('pagehide', () => shared?.dispose())
  }
  return shared.play()
}
