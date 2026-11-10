// CPU / memory benchmark of the real app (dev build or packaged exe) with CDP renderer metrics.
//   node scripts/bench.mjs [exe] [--seconds=30] [--out=file.json] [--experiment=no-transitions|no-timer-rerender]
// Launches an isolated instance (own data folder), keeps its windows above others so occlusion throttling does not hide the cost,
// then measures three conditions: dashboard + widget visible, widget only, both hidden. For each it reports per-process-type CPU
// (% of one core, from OS process times) and, for each page, Chrome DevTools Performance metrics per second (style recalculations,
// layouts, script and task time, JS heap). Nothing is invented: every number comes from the OS or from Chromium.
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = name => args.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1]
const exeArg = args.find(arg => !arg.startsWith('--'))
const seconds = Number(flag('seconds') || 30)
const port = 9300 + Math.floor(Math.random() * 500)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const command = exeArg ? resolve(exeArg) : require('electron')
const commandArgs = exeArg ? [] : [root]
const sleep = ms => new Promise(done => setTimeout(done, ms))
const helper = join(root, 'scripts', 'bench-win.ps1')
const work = mkdtempSync(join(tmpdir(), 'focusflow-bench-'))

const win = (mode, pid, which = '') => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', mode, '-MainPid', String(pid), ...(which ? ['-Which', which] : [])], { encoding: 'utf8' }).stdout
const tree = pid => win('tree', pid).split(/\r?\n/).filter(Boolean).map(line => { const [id, type, cpu, ws] = line.split('|'); return { id: Number(id), type, cpu: Number(cpu), ws: Number(ws) } })

async function cdp(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
  let next = 1; const waiting = new Map()
  socket.onmessage = event => { const message = JSON.parse(event.data); waiting.get(message.id)?.(message); waiting.delete(message.id) }
  const send = (method, params = {}) => new Promise(done => { const id = next++; waiting.set(id, done); socket.send(JSON.stringify({ id, method, params })) })
  await send('Performance.enable')
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map(metric => [metric.name, metric.value]))
  const evaluate = expression => send('Runtime.evaluate', { expression })
  return { metrics, evaluate, close: () => socket.close() }
}

const env = { ...process.env, FOCUSFLOW_USER_DATA: join(work, 'userdata') }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(command, [...commandArgs, `--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
let result
try {
  await sleep(14_000)
  win('topmost', app.pid)
  let targets = []
  for (let attempt = 0; attempt < 30 && targets.length < 2; attempt++) {
    try { targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(target => target.type === 'page') } catch { /* not ready */ }
    if (targets.length < 2) await sleep(1000)
  }
  const pages = []
  for (const target of targets) pages.push({ kind: target.url.includes('window=widget') ? 'widget' : 'dashboard', client: await cdp(target) })

  // Diagnostic experiments (not used in normal runs): change one suspected factor at runtime and see what the metrics do.
  const experiment = flag('experiment')
  if (experiment === 'no-transitions') for (const page of pages) await page.client.evaluate("document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '*,*::before,*::after{transition:none!important;animation:none!important}' }))")
  async function phase(label) {
    await sleep(4000) // settle after the visibility change
    const before = tree(app.pid), metricsBefore = await Promise.all(pages.map(page => page.client.metrics())), started = Date.now()
    await sleep(seconds * 1000)
    const elapsed = (Date.now() - started) / 1000
    const after = tree(app.pid), metricsAfter = await Promise.all(pages.map(page => page.client.metrics()))
    const byType = {}
    for (const process of after) {
      const prior = before.find(item => item.id === process.id)
      if (!prior) continue
      const entry = (byType[process.type] ??= { cpuPercentOfOneCore: 0, workingSetMB: 0, processes: 0 })
      entry.cpuPercentOfOneCore += 100 * (process.cpu - prior.cpu) / elapsed
      entry.workingSetMB += process.ws; entry.processes++
    }
    for (const entry of Object.values(byType)) entry.cpuPercentOfOneCore = +entry.cpuPercentOfOneCore.toFixed(1)
    const perPage = pages.map((page, index) => {
      const a = metricsBefore[index], b = metricsAfter[index], rate = key => +(((b[key] ?? 0) - (a[key] ?? 0)) / elapsed).toFixed(2)
      return { page: page.kind, recalcStylePerSec: rate('RecalcStyleCount'), layoutPerSec: rate('LayoutCount'), taskMsPerSec: +(rate('TaskDuration') * 1000).toFixed(1), scriptMsPerSec: +(rate('ScriptDuration') * 1000).toFixed(1), layoutMsPerSec: +(rate('LayoutDuration') * 1000).toFixed(1), styleMsPerSec: +(rate('RecalcStyleDuration') * 1000).toFixed(1), jsHeapMB: +((b.JSHeapUsedSize ?? 0) / 1048576).toFixed(1) }
    })
    const total = +Object.values(byType).reduce((sum, entry) => sum + entry.cpuPercentOfOneCore, 0).toFixed(1)
    return { label, seconds: Math.round(elapsed), totalCpuPercentOfOneCore: total, byType, perPage }
  }

  result = { exe: command, seconds, phases: [] }
  win('show', app.pid, 'dashboard'); win('show', app.pid, 'widget')
  result.phases.push(await phase('dashboard + widget visible'))
  win('hide', app.pid, 'dashboard')
  result.phases.push(await phase('widget only'))
  win('hide', app.pid, 'widget')
  result.phases.push(await phase('both hidden'))
  win('show', app.pid, 'dashboard'); win('show', app.pid, 'widget')
  for (const page of pages) page.client.close()
} finally {
  try { spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }) } catch { /* gone */ }
  try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
}
const text = JSON.stringify(result, null, 2)
console.log(text)
if (flag('out')) writeFileSync(flag('out'), text)
