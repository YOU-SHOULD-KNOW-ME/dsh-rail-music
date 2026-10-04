/**
 * Host-half smoke test.
 *
 * Exercises the real plugin module against a minimal stand-in for the cordis
 * context: it captures the three registered Fetch routes and the
 * `webserver/index-inject` row, starts the real Python helper, and reads live
 * frames off the SSE response. This is what proves the Host half before any
 * DSH restart.
 *
 *   node test/host.smoke.mjs [--python <path>] [--seconds 6]
 */
import { apply, name, inject, EVENTS_PATH, CLIENT_PATH, CONFIG_GLOBAL } from '../lib/index.js'

const argv = process.argv.slice(2)
const flag = (key, fallback) => {
  const at = argv.indexOf(`--${key}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const pythonPath = flag('python', process.env.RAIL_MUSIC_PYTHON ?? 'python')
const seconds = Number(flag('seconds', '6'))
const profile = flag('profile', 'balanced')

const routes = new Map()
const injected = []
let disposed = false
let injectHandler = null

const ctx = {
  effect: (fn) => { const dispose = fn(); return Promise.resolve(dispose) },
  on: (event, handler) => {
    if (event !== 'webserver/index-inject') throw new Error(`unexpected event ${event}`)
    injectHandler = handler
    return () => { injectHandler = null }
  },
  logger: { info: () => {}, error: () => {} },
  connection: {
    fetch: {
      register: (route) => {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => { routes.delete(route.path); disposed = true }
      },
    },
  },
}

console.log(`plugin name: ${name}   inject: ${JSON.stringify(inject)}`)
await apply(ctx, { pythonPath, startDelayMs: 200, profile })

// ---- routes registered --------------------------------------------------
const expected = [EVENTS_PATH, CLIENT_PATH, '/api/rail-music/status']
for (const path of expected) {
  if (!routes.has(path)) throw new Error(`route not registered: ${path}`)
}
console.log(`routes: ${[...routes.keys()].join(', ')}`)

// Every route must sit under /api/ — the exact-Fetch registry enforces it, and
// that prefix is also what makes the injected script tag authenticated.
for (const path of routes.keys()) {
  if (!path.startsWith('/api/')) throw new Error(`route outside /api/: ${path}`)
}

// ---- index injection ----------------------------------------------------
injectHandler(injected)
const globalRow = injected.find(row => row.kind === 'global')
const scriptRow = injected.find(row => row.kind === 'script-src')
console.log(`injected: global=${globalRow?.name} script-src=${scriptRow?.src} placement=${scriptRow?.placement}`)
if (globalRow?.name !== CONFIG_GLOBAL) throw new Error('config global row missing')
if (scriptRow !== undefined) throw new Error('native client must not also be injected as a script')

// ---- the client script is served ---------------------------------------
const clientResponse = await routes.get(CLIENT_PATH).fetch(new Request(`http://host${CLIENT_PATH}`))
const clientBody = await clientResponse.text()
console.log(`client.js: ${clientResponse.status} ${clientResponse.headers.get('content-type')} ${clientBody.length} bytes`)
if (!clientBody.includes('__DSH_RAIL_MUSIC__')) throw new Error('client.js does not read the injected config')

// ---- live SSE -----------------------------------------------------------
const controller = new AbortController()
const response = await routes.get(EVENTS_PATH).fetch(
  new Request(`http://host${EVENTS_PATH}`, { signal: controller.signal }),
)
console.log(`events: ${response.status} ${response.headers.get('content-type')}`)
if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
  throw new Error('events route is not an event stream')
}

const frames = []
const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const deadline = Date.now() + seconds * 1000
let sawIdle = false
let sawLive = false
let pendingRead = reader.read()

while (Date.now() < deadline) {
  const chunk = await Promise.race([
    pendingRead,
    new Promise(resolve => setTimeout(() => resolve(null), 500)),
  ])
  if (chunk === null) continue
  if (chunk.done) break
  pendingRead = reader.read()
  buffer += decoder.decode(chunk.value, { stream: true })
  let split
  while ((split = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, split)
    buffer = buffer.slice(split + 2)
    const line = block.split('\n').find(entry => entry.startsWith('data: '))
    if (line === undefined) continue
    const frame = JSON.parse(line.slice(6))
    frames.push(frame)
    if (frame.idle) sawIdle = true
    else sawLive = true
  }
}

controller.abort()
const status = await (await routes.get('/api/rail-music/status').fetch(
  new Request('http://host/api/rail-music/status'),
)).json()

console.log(`\nframes received: ${frames.length} in ${seconds}s (~${(frames.length / seconds).toFixed(1)}/s)`)
console.log(`host status: ${JSON.stringify(status)}`)
const sample = frames.filter(frame => !frame.idle).at(-1) ?? frames.at(-1)
if (sample !== undefined) {
  console.log(`sample frame: rms=${sample.rms} peak=${sample.peak} beat=${sample.beat} bands=${sample.bands.length}`)
}
console.log(`saw idle frame: ${sawIdle} | saw live frame: ${sawLive}`)

// ---- teardown -----------------------------------------------------------
await ctx.effect(() => () => {}) // no-op keeps the shape honest
console.log('\n--- verdict ---')
const checks = [
  ['three /api routes registered', expected.every(path => routes.has(path))],
  ['index injection carries defaults without duplicating native client', globalRow?.name === CONFIG_GLOBAL && scriptRow === undefined],
  ['client.js served and reads injected config', clientBody.includes('__DSH_RAIL_MUSIC__')],
  ['event stream is text/event-stream', response.headers.get('content-type')?.startsWith('text/event-stream') === true],
  ['frames flow at ~analysis rate', frames.length >= seconds * 20],
  ['frames carry bands', (sample?.bands?.length ?? 0) >= 3],
  ['capture helper is alive', status.running === true],
  ['no helper problem reported', status.problem === null],
]
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
if (status.problem !== null) console.log(`  problem: ${status.problem}`)
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
