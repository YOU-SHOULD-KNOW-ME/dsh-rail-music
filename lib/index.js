/**
 * dsh-rail-music — Host plugin
 * ============================
 *
 * Drives the Turn-navigation rail (the tick ladder on the right edge of a
 * conversation) from local system audio.
 *
 * The Host never listens on an extra socket. DSH's native client module owns
 * browser activation and teardown when the Plugins switch changes:
 *
 * 1. It spawns and supervises the loopback capture helper, reading one JSON
 *    frame per hop from the helper's **stdout**. No TCP, no port to collide
 *    with, and DSH owns the process lifetime.
 * 2. It publishes those frames as Server-Sent Events on DSH's **own** web
 *    server, through `ctx.connection.fetch` — same origin, same port, existing
 *    session cookie, no CORS.
 * 3. `dsh.client` declares the browser factory; index injection only carries
 *    initial defaults. Live activation also reads the current status route.
 *
 * Failing to find Python, or finding one without `soundcard`, degrades to a
 * plugin that serves an idle stream: the rail simply stays at rest.
 */

import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'experimental-rail-music'

/** A Web server to attach routes to, and Connection to register them through. */
export const inject = ['webServer', 'connection']

/** Route the browser half opens its EventSource against. */
export const EVENTS_PATH = '/api/rail-music/events'
/** Route serving the browser half itself. */
export const CLIENT_PATH = '/api/rail-music/client.js'
/** Global carrying host-side settings to the browser half. */
export const CONFIG_GLOBAL = '__DSH_RAIL_MUSIC__'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const HELPER = `${HERE}capture.py`
const CLIENT_FILE = `${HERE}client.js`

const RESTART_DELAY_MS = 2_000
/** A frame older than this makes the client treat the stream as idle. */
const FRAME_TTL_MS = 1_000

/**
 * Owns the capture child process and the latest frame.
 *
 * Restarts the helper on any exit with a fixed delay, because the two normal
 * causes are transient: the default render device changed, or the helper was
 * started before an audio endpoint existed. Subscribers are notified per frame
 * and never see the process details.
 */
class Capture {
  /** @param {object} options - resolved plugin configuration. */
  constructor(options) {
    this.options = options
    this.child = null
    this.latest = null
    this.subscribers = new Set()
    this.stopped = false
    /** Human-readable state for `GET /api/rail-music/status`. */
    this.problem = null
    this.restartTimer = null
    this.startedAt = Date.now()
    this.frames = 0
    this.starts = 0
    this.stopListeners = new Set()
    this.captureInfo = null
  }

  /** @returns {object} one JSON frame, or an idle placeholder before the first. */
  get frame() {
    return this.latest ?? { rms: -90, peak: -90, bands: [], beat: 0, idle: true, stale: true }
  }

