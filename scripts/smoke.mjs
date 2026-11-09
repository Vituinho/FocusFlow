// Real-app smoke check. Launches FocusFlow (dev build via Electron, or a packaged exe) with an isolated, temporary data folder
// and asks it to report on itself: tray icon, windows, hardware sampling, optional startup registration and crash recovery.
//
//   node scripts/smoke.mjs                       dev build (run `npm run build` first)
//   node scripts/smoke.mjs <path-to-exe>         packaged app (win-unpacked\FocusFlow.exe or the portable exe)
//   options: --hidden (simulate a start with Windows) --startup (toggle the Run registration and restore it) --crash (kill the widget renderer)
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flags = new Set(args.filter(arg => arg.startsWith('--')))
const exeArg = args.find(arg => !arg.startsWith('--'))
const require = createRequire(import.meta.url)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

const command = exeArg ? resolve(exeArg) : require('electron')
const commandArgs = exeArg ? [] : [root]
if (flags.has('--hidden')) commandArgs.push('--hidden')

const work = mkdtempSync(join(tmpdir(), 'focusflow-smoke-'))
const reportPath = join(work, 'report.json')
const userData = join(work, 'userdata')
if (process.env.SMOKE_SEED_V1) writeFileSync(join(work, 'seed.json'), readFileSync(process.env.SMOKE_SEED_V1))
const env = { ...process.env, FOCUSFLOW_SMOKE: reportPath, FOCUSFLOW_USER_DATA: userData }
if (flags.has('--startup')) env.FOCUSFLOW_SMOKE_STARTUP = '1'
if (flags.has('--crash')) env.FOCUSFLOW_SMOKE_CRASH = '1'
if (process.env.SMOKE_SHOTS) env.FOCUSFLOW_SMOKE_SHOTS = process.env.SMOKE_SHOTS
delete env.ELECTRON_RUN_AS_NODE
if (process.env.SMOKE_SEED_V1) {
  const { mkdirSync, copyFileSync } = await import('node:fs')
  mkdirSync(userData, { recursive: true })
  copyFileSync(join(work, 'seed.json'), join(userData, 'focusflow.json'))
}

console.log(`Launching ${command} ${commandArgs.join(' ')}`)
const child = spawn(command, commandArgs, { env, stdio: 'ignore', windowsHide: false })
const exited = new Promise(done => child.on('exit', code => done(code)))
const timeout = new Promise(done => setTimeout(() => done('timeout'), 90_000))
const result = await Promise.race([exited, timeout])
if (result === 'timeout') { child.kill(); console.error('FAIL: smoke run timed out'); process.exit(2) }

if (!existsSync(reportPath)) { console.error(`FAIL: no report written (exit code ${result})`); process.exit(2) }
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
console.log(JSON.stringify(report, null, 2))

const checks = [
  ['no runtime error', !report.error],
  ['tray created', report.tray?.created === true],
  ['tray icon is not empty', report.tray?.icon?.empty === false],
  ['tray icon source is a real file (not the fallback)', report.tray?.icon?.source && report.tray.icon.source !== 'fallback'],
  ['dashboard window exists', !!report.windows?.dashboard],
  ['widget window exists', !!report.windows?.widget],
  ['data version 2', report.dataVersion === 2],
  ['Saturday enabled and agenda ends at 12:00', report.settings?.workingDays?.includes(6) && report.saturdayAgenda?.at(-1)?.includes('-12:00')],
  ['hardware sampled (cpu present)', typeof report.hardware?.cpu === 'number'],
  ['hardware ram present', typeof report.hardware?.ram?.percent === 'number'],
]
if (flags.has('--hidden')) checks.push(['dashboard hidden on a start with Windows', report.windows?.dashboard?.visible === false])
else checks.push(['dashboard visible on a normal start', report.windows?.dashboard?.visible === true])
if (flags.has('--startup')) checks.push(['startup registration toggles', report.startup?.enabled?.enabled === true && report.startup?.after?.enabled === false])
if (flags.has('--crash')) checks.push(['widget renderer recovered after a crash', report.crashRecovery?.reloadedAfterCrash === true && report.crashRecovery?.stillAlive === true])

let failed = 0
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++ }
if (failed) console.log(`Data and logs kept for inspection: ${userData}`)
else { try { rmSync(work, { recursive: true, force: true }) } catch { /* temp folder cleanup is best effort */ } }
process.exit(failed ? 1 : 0)
