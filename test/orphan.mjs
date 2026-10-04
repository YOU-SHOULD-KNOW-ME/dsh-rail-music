/**
 * Orphan check.
 *
 * The Host never writes to the helper's stdin, so the helper treats stdin EOF
 * as "the Host is gone" and exits. This proves it: start a Host, confirm the
 * helper is running, SIGKILL the Host the way a crashed dsh would, and confirm
 * the helper is gone too rather than lingering and holding a WASAPI session.
 *
 *   node test/orphan.mjs [--python <path>]
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const flag = (key, fallback) => {
  const at = argv.indexOf(`--${key}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const pythonPath = flag('python', process.env.RAIL_MUSIC_PYTHON ?? 'python')
const HERE = fileURLToPath(new URL('.', import.meta.url))
// The Host stand-in is a separate process, so it needs a URL, not a path.
const PLUGIN_URL = new URL('../lib/index.js', import.meta.url).href

/** Helpers currently alive, matched on the script path. */
function helpers() {
  const script = `
    Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
      Where-Object { $_.CommandLine -like '*capture.py*' } |
      ForEach-Object { $_.ProcessId }
  `
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  })
  return out.split(/\s+/).filter(Boolean).map(Number)
}

const before = helpers()
console.log(`helpers before: ${before.length}${before.length > 0 ? ` (pids ${before.join(', ')} — ignored)` : ''}`)

// A Host stand-in: same spawn shape the plugin uses, so the same stdin pipe.
// The plugin unrefs its own timers (correct under a server that holds the loop
// open), so this bare process needs its own keep-alive or it would exit before
// the deferred start ever fires.
const host = spawn(process.execPath, [
  '-e',
  `setInterval(() => {}, 1000)
   import(${JSON.stringify(PLUGIN_URL)}).then(async (m) => {
     const routes = new Map()
     await m.apply({
       effect: (fn) => Promise.resolve(fn()),
       on: () => () => {},
       logger: { info: () => {}, error: () => {} },
       connection: { fetch: { register: (r) => { routes.set(r.path, r); return () => {} } } },
     }, { pythonPath: ${JSON.stringify(pythonPath)}, startDelayMs: 100 })
     console.error('host stand-in: plugin applied')
   }).catch((error) => { console.error('host stand-in failed:', error); process.exit(3) })`,
], { stdio: ['pipe', 'pipe', 'pipe'] })

host.stderr.on('data', (chunk) => process.stderr.write(chunk))

await new Promise(resolve => setTimeout(resolve, 4_000))
// Only helpers this host started count; anything already running belongs to
// another owner and would make the check meaningless.
const during = helpers().filter(pid => !before.includes(pid))
console.log(`helpers started by this host: ${during.length}`)
if (during.length === 0) {
  console.error('FAIL: helper never started, so the orphan check proves nothing')
  host.kill('SIGKILL')
  process.exit(1)
}

// Hard kill: no disposer runs, exactly like a crashed dsh.
host.kill('SIGKILL')
console.log('host SIGKILLed (no disposer ran)')

let after = during
for (let attempt = 0; attempt < 20 && after.length > 0; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 250))
  after = helpers().filter(pid => during.includes(pid))
}
console.log(`helpers surviving after 5s: ${after.length}`)

const checks = [
  ['helper started under the host', during.length > 0],
  ['helper exited when the host was killed', after.length === 0],
]
console.log('\n--- verdict ---')
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
if (after.length > 0) {
  console.log(`  leaked pids: ${after.join(', ')}`)
  for (const pid of after) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
