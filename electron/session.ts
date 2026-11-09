import fs from 'node:fs'
import path from 'node:path'

type SessionFile = { pid: number; startedAt: number; clean: boolean; relaunches: number[] }

/**
 * Crash sentinel. A marker is written at start and flipped on a clean exit, so the next launch
 * knows whether the previous session ended unexpectedly. It also remembers recent self-relaunches
 * so crash recovery can never turn into a restart loop. Two tiny writes per run, nothing else.
 */
export class SessionSentinel {
  private state: SessionFile = { pid: 0, startedAt: 0, clean: true, relaunches: [] }
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  begin(pid: number): { previousCrashed: boolean; previousStartedAt?: number } {
    const previous = this.read()
    this.state = { pid, startedAt: this.now(), clean: false, relaunches: previous?.relaunches ?? [] }
    this.write()
    return previous && !previous.clean ? { previousCrashed: true, previousStartedAt: previous.startedAt } : { previousCrashed: false }
  }

  end() { this.state = { ...this.state, clean: true }; this.write() }

  canRelaunch(max = 3, windowMs = 10 * 60_000): boolean {
    const now = this.now()
    return this.state.relaunches.filter(time => now - time < windowMs).length < max
  }

  recordRelaunch() {
    const now = this.now()
    this.state = { ...this.state, relaunches: [...this.state.relaunches.filter(time => now - time < 60 * 60_000), now] }
    this.write()
  }

  private read(): SessionFile | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SessionFile>
      if (typeof value.clean !== 'boolean') return null
      return { pid: Number(value.pid) || 0, startedAt: Number(value.startedAt) || 0, clean: value.clean, relaunches: Array.isArray(value.relaunches) ? value.relaunches.filter(item => Number.isFinite(item)) : [] }
    } catch { return null }
  }

  private write() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.state), 'utf8') } catch { /* diagnostics only */ }
  }
}
