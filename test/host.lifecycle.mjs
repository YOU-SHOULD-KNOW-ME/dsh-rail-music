/** Real capture: fast activation, terminal SSE, and rapid-unload process cleanup. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { apply, EVENTS_PATH } from '../lib/index.js'

const pythonPath = process.env.RAIL_MUSIC_PYTHON ?? 'python'
const launchers = new Set([process.pid])
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const mount = async () => {
  const routes = new Map()
  let dispose
  const at = performance.now()
  await apply({
    effect: fn => { dispose = fn(); return Promise.resolve(dispose) },
    on: () => () => {},
    logger: { info() {} },
    connection: { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } } },
  }, { pythonPath })
  const applyMs = performance.now() - at
  const statusRoute = routes.get('/api/rail-music/status')
  const status = () => statusRoute.fetch(new Request('http://test/api/rail-music/status')).json()
  return { routes, dispose, applyMs, status }
}

const first = await mount()
assert.ok(first.applyMs < 250, `Host apply ${first.applyMs}ms`)
const stream = first.routes.get(EVENTS_PATH).fetch(new Request('http://test/events'))
const reader = stream.body.getReader()
const decoder = new TextDecoder()
const began = performance.now()
let pending = reader.read(), live = false
while (performance.now() - began < 5000) {
  const chunk = await Promise.race([pending, wait(100).then(() => null)])
  if (!chunk) continue
  if (chunk.done) break
  const text = decoder.decode(chunk.value)
  const data = text.split('\n').find(line => line.startsWith('data: '))
  if (data && JSON.parse(data.slice(6)).bands.length > 0) { live = true; break }
  pending = reader.read()
}
assert.ok(live, 'real helper must produce a frame')
launchers.add((await first.status()).pid)
const coldMs = performance.now() - began
const beforeOff = performance.now()
first.dispose()
const offMs = performance.now() - beforeOff
assert.ok(offMs < 100, `Host dispose ${offMs}ms`)
assert.equal(first.routes.size, 0)
let shutdown = false
for (;;) {
  const chunk = await reader.read()
  if (chunk.done) break
  shutdown ||= decoder.decode(chunk.value).includes('event: shutdown')
}
assert.ok(shutdown, 'existing SSE must receive terminal event')
console.log(`PASS Host apply ${first.applyMs.toFixed(1)}ms; first real frame ${coldMs.toFixed(1)}ms; dispose ${offMs.toFixed(1)}ms`)

for (let i = 0; i < 8; i++) {
  const cycle = await mount()
  await wait(10)
  const status = await cycle.status()
  if (status.pid) launchers.add(status.pid)
  cycle.dispose()
}
await wait(2500)
if (process.platform === 'win32') {
  const parents = [...launchers].filter(Number.isInteger).join(',')
  const remaining = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `$ownedParents = @(${parents}); Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.ParentProcessId -in $ownedParents } | Select-Object -ExpandProperty ProcessId`],
  { encoding: 'utf8', windowsHide: true }).trim()
  assert.equal(remaining, '', `test-owned Python processes remain: ${remaining}`)
  console.log('PASS eight rapid unloads leave no test-owned venv launcher or Python process')
}
