import { execFile } from 'node:child_process'

export type ProcessInfo = { pid: number; path: string; version: string; commandLine: string }

export type OwnIdentity = { pid: number; exeName: string; version: string }

/** Numeric, segment-wise comparison ("1.0.0.0" < "1.1.0"). Unknown parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(part => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference) return Math.sign(difference)
  }
  return 0
}

const baseName = (path: string) => path.split(/[\\/]/).pop()?.toLowerCase() ?? ''

/**
 * Main processes of an OLDER build of this same executable. A single-instance lock held by one of them makes the new build exit
 * silently (the old one just opens its own window), which looks to the user like "the new version does nothing".
 */
export function findOlderInstances(processes: ProcessInfo[], own: OwnIdentity): ProcessInfo[] {
  return processes.filter(candidate =>
    candidate.pid !== own.pid &&
    !/--type=/.test(candidate.commandLine) &&
    baseName(candidate.path) === own.exeName.toLowerCase() &&
    compareVersions(candidate.version, own.version) < 0)
}

/** Lists running FocusFlow*.exe main processes with their file versions (one short PowerShell call). */
export function listFocusFlowProcesses(): Promise<ProcessInfo[]> {
  const script = `Get-CimInstance Win32_Process -Filter "Name LIKE 'FocusFlow%'" | ForEach-Object { $v = ''; try { $v = (Get-Item -LiteralPath $_.ExecutablePath).VersionInfo.ProductVersion } catch {}; [string]$_.ProcessId + '|' + $v + '|' + $_.ExecutablePath + '|' + $_.CommandLine }`
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (error) { resolve([]); return }
      resolve(String(stdout).split(/\r?\n/).flatMap(line => {
        const [pid, version, path, ...rest] = line.trim().split('|')
        return pid && Number.isFinite(Number(pid)) && path ? [{ pid: Number(pid), version: version ?? '', path, commandLine: rest.join('|') }] : []
      }))
    })
  })
}

export type TakeoverDeps = {
  own: OwnIdentity
  list(): Promise<ProcessInfo[]>
  /** Asks the user. Only an explicit yes lets the newer build close the older one. */
  confirm(older: ProcessInfo[]): Promise<boolean>
  kill(pid: number): Promise<void>
  /** Resolves true when every pid is gone. */
  waitForExit(pids: number[]): Promise<boolean>
  relaunch(): void
  log(message: string): void
}

export type TakeoverOutcome = 'none' | 'declined' | 'replaced' | 'failed'

/**
 * Called by a build that could not get the single-instance lock. If the holder is an older FocusFlow, offers (with consent) to close it
 * and start this version instead; never touches anything without the user's yes.
 */
export async function offerTakeover(deps: TakeoverDeps): Promise<TakeoverOutcome> {
  const older = findOlderInstances(await deps.list(), deps.own)
  if (!older.length) return 'none'
  deps.log(`Older instance(s) hold the single-instance lock: ${older.map(item => `pid ${item.pid} v${item.version} ${item.path}`).join('; ')}`)
  if (!(await deps.confirm(older))) { deps.log('User declined to close the older version'); return 'declined' }
  try { for (const item of older) await deps.kill(item.pid) } catch (error) { deps.log(`Could not close the older version: ${error instanceof Error ? error.message : String(error)}`); return 'failed' }
  if (!(await deps.waitForExit(older.map(item => item.pid)))) { deps.log('The older version did not exit in time'); return 'failed' }
  deps.log('Older version closed; relaunching this version')
  deps.relaunch()
  return 'replaced'
}
