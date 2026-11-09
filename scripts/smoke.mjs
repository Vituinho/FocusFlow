// Real-app smoke check. Launches FocusFlow (dev build via Electron, or a packaged exe) with an isolated, temporary data folder
// and asks it to report on itself: tray icon, windows, hardware sampling, optional startup registration and crash recovery.
//
//   node scripts/smoke.mjs                       dev build (run `npm run build` first)
//   node scripts/smoke.mjs <path-to-exe>         packaged app (win-unpacked\FocusFlow.exe or the portable exe)
//
// Scenario flags (combine freely):
//   --hidden          simulate a start with Windows (--hidden argument)
//   --hidden-all      start hidden AND with the widget hidden: nothing visible, hardware sampler must stay off
//   --startup         toggle the Run registration (isolated AppUserModelID) and restore it
//   --startup-keep    leave the isolated registration enabled (for uninstall tests)
//   --crash           kill the widget renderer and expect bounded recovery
//   --dpi=N           force a device scale factor of N (simulates a DPI scaling change; windows must still fit the work area)
//   --offscreen       seed window bounds far outside every display (as after unplugging a monitor)
//   --stall=SECONDS   suspend the main process for SECONDS from outside (like sleep/resume) and check stall handling
//   --soak=SECONDS    bounded stress loop (hide/show, settings, hardware toggles, worker kills) with CPU/RAM/timer sampling
//   --double          launch a second instance against the same data and prove it exits without touching focusflow.json
//   --real-userdata   do not override the data folder (use only for name-isolated test installs)
// Environment: SMOKE_SEED_V1=<json file> seeds focusflow.json, SMOKE_SHOTS=<dir> writes screenshots, SMOKE_KEEP=1 keeps the temp folder,
// SMOKE_REPORT=<file> copies the JSON report there.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flags = new Set(args.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]))
const flagValue = name => args.find(arg => arg.startsWith(`${name}=`))?.split('=')[1]
const exeArg = args.find(arg => !arg.startsWith('--'))
const require = createRequire(import.meta.url)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sleep = ms => new Promise(done => setTimeout(done, ms))

const command = exeArg ? resolve(exeArg) : require('electron')
const commandArgs = exeArg ? [] : [root]
if (flags.has('--hidden') || flags.has('--hidden-all')) commandArgs.push('--hidden')
const dpi = flagValue('--dpi')
if (dpi) commandArgs.push(`--force-device-scale-factor=${dpi}`)

const work = mkdtempSync(join(tmpdir(), 'focusflow-smoke-'))
const reportPath = join(work, 'report.json')
const userData = join(work, 'userdata')
const dataFile = join(userData, 'focusflow.json')
const soakSeconds = Number(flagValue('--soak') || 0)
const stallSeconds = Number(flagValue('--stall') || 0)

// Seed the data file (optionally from a real 1.0.x file) and apply scenario tweaks.
let seed = process.env.SMOKE_SEED_V1 ? JSON.parse(readFileSync(process.env.SMOKE_SEED_V1, 'utf8')) : null
if (flags.has('--hidden-all') || flags.has('--offscreen')) {
  seed = seed ?? { version: 2, schedules: undefined }
  if (flags.has('--hidden-all')) seed.widgetVisible = false
  if (flags.has('--offscreen')) { seed.widgetBounds = { x: 9000, y: 9000, width: 310, height: 220 }; seed.dashboardBounds = { x: -7000, y: 5000, width: 1220, height: 820 } }
  if (seed.version === 2 && !seed.schedules) seed = { ...seed, version: undefined } // keep it a partial file: missing fields fall back to defaults
}
if (seed) { mkdirSync(userData, { recursive: true }); writeFileSync(dataFile, JSON.stringify(seed, null, 2)) }

