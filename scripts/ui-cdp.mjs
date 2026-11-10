// Asks a running FocusFlow (started with --remote-debugging-port) where a button is on screen, so a real mouse click can be sent to it.
//   node scripts/ui-cdp.mjs <port> <button text>   ->  {"x":..,"y":..,"dpr":..}   (screen coordinates in device pixels)
const [port, text] = process.argv.slice(2)
const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(target => target.type === 'page' && !target.url.includes('window=widget'))
if (!targets.length) { console.log('{"error":"no dashboard page"}'); process.exit(1) }
const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
const expression = `(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim().startsWith(${JSON.stringify(text)})); if (!b) return null; const r = b.getBoundingClientRect(); const dpr = window.devicePixelRatio; return { x: Math.round((window.screenX + r.left + r.width / 2) * dpr), y: Math.round((window.screenY + r.top + r.height / 2) * dpr), dpr, visible: document.visibilityState } })()`
const result = await new Promise(done => { socket.onmessage = event => done(JSON.parse(event.data)); socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })) })
console.log(JSON.stringify(result.result?.result?.value ?? { error: 'button not found' }))
socket.close()
