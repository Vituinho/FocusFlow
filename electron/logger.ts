import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

export type Logger = {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
  /** Most recent warnings/errors kept in memory for the status panel. */
  recent(): LogEntry[]
  readonly directory: string
}

export type LogEntry = { time: string; level: LogLevel; message: string }

export type LoggerOptions = {
  directory: string
  fileName?: string
  maxBytes?: number
  maxFiles?: number
  now?: () => Date
  keepRecent?: number
}

function describe(detail: unknown): string {
  if (detail === undefined) return ''
  if (detail instanceof Error) return ` | ${detail.name}: ${detail.message}${detail.stack ? `\n${detail.stack}` : ''}`
  try { return ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` } catch { return ' | [unserializable]' }
}

/**
 * Small local-only rotating log. Writes are synchronous appends because events are rare
 * (lifecycle, recovery, errors) and must survive a crash right after being recorded.
 */
export function createLogger(options: LoggerOptions): Logger {
  const { directory, fileName = 'focusflow.log', maxBytes = 512 * 1024, maxFiles = 3, keepRecent = 20 } = options
  const now = options.now ?? (() => new Date())
  const file = path.join(directory, fileName)
  const recent: LogEntry[] = []
  let size = -1
  let broken = false

  const rotate = () => {
    for (let index = maxFiles - 1; index >= 1; index--) {
      const from = index === 1 ? file : `${file}.${index - 1}`
      const to = `${file}.${index}`
      try { if (fs.existsSync(from)) fs.renameSync(from, to) } catch { /* rotation is best effort */ }
    }
    size = 0
  }

  const write = (level: LogLevel, message: string, detail?: unknown) => {
    const time = now().toISOString()
    if (level !== 'info') {
      recent.push({ time, level, message })
      if (recent.length > keepRecent) recent.shift()
    }
    if (broken) return
    try {
      if (size < 0) {
        fs.mkdirSync(directory, { recursive: true })
        size = fs.existsSync(file) ? fs.statSync(file).size : 0
      }
      const line = `${time} ${level.toUpperCase().padEnd(5)} ${message}${describe(detail)}\n`
      if (size + line.length > maxBytes) rotate()
      fs.appendFileSync(file, line, 'utf8')
      size += Buffer.byteLength(line)
    } catch {
      // A logger must never take the app down. Stop trying if the folder is unusable.
      broken = true
    }
  }

  return {
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
    recent: () => [...recent],
    directory,
  }
}

export const nullLogger: Logger = {
  info: () => undefined, warn: () => undefined, error: () => undefined, recent: () => [], directory: '',
}
