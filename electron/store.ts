import fs from 'node:fs'
import path from 'node:path'
import { Logger, nullLogger } from './logger'

export type LoadResult =
  | { source: 'none'; raw: null; quarantined?: string }
  | { source: 'primary' | 'backup'; raw: unknown; quarantined?: string }

export type StoreOptions = {
  directory: string
  fileName?: string
  logger?: Logger
  now?: () => number
  /** Delay used to coalesce bursts of writes (window moves, rapid edits). */
  debounceMs?: number
}

const RENAME_RETRIES = 5

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * JSON persistence with atomic replace, a last-known-good backup, corrupt-file quarantine
 * and coalesced writes that are skipped when nothing changed.
 */
export class JsonStore {
  readonly file: string
  private readonly directory: string
  private readonly logger: Logger
  private readonly now: () => number
  private readonly debounceMs: number
  private pending: (() => unknown) | null = null
  private timer: NodeJS.Timeout | undefined
  private lastWritten: string | null = null
  writes = 0

  constructor(options: StoreOptions) {
    this.directory = options.directory
    this.file = path.join(options.directory, options.fileName ?? 'focusflow.json')
    this.logger = options.logger ?? nullLogger
    this.now = options.now ?? Date.now
    this.debounceMs = options.debounceMs ?? 400
  }

  get backupFile() { return `${this.file}.bak` }

  load(): LoadResult {
    const primary = this.tryRead(this.file)
    if (primary.ok) {
      this.lastWritten = primary.text
      return { source: 'primary', raw: primary.value }
    }
    if (primary.missing) {
      const backup = this.tryRead(this.backupFile)
      if (backup.ok) {
        this.logger.warn('focusflow.json missing; restored from backup')
        return { source: 'backup', raw: backup.value }
      }
      return { source: 'none', raw: null }
    }
    // The file exists but cannot be parsed: never overwrite it silently.
    const quarantined = this.quarantine()
    this.logger.error('focusflow.json is corrupt', primary.error)
    const backup = this.tryRead(this.backupFile)
    if (backup.ok) {
      this.logger.warn('Recovered configuration from focusflow.json.bak')
      return { source: 'backup', raw: backup.value, quarantined }
    }
    return { source: 'none', raw: null, quarantined }
  }

  /** Copies the current primary file once so the next crash during a save cannot lose the last good state. */
  refreshBackup() {
    try {
      if (fs.existsSync(this.file) && this.tryRead(this.file).ok) fs.copyFileSync(this.file, this.backupFile)
    } catch (error) { this.logger.warn('Could not refresh configuration backup', error) }
  }

  /** Keeps a permanent copy of the pre-migration file. */
  backupForMigration(label: string): string | null {
    try {
      if (!fs.existsSync(this.file)) return null
      const target = path.join(this.directory, `focusflow.${label}.${this.now()}.bak.json`)
      fs.copyFileSync(this.file, target)
      this.pruneBackups(`focusflow.${label}.`, 5)
      return target
    } catch (error) {
      this.logger.warn('Could not back up configuration before migration', error)
      return null
    }
  }

  schedule(getter: () => unknown) {
    this.pending = getter
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, this.debounceMs)
  }

  /** Writes immediately (synchronously). Safe to call at quit. */
  flush(): boolean {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    const getter = this.pending
    if (!getter) return true
    this.pending = null
    return this.writeNow(getter())
  }

  writeNow(value: unknown): boolean {
    let text: string
    try { text = JSON.stringify(value, null, 2) } catch (error) { this.logger.error('Configuration is not serializable', error); return false }
    if (text === this.lastWritten) return true
    const temp = `${this.file}.tmp`
    try {
      fs.mkdirSync(this.directory, { recursive: true })
      const fd = fs.openSync(temp, 'w')
      try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      this.replace(temp)
      this.lastWritten = text
      this.writes++
      return true
    } catch (error) {
      this.logger.error('Could not save focusflow.json', error)
      try { fs.rmSync(temp, { force: true }) } catch { /* ignore */ }
      return false
    }
  }

  dispose() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.pending = null }

  private replace(temp: string) {
    let lastError: unknown
    for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
      try { fs.renameSync(temp, this.file); return } catch (error) {
        lastError = error
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
        sleepSync(20 * (attempt + 1)) // antivirus/indexers may briefly lock the target on Windows
      }
    }
    throw lastError
  }

  private tryRead(file: string): { ok: true; value: unknown; text: string } | { ok: false; missing: boolean; error?: unknown } {
    let text: string
    try { text = fs.readFileSync(file, 'utf8') } catch (error) {
      return { ok: false, missing: (error as NodeJS.ErrnoException).code === 'ENOENT', error }
    }
    try { return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')), text } } catch (error) { return { ok: false, missing: false, error } }
  }

  private quarantine(): string | undefined {
    try {
      const target = path.join(this.directory, `focusflow.corrupt.${this.now()}.json`)
      fs.renameSync(this.file, target)
      this.pruneBackups('focusflow.corrupt.', 3)
      return target
    } catch (error) { this.logger.warn('Could not quarantine corrupt configuration', error); return undefined }
  }

  private pruneBackups(prefix: string, keep: number) {
    try {
      const names = fs.readdirSync(this.directory).filter(name => name.startsWith(prefix)).sort()
      for (const name of names.slice(0, Math.max(0, names.length - keep))) fs.rmSync(path.join(this.directory, name), { force: true })
    } catch { /* best effort */ }
  }
}