const env = { ...process.env, FOCUSFLOW_SMOKE: reportPath }
if (!flags.has('--real-userdata')) env.FOCUSFLOW_USER_DATA = userData
if (flags.has('--startup')) env.FOCUSFLOW_SMOKE_STARTUP = '1'
if (flags.has('--startup-keep')) env.FOCUSFLOW_SMOKE_STARTUP = 'keep'
if (flags.has('--crash')) env.FOCUSFLOW_SMOKE_CRASH = '1'
if (flags.has('--hidden-all')) env.FOCUSFLOW_SMOKE_EXPECT_HIDDEN = '1'
if (stallSeconds) env.FOCUSFLOW_SMOKE_STALL = String(stallSeconds)
if (soakSeconds) env.FOCUSFLOW_SMOKE_SOAK = String(soakSeconds)
if (process.env.SMOKE_SHOTS) env.FOCUSFLOW_SMOKE_SHOTS = process.env.SMOKE_SHOTS
delete env.ELECTRON_RUN_AS_NODE

const sha = file => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
const checks = []
const check = (name, ok) => checks.push([name, !!ok])

const SUSPEND = `Add-Type -Namespace N -Name P -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);'; $p = [Diagnostics.Process]::GetProcessById(PID); [N.P]::NtSuspendProcess($p.Handle) | Out-Null; Start-Sleep -Seconds SECS; [N.P]::NtResumeProcess($p.Handle) | Out-Null`

console.log(`Launching ${command} ${commandArgs.join(' ')}`)
const child = spawn(command, commandArgs, { env, stdio: 'ignore', windowsHide: false })
const exited = new Promise(done => child.on('exit', code => done(code)))
const timeoutMs = 90_000 + (soakSeconds + stallSeconds) * 1000
const timeout = new Promise(done => setTimeout(() => done('timeout'), timeoutMs))

const sideTasks = []
if (stallSeconds) sideTasks.push((async () => {
  await sleep(9000)
  const script = SUSPEND.replace('PID', String(child.pid)).replace('SECS', String(stallSeconds))
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
})())

let doubleInfo = null
if (flags.has('--double')) sideTasks.push((async () => {
  await sleep(12_000)
  const before = sha(dataFile)
  const second = spawn(command, commandArgs, { env: { ...env, FOCUSFLOW_SMOKE: '' }, stdio: 'ignore' })
  const started = Date.now()
  const code = await Promise.race([new Promise(done => second.on('exit', c => done(c))), sleep(30_000).then(() => 'timeout')])
  if (code === 'timeout') second.kill()
  await sleep(1500)
  doubleInfo = { secondExit: code, secondMs: Date.now() - started, hashBefore: before, hashAfter: sha(dataFile), firstAlive: child.exitCode === null }
})())

const result = await Promise.race([exited, timeout])
await Promise.allSettled(sideTasks)
if (result === 'timeout') { child.kill(); console.error('FAIL: smoke run timed out'); console.log(`Data and logs kept: ${userData}`); process.exit(2) }

if (!existsSync(reportPath)) { console.error(`FAIL: no report written (exit code ${result})`); console.log(`Data and logs kept: ${userData}`); process.exit(2) }
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
if (process.env.SMOKE_REPORT) copyFileSync(reportPath, process.env.SMOKE_REPORT)
console.log(JSON.stringify(report, (key, value) => key === 'samples' ? `[${value.length} samples]` : value, 2))

