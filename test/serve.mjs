/**
 * Full-stack test server.
 *
 * Mounts the plugin's real Fetch routes on a plain Node HTTP server and serves
 * the rail harness from the same origin, with the `__DSH_RAIL_MUSIC__`
 * global and the compatibility script route. It does not provide DSH's module
 * loader; native browser activation is covered by client.lifecycle.mjs. This reproduces
 * same-origin SSE, authenticated-by-nothing local route, host-driven script
 * injection — without needing a DSH restart.
 *
 *   node test/serve.mjs [--python <path>] [--port 8791] [--harness <file>]
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { apply, EVENTS_PATH, CLIENT_PATH, CONFIG_GLOBAL } from '../lib/index.js'

const argv = process.argv.slice(2)
const flag = (key, fallback) => {
  const at = argv.indexOf(`--${key}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const pythonPath = flag('python', process.env.RAIL_MUSIC_PYTHON ?? 'python')
const port = Number(flag('port', '8791'))
const harnessPath = flag('harness', fileURLToPath(new URL('../harness.html', import.meta.url)))

const routes = new Map()
const ctx = {
  effect: fn => Promise.resolve(fn()),
  on: () => () => {},
  logger: { info: () => {}, error: () => {} },
  connection: {
    fetch: {
      register: (route) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  },
}

await apply(ctx, { pythonPath, startDelayMs: 100 })

const harness = await readFile(harnessPath, 'utf8')
/**
 * Supply host defaults and load the standalone compatibility script. The harness itself
 * carries no script tag, so this is a plain insertion rather than a rewrite of
 * a placeholder — the same shape the real `webserver/index-inject` produces.
 */
const injected = `<script>globalThis.${CONFIG_GLOBAL} = ${JSON.stringify({ eventsPath: EVENTS_PATH, depth: 0.7, version: '0.3.0', barWidth: 32 })}</script>`
  + `<script src="${CLIENT_PATH}"></script>`
const hosted = harness.replace('</body>', `${injected}</body>`)
if (hosted === harness) throw new Error('harness has no </body> to inject before')

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(hosted)
    return
  }

  // The harness is a bare page; browsers still ask for this and a 404 would
  // show up as a page error in the verifier.
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }

  const route = routes.get(url.pathname)
  if (route === undefined || !route.methods.includes(req.method ?? 'GET')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }

  // The Host's bridge aborts the handler signal when the client disconnects;
  // the SSE route relies on that to release its subscriber. A route handler may
  // answer with a Response or a Promise of one, so both are awaited here.
  const abort = new AbortController()
  // IncomingMessage 'close' can fire when the GET request finishes parsing;
  // the outgoing response is what stays open for SSE.
  res.on('close', () => { abort.abort() })

  void (async () => {
    try {
      const response = await route.fetch(new Request(url, { method: req.method, signal: abort.signal }))
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body === null) { res.end(); return }
      Readable.fromWeb(response.body).pipe(res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(String(error))
    }
  })()
}).listen(port, '127.0.0.1', () => {
  console.log(`rail-music test server on http://127.0.0.1:${port}/  (routes: ${[...routes.keys()].join(', ')})`)
})
