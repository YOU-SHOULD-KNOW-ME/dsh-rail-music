/**
 * Soak test.
 *
 * Runs the real plugin for a while and samples its status once a second, so a
 * crash loop shows up as a restarting helper instead of hiding behind a single
 * moment's snapshot. Prints every state change with the problem text.
 *
 *   node test/soak.mjs [--python <path>] [--seconds 60] [--log <file>]
 */
import { apply, EVENTS_PATH, CLIENT_PATH } from '../lib/index.js'

const argv = process.argv.slice(2)
const flag = (key, fallback) => {
  const at = argv.indexOf(`--${key}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const pythonPath = flag('python', process.env.RAIL_MUSIC_PYTHON ?? 'python')
const seconds = Number(flag('seconds', '60'))
const logFile = flag('log', null)

const routes = new Map()
const ctx = {
  effect: fn => Promise.resolve(fn()),
  on: () => () => {},
  logger: { info: () => {}, error: () => {} },
  connection: { fetch: { register: (r) => { routes.set(r.path, r); return () => { routes.delete(r.path) } } } },
}

await apply(ctx, { pythonPath, startDelayMs: 100, logFile })

const statusOf = async () => (await routes.get('/api/rail-music/status')
  .fetch(new Request('http://host/api/rail-music/status'))).json()

let previous = null
let restarts = 0
let liveSeconds = 0
let maxFrames = 0
const problems = new Set()

console.log(`soaking for ${seconds}s (python ${pythonPath}${logFile ? `, log ${logFile}` : ''})`)
for (let i = 0; i < seconds; i++) {
  await new Promise(resolve => setTimeout(resolve, 1_000))
  const status = await statusOf()
  maxFrames = Math.max(maxFrames, status.frames)
  if (status.problem !== null) problems.add(status.problem)

  // Frames is cumulative, so use the explicit lifetime restart counter.
  restarts = status.restarts
  if (previous !== null && status.restarts > previous.restarts) {
    console.log(`  [${i}s] RESTART  count=${status.restarts} problem=${status.problem}`)
  } else if (previous === null || status.running !== previous.running) {
    console.log(`  [${i}s] running=${status.running} frames=${status.frames} problem=${status.problem}`)
  }
  if (status.running && status.fresh) liveSeconds += 1
  previous = status
}

const final = await statusOf()
console.log(`\nfinal: ${JSON.stringify(final)}`)
console.log(`frames at peak: ${maxFrames} | seconds with fresh frames: ${liveSeconds}/${seconds} | restarts: ${restarts}`)
if (problems.size > 0) console.log(`problems seen:\n  ${[...problems].join('\n  ')}`)

const checks = [
  ['helper stayed up for the whole soak', restarts === 0],
  ['frames kept flowing', liveSeconds >= seconds * 0.8],
  ['no problem reported', problems.size === 0],
]
console.log('\n--- verdict ---')
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