const hiddenAll = flags.has('--hidden-all')
check('no runtime error', !report.error)
check('tray created', report.tray?.created === true)
check('tray icon is not empty', report.tray?.icon?.empty === false)
check('tray icon source is a real file (not the fallback)', report.tray?.icon?.source && report.tray.icon.source !== 'fallback')
check('dashboard window exists', !!report.windows?.dashboard)
check('widget window exists', !!report.windows?.widget)
check('data version 2', report.dataVersion === 2)
check('Saturday enabled and agenda ends at 12:00', report.settings?.workingDays?.includes(6) && report.saturdayAgenda?.at(-1)?.includes('-12:00'))
check('exited cleanly (exit code 0)', result === 0)
if (hiddenAll) {
  check('nothing visible with dashboard and widget hidden', report.windows?.dashboard?.visible === false && report.windows?.widget?.visible === false)
  check('hardware sampler is off and no PowerShell worker exists while hidden', report.hardwareRunning === false && report.hardwareWorkers === 0)
  check('scheduling timer keeps ticking while hidden', (report.stats?.ticks ?? 0) >= 5)
} else {
  check('hardware sampled (cpu present)', typeof report.hardware?.cpu === 'number')
  check('hardware ram present', typeof report.hardware?.ram?.percent === 'number')
  check('at most one hardware worker', (report.hardwareWorkers ?? 9) <= 1)
  if (flags.has('--hidden')) check('dashboard hidden on a start with Windows', report.windows?.dashboard?.visible === false)
  else check('dashboard visible on a normal start', report.windows?.dashboard?.visible === true)
}
if (dpi) { check(`dashboard fits the work area at scale factor ${dpi}`, report.displays?.dashboardInsideWorkArea === true); check(`widget fits the work area at scale factor ${dpi}`, report.displays?.widgetInsideWorkArea === true) }
if (flags.has('--offscreen')) { check('dashboard moved back inside a display work area', report.displays?.dashboardInsideWorkArea === true); check('widget moved back inside a display work area', report.displays?.widgetInsideWorkArea === true) }
if (flags.has('--startup')) check('startup registration toggles', report.startup?.enabled?.enabled === true && report.startup?.after?.enabled === false)
if (flags.has('--startup-keep')) check('startup registration enabled and left in place', report.startup?.enabled?.enabled === true)
if (flags.has('--crash')) check('widget renderer recovered after a crash', report.crashRecovery?.reloadedAfterCrash === true && report.crashRecovery?.stillAlive === true)
if (stallSeconds) { check('stall detected by the timer gap logic', (report.stall?.stalls ?? 0) >= 1); check('no notification burst after the stall', (report.stall?.notifications ?? 99) <= 1) }
if (doubleInfo) {
  console.log('double launch:', JSON.stringify(doubleInfo))
  check('second instance exited by itself', doubleInfo.secondExit === 0 && doubleInfo.secondMs < 20_000)
  check('first instance still running', doubleInfo.firstAlive)
  check('focusflow.json untouched by the second launch', doubleInfo.hashBefore && doubleInfo.hashBefore === doubleInfo.hashAfter)
}
if (process.env.SMOKE_SEED_V1 && !flags.has('--real-userdata') && !hiddenAll) {
  check('v1 original kept as a migration backup', report.migrationFiles?.some(name => name.includes('.v1.') && name.endsWith('.bak.json')))
}
if (report.soak) {
  const soak = report.soak
  check('soak: no logged errors', soak.errors.length === 0)
  check('soak: never more than 2 windows', soak.maxWindows <= 2)
  check('soak: never more than one hardware worker', soak.maxWorkerProcesses <= 1)
  check('soak: scheduling ticks kept pace (>= 95 %)', soak.ticks.total >= soak.ticks.expected * 0.95)
  check('soak: working set growth under 60 MB', soak.memory.lateWorkingSetMB - soak.memory.earlyWorkingSetMB < 60)
  check('soak: main heap growth under 25 MB', soak.memory.lateHeapMB - soak.memory.earlyHeapMB < 25)
  check('soak: timer count stable (max - min <= 12)', soak.timers.max - soak.timers.min <= 12)
  check('soak: hardware monitor running at the end', soak.hardwareRunningAtEnd === true)
}

let failed = 0
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++ }
if (failed || process.env.SMOKE_KEEP) console.log(`Data and logs kept for inspection: ${userData}`)
else { try { rmSync(work, { recursive: true, force: true }) } catch { /* temp folder cleanup is best effort */ } }
process.exit(failed ? 1 : 0)