  start() {
    if (this.stopped) return
    this.starts += 1
    this.captureInfo = null
    const args = ['-u', HELPER, '--rate', String(this.options.rate), '--fps', String(this.options.fps),
      '--bands', String(this.options.bands), '--window', String(this.options.window)]
    if (this.options.device) args.push('--device', this.options.device)
    if (this.options.logFile) args.push('--log', this.options.logFile)
    // Paired with stdio[0] = 'pipe' below: the helper only arms its parent
    // watch when the Host is the one holding stdin open.
    args.push('--watch-parent')
    let child
    try {
      // stdin is a pipe the Host never writes to: the helper watches it and
      // exits when it closes, so a hard-killed Host cannot leave an orphan
      // holding a WASAPI session.
      child = spawn(this.options.pythonPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      this.problem = `cannot spawn ${this.options.pythonPath}: ${error.message}`
      this.scheduleRestart()
      return
    }
    this.child = child

    child.on('error', (error) => {
      // ENOENT/EINVAL land here when the configured interpreter is wrong. A
      // failed spawn never emits 'exit', so the restart has to be scheduled
      // from here too — otherwise one bad pythonPath wedges the plugin for the
      // life of the process.
      this.problem = `cannot run ${this.options.pythonPath}: ${error.message}`
      if (this.child === child) this.child = null
      this.scheduleRestart()
    })

    createInterface({ input: child.stdout }).on('line', (line) => {
      const text = line.trim()
      if (text === '') return
      try {
        const frame = JSON.parse(text)
        if (!Number.isFinite(frame.rms) || !Array.isArray(frame.bands)
          || !frame.bands.every(Number.isFinite)) return
        this.latest = { ...frame, at: Date.now() }
        this.frames += 1
        this.problem = null
        for (const notify of this.subscribers) notify(this.latest)
      } catch {
        // A partial or corrupt line is dropped rather than killing the stream.
      }
    })

    createInterface({ input: child.stderr }).on('line', (line) => {
      const text = line.trim()
      if (text === '') return
      try {
        const report = JSON.parse(text)
        if (report.error) this.problem = String(report.error)
        else if (report.ready) {
          this.problem = null
          if (report.capture && typeof report.capture === 'object') this.captureInfo = report.capture
        }
      } catch {
        this.problem = text
      }
    })

    child.on('exit', (code, signal) => {
      this.child = null
      if (this.stopped) return
      this.problem = this.problem ?? `capture helper exited (${signal ?? code})`
      this.scheduleRestart()
    })
  }

  scheduleRestart() {
    if (this.stopped || this.restartTimer !== null) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopped) this.start()
    }, RESTART_DELAY_MS)
    this.restartTimer.unref?.()
  }

  /**
   * Subscribe to frames.
   * @param notify - called with each new frame.
   * @returns the unsubscriber.
   */
  subscribe(notify) {
    this.subscribers.add(notify)
    return () => { this.subscribers.delete(notify) }
  }

  onStop(notify) {
    this.stopListeners.add(notify)
    return () => this.stopListeners.delete(notify)
  }

  /** @returns {object} host-side facts for the status route and the log. */
  status() {
    return {
      running: this.child !== null,
      platform: process.platform,
      capture: this.captureInfo,
      pid: this.child?.pid ?? null,
      problem: this.problem,
      device: this.options.device ?? this.captureInfo?.deviceName
        ?? (process.platform === 'darwin' ? '(automatic virtual input)' : '(system default output)'),
      frames: this.frames,
      restarts: Math.max(0, this.starts - 1),
      pythonPath: this.options.pythonPath,
      uptimeMs: Date.now() - this.startedAt,
      fresh: this.latest !== null && Date.now() - this.latest.at < FRAME_TTL_MS,
      profile: this.options.profile,
      client: clientOptions(this.options),
      analysis: {
        rate: this.options.rate, fps: this.options.fps, window: this.options.window,
        hopMs: Math.round(this.options.rate / this.options.fps) / this.options.rate * 1000,
        windowMs: this.options.window / this.options.rate * 1000,
      },
    }
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    // Existing SSE responses outlive route registration; end them explicitly.
    for (const notify of this.stopListeners) {
      try { notify() } catch { /* another stream must still get its shutdown */ }
    }
    this.stopListeners.clear()
    this.subscribers.clear()
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    this.child = null
    if (child === null) return
    // EOF reaches the real interpreter even through a Windows venv launcher.
    // Shutdown is requested without blocking DSH's plugin-management request.
    child.stdin.on('error', () => { /* the helper may have already closed stdin */ })
    child.stdin.end()
    const force = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 300)
    force.unref?.()
    child.once('exit', () => { clearTimeout(force) })
  }
}

/**
 * Build the SSE response for one subscriber.
 * @param capture - the capture owner.
 * @param request - the subscribing request, whose abort ends the stream.
 * @returns a streaming `Response`.
 */
