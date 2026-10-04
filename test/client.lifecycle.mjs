/** Native DSH factory activation/disposal against real browser DOM and rail CSS. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const checkout = process.env.DSH_CHECKOUT ?? 'D:/PythonCode/Agent/deepseek-harness'
const require = createRequire(pathToFileURL(join(checkout, 'package.json')))
const { chromium } = require('playwright')
const root = fileURLToPath(new URL('../', import.meta.url))
const harness = await readFile(join(root, 'harness.html'), 'utf8')
const script = await readFile(join(root, 'lib/client.js'), 'utf8')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
let delayMs = 0
await page.route('http://native.test/**', async route => {
  const path = new URL(route.request().url()).pathname
  if (path === '/api/rail-music/status') {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ client: {
      eventsPath: '/api/rail-music/events', barWidth: 44, theme: 'ember', version: '0.3.0',
    } }) }).catch(() => {})
  } else if (path === '/plugins/client.js') {
    await route.fulfill({ contentType: 'text/javascript', body: script })
  } else {
    await route.fulfill({ contentType: 'text/html', body: harness.replace('</body>', '<script src="/plugins/client.js"></script></body>') })
  }
})
await page.addInitScript(() => {
  window.sources = []
  window.__ModuleLoader__ = { load: registration => { window.registration = registration } }
  window.EventSource = class {
    constructor() {
      this.closed = false
      this.events = new Map()
      sources.push(this)
      setTimeout(() => { if (!this.closed) this.onopen?.() }, 0)
    }
    close() { this.closed = true }
    addEventListener(name, fn) { this.events.set(name, fn) }
  }
  window.applyPlugin = () => registration.factory().apply({ effect: fn => { window.disposePlugin = fn() } })
  window.emit = () => sources.at(-1).onmessage?.({ data: JSON.stringify({
    rms: -20, peak: -8, bands: Array.from({ length: 24 }, (_, i) => -22 - i * 2), beat: 0, idle: false,
  }) })
})
const check = (label, value) => { assert.ok(value, label); console.log(`PASS ${label}`) }
try {
  await page.goto('http://native.test/')
  check('factory registers lazily without browser side effects', await page.evaluate(() =>
    registration.id === 'dsh-rail-music' && !window.__railMusic && !document.querySelector('.rm-control')))
  const applyMs = await page.evaluate(() => {
    const start = performance.now()
    applyPlugin()
    return performance.now() - start
  })
  check('native apply returns without waiting for audio or HTTP', applyMs < 50)
  await page.waitForFunction(() => window.__railMusic?.status().enabled)
  check('live activation reads current Host defaults', await page.evaluate(() =>
    __railMusic.status().barWidth === 44 && __railMusic.status().theme === 'ember'))
  await page.evaluate(() => { emit(); __railMusic.setTheme('aurora') })
  await page.waitForFunction(() => __railMusic.status().gain > 0)
  const offMs = await page.evaluate(() => {
    const start = performance.now()
    disposePlugin()
    return performance.now() - start
  })
  check('native disable removes every owned browser resource immediately', await page.evaluate(() =>
    !window.__railMusic && !document.querySelector('.rm-control') && !document.querySelector('style[data-plugin="dsh-rail-music"]')
    && !document.documentElement.classList.contains('dsh-rail-music-wide') && sources.every(source => source.closed)))
  check('package disable preserves the Music Mode preference', await page.evaluate(() =>
    JSON.parse(localStorage.getItem('dsh-rail-music:v2')).enabled === true))
  await page.keyboard.press('Alt+m')
  check('unloaded shortcut cannot revive the plugin', await page.evaluate(() => !window.__railMusic))

  const starts = [], stops = []
  for (let i = 0; i < 15; i++) {
    const start = await page.evaluate(() => { const at = performance.now(); applyPlugin(); return at })
    await page.waitForFunction(() => window.__railMusic?.status().enabled, null, { polling: 10 })
    starts.push(await page.evaluate(at => performance.now() - at, start))
    await page.evaluate(() => emit())
    await page.waitForFunction(() => __railMusic.status().gain > 0)
    stops.push(await page.evaluate(() => { const at = performance.now(); disposePlugin(); return performance.now() - at }))
  }
  check('15 toggle cycles leave no connections or duplicate controls', await page.evaluate(() =>
    sources.every(source => source.closed) && document.querySelectorAll('.rm-control').length === 0))
  await page.evaluate(() => applyPlugin())
  await page.waitForFunction(() => window.__railMusic?.status().enabled)
  await page.keyboard.press('Alt+m')
  check('remount installs exactly one shortcut handler', await page.evaluate(() => !__railMusic.status().enabled))
  await page.evaluate(() => { __railMusic.enable(); emit() })
  await page.waitForFunction(() => __railMusic.status().gain > 0)
  await page.evaluate(() => sources.at(-1).events.get('shutdown')())
  check('Host shutdown restores rail without waiting for stale timeout', await page.evaluate(() =>
    !window.__railMusic && !document.documentElement.classList.contains('dsh-rail-music') && sources.at(-1).closed))
  await page.evaluate(() => { window.oldDispose = disposePlugin; applyPlugin() })
  await page.waitForFunction(() => window.__railMusic?.status().enabled)
  await page.evaluate(() => oldDispose())
  check('late disposal of an old mount cannot remove new controls or listeners', await page.evaluate(() =>
    __railMusic.status().enabled && document.querySelectorAll('.rm-control').length === 1))
  await page.evaluate(() => disposePlugin())

  delayMs = 200
  await page.evaluate(() => { applyPlugin(); disposePlugin() })
  await page.waitForTimeout(300)
  check('cancelled activation cannot mount after its config fetch finishes', await page.evaluate(() =>
    !window.__railMusic && !document.querySelector('.rm-control')))
  check('no browser errors', errors.length === 0)
  const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1].toFixed(1)
  console.log(`\nBrowser fixture: apply call ${applyMs.toFixed(1)}ms; first dispose ${offMs.toFixed(1)}ms;`
    + ` 15 cycles mount p95 ${p95(starts)}ms, dispose p95 ${p95(stops)}ms. This excludes DSH manager RPC/profile reconciliation and audio cold start.`)
} finally { await browser.close() }
