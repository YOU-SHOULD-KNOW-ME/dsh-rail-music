/** Protocol checks: bounded SSE, abort cleanup and safe option defaults. */
import assert from 'node:assert/strict'
import { eventStream, resolveOptions, apply, CONFIG_GLOBAL } from '../lib/index.js'

const options = resolveOptions({ fps: 'oops', bands: 9.7, rate: Infinity, depth: NaN, barWidth: 500 })
assert.equal(options.fps, 80)
assert.equal(options.bands, 10)
assert.equal(options.rate, 48000)
assert.equal(options.depth, .7)
assert.equal(options.barWidth, 72)
assert.equal(resolveOptions({ profile: 'responsive' }).window, 1024)
assert.equal(resolveOptions({ profile: 'responsive' }).fps, 100)
assert.equal(resolveOptions().startDelayMs, 0)
assert.equal(resolveOptions({ device: 104 }).device, '104')
console.log('PASS invalid config safely defaults; profile selects window and hop')

const subscribers = new Set()
const stopListeners = new Set()
const capture = {
  frame: { n: 0 },
  subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
  onStop(fn) { stopListeners.add(fn); return () => stopListeners.delete(fn) },
}
const abort = new AbortController()
const response = eventStream(capture, new Request('http://test/events', { signal: abort.signal }))
for (let n = 1; n <= 10000; n++) for (const fn of subscribers) fn({ n })
const reader = response.body.getReader()
const decoder = new TextDecoder()
const first = decoder.decode((await reader.read()).value)
const latest = decoder.decode((await reader.read()).value)
assert.ok(first.includes('retry: 1000'))
assert.ok(latest.includes('"n":10000'), latest)
console.log('PASS slow consumer receives latest pending frame, not 10000-frame backlog')
abort.abort()
assert.equal(subscribers.size, 0)
assert.equal(stopListeners.size, 0)
assert.equal((await reader.read()).done, true)
console.log('PASS abort closes stream and removes subscriber')

const cancelled = eventStream(capture, new Request('http://test/events'))
await cancelled.body.cancel()
assert.equal(subscribers.size, 0)
const alreadyAborted = new AbortController()
alreadyAborted.abort()
const closed = eventStream(capture, new Request('http://test/events', { signal: alreadyAborted.signal }))
assert.equal(subscribers.size, 0)
assert.equal((await closed.body.getReader().read()).done, true)
console.log('PASS cancellation and pre-aborted requests leave no subscriber')

const stopped = eventStream(capture, new Request('http://test/events'))
const stoppedReader = stopped.body.getReader()
await stoppedReader.read()
for (const notify of [...stopListeners]) notify()
assert.ok(decoder.decode((await stoppedReader.read()).value).includes('event: shutdown'))
assert.equal((await stoppedReader.read()).done, true)
assert.equal(subscribers.size, 0)
assert.equal(stopListeners.size, 0)
console.log('PASS host shutdown immediately notifies and closes existing SSE')

let dispose, inject
const routes = new Map()
await apply({
  effect: fn => { dispose = fn(); return Promise.resolve(dispose) },
  on: (name, fn) => { inject = fn; return () => {} },
  logger: { info() {} },
  connection: { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } } },
}, { startDelayMs: 60000, barWidth: 44, theme: 'ember', profile: 'responsive' })
const rows = []
inject(rows)
const config = rows.find(row => row.name === CONFIG_GLOBAL).value
assert.equal(config.barWidth, 44)
assert.equal(config.theme, 'ember')
assert.equal(config.profile, 'responsive')
assert.equal(rows.some(row => row.kind === 'script-src'), false)
dispose()
assert.equal(routes.size, 0)
console.log('PASS browser config injection and route disposal')