export function eventStream(capture, request) {
  const encoder = new TextEncoder()
  let unsubscribe = () => {}
  let heartbeat = null
  let pending = null
  let closed = false
  let abortHandler = () => {}
  let unsubscribeStop = () => {}
  const cleanup = () => {
    closed = true
    pending = null
    unsubscribe()
    unsubscribeStop()
    if (heartbeat !== null) clearInterval(heartbeat)
    request.signal.removeEventListener('abort', abortHandler)
  }
  const stream = new ReadableStream({
    start(controller) {
      if (request.signal.aborted) { cleanup(); controller.close(); return }
      const write = (payload) => {
        if (closed) return
        try {
          // Keep at most one queued chunk and one latest pending payload.
          // A slow consumer must see current music, not an ever-growing replay.
          if (controller.desiredSize <= 0) { pending = payload; return }
          controller.enqueue(encoder.encode(payload))
        } catch {
          cleanup()
        }
      }
      write(`retry: 1000\n\ndata: ${JSON.stringify(capture.frame)}\n\n`)
      unsubscribe = capture.subscribe((frame) => {
        write(`data: ${JSON.stringify(frame)}\n\n`)
      })
      // Keeps proxies and the reconnect logic honest during silence.
      heartbeat = setInterval(() => {
        if (pending === null && controller.desiredSize > 0) write(': keepalive\n\n')
      }, 15_000)
      heartbeat.unref?.()
      abortHandler = () => {
        cleanup()
        try { controller.close() } catch { /* already closed */ }
      }
      request.signal.addEventListener('abort', abortHandler, { once: true })
      unsubscribeStop = capture.onStop?.(() => {
        if (closed) return
        // A terminal event is never coalesced with ordinary audio frames.
        try { controller.enqueue(encoder.encode('event: shutdown\ndata: {}\n\n')) } catch { /* already closed */ }
        abortHandler()
      }) ?? (() => {})
      if (request.signal.aborted) abortHandler()
    },
    pull(controller) {
      if (pending !== null && !closed) {
        const payload = pending
        pending = null
        controller.enqueue(encoder.encode(payload))
      }
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}

/**
 * Resolve configuration, filling in the interpreter and analysis defaults.
 * @param config - raw plugin configuration.
 * @returns the resolved options.
 */
export function resolveOptions(config = {}) {
  const number = (value, fallback, min, max) => {
    const parsed = Number(value ?? fallback)
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
  }
  const profile = config.profile === 'responsive' ? 'responsive' : 'balanced'
  return {
    pythonPath: config.pythonPath ?? (process.platform === 'win32' ? 'python' : 'python3'),
    device: config.device == null || String(config.device).trim() === '' ? null : String(config.device),
    profile,
    rate: Math.round(number(config.rate, 48_000, 8_000, 192_000)),
    window: [1024, 2048, 4096].includes(Number(config.window))
      ? Number(config.window) : profile === 'responsive' ? 1024 : 2048,
    /**
     * Analysis frames per second. The helper's real rate is bounded by the hop
     * plus its own analysis cost, so this sets the hop (rate / fps) rather than
     * a hard frame count. 80 gives a 12.5 ms hop, keeping capture granularity
     * well under the point where a visualiser reads as lagging the music.
     */
    fps: number(config.fps, profile === 'responsive' ? 100 : 80, 10, 120),
    bands: Math.round(number(config.bands, 24, 3, 48)),
    depth: number(config.depth, 0.7, 0, 0.95),
    barWidth: number(config.barWidth, 32, 16, 72),
    theme: ['rainbow', 'aurora', 'ember', 'mono'].includes(config.theme) ? config.theme : 'rainbow',
    startDelayMs: number(config.startDelayMs, 0, 0, 60_000),
    /** When set, the helper appends diagnostics here — a crash loop is invisible without it. */
    logFile: typeof config.logFile === 'string' && config.logFile !== '' ? config.logFile : null,
  }
}

function clientOptions(options) {
  return { eventsPath: EVENTS_PATH, depth: options.depth, barWidth: options.barWidth,
    theme: options.theme, profile: options.profile, version: '0.3.0' }
}

/**
 * Wire the capture, the two routes, and the index injection.
 * @param ctx - owning plugin context.
 * @param config - plugin configuration.
 */
export async function apply(ctx, config) {
  const options = resolveOptions(config)
  const capture = new Capture(options)

  await ctx.effect(() => {
    // Spawn runs after route registration; Python import and device opening
    // never delay plugin activation. A failed endpoint uses the retry path.
    const startTimer = setTimeout(() => { capture.start() }, options.startDelayMs)
    startTimer.unref?.()

    const disposers = []

    disposers.push(ctx.connection.fetch.register({
      path: EVENTS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => eventStream(capture, request),
    }))

    disposers.push(ctx.connection.fetch.register({
      path: CLIENT_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readFile(CLIENT_FILE)
        return new Response(request.method === 'HEAD' ? null : body, {
          headers: {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        })
      },
    }))

    disposers.push(ctx.connection.fetch.register({
      path: '/api/rail-music/status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Response.json(capture.status()),
    }))

    disposers.push(ctx.on('webserver/index-inject', (table) => {
      table.push({
        kind: 'global',
        name: CONFIG_GLOBAL,
        value: clientOptions(options),
      })
    }))

    ctx.logger?.info?.(`rail-music: audio rail ready (python ${options.pythonPath})`)
    // Also on stdout: the logger sink is not guaranteed while the tree loads.
    console.log(`dsh rail-music: capture helper will start in ${options.startDelayMs}ms (python ${options.pythonPath})`)

    return () => {
      clearTimeout(startTimer)
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* one bad disposer must not strand the rest */ }
      }
      capture.stop()
    }
  }, 'experimental-rail-music: capture and routes')
}
