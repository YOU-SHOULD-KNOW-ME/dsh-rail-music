/** Historical DSH rail styles + native factory ABI; not full-version boot tests. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const repo = process.env.DSH_CHECKOUT
if (!repo) {
  console.error('DSH_CHECKOUT is required: point it at a deepseek-harness checkout.')
  process.exit(2)
}
const require = createRequire(pathToFileURL(join(repo, 'package.json')))
const { chromium } = require('playwright')
const source = path => execFileSync('git', ['-C', repo, 'show', path], { encoding: 'utf8' })
const script = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
const versions = ['0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2']
const locals = new Set(['slot', 'frame', 'scroller', 'fadeTop', 'fadeBottom', 'marks', 'mark',
  'markUnloaded', 'markPreview', 'markBusy', 'markActive', 'preview', 'previewPrompt', 'previewResponse'])
const cssFor = tag => source(`${tag}:packages/client/ui-chat/src/client/chat/TurnNavigator.module.css`)
  .replace(/:global\(([^)]*)\)/g, '$1')
  .replace(/\.([A-Za-z][A-Za-z0-9]*)/g, (all, name) => locals.has(name) ? `._compat_${name}` : all)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  for (const version of versions) {
    const tag = `dsh-v${version}`
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    const marks = Array.from({ length: 36 }, (_, i) => `<button type="button" data-index="${i}"
      class="_compat_mark${i < 6 ? ' _compat_markUnloaded' : ''}${i === 27 ? ' _compat_markActive' : ''}"
      style="transform:translateY(${1 + i * 10}px)"></button>`).join('')
    const html = `<!doctype html><html><head><style>
      ${source(`${tag}:packages/client/ui-theme/src/styles/design-platform.css`)}
      </style><style>${cssFor(tag)}</style><style>
      body{margin:0;height:800px}main{position:relative;height:800px;--dsh-conversation-viewport-height:800px;--dsh-composer-height:152px;--dsh-composer-side-clearance:0px}
      main ._compat_slot{position:absolute;top:0;right:0;left:0}
      </style></head><body data-ds-dark-theme><main data-conversation-scroll><div class="_compat_slot">
      <nav class="_compat_frame"><div class="_compat_scroller"><div class="_compat_marks" style="height:362px">${marks}</div></div></nav>
      </div></main></body></html>`
    await page.addInitScript(() => {
      window.__ModuleLoader__ = { load(registration) { window.registration = registration } }
      window.EventSource = class {
        constructor() { window.audioSource = this; this.listeners = {}; setTimeout(() => this.onopen?.(), 0) }
        close() { this.closed = true }
        addEventListener(name, fn) { this.listeners[name] = fn }
      }
    })
    await page.route('http://compat.test/**', route => route.fulfill(new URL(route.request().url()).pathname === '/api/rail-music/status'
      ? { contentType: 'application/json', body: JSON.stringify({ client: { barWidth: 32 } }) }
      : { contentType: 'text/html', body: html }))
    await page.goto('http://compat.test/')
    await page.addScriptTag({ content: script })
    await page.waitForFunction(() => window.registration !== undefined, null, { timeout: 3000 })
    await page.evaluate(() => registration.factory().apply({ effect: fn => { window.disposePlugin = fn() } }))
    await page.waitForFunction(() => window.__railMusic?.status().connected)
    await page.evaluate(() => {
      window.audioTimer = setInterval(() => audioSource.onmessage({ data: JSON.stringify({
        rms: -20, peak: -8, bands: Array.from({ length: 24 }, (_, i) => -24 - i * 2), beat: 0, idle: false,
      }) }), 12)
    })
    await page.waitForFunction(() => __railMusic.status().gain > .9)
    const facts = await page.evaluate(() => {
      const marks = [...document.querySelectorAll('nav button')]
      const scales = marks.map(mark => +mark.style.getPropertyValue('--rm-tick'))
      const lights = marks.map(mark => parseFloat(mark.style.getPropertyValue('--rm-light')))
      const activeIndex = marks.findIndex(mark => mark.classList.contains('_compat_markActive'))
      const scroller = document.querySelector('._compat_scroller')
      return { found: __railMusic.status().railFound, count: __railMusic.status().marks,
        spread: Math.max(...scales) - Math.min(...scales),
        activeWidest: scales[activeIndex] >= Math.max(...scales),
        activeBrightest: lights[activeIndex] > Math.max(...lights.filter((_, i) => i !== activeIndex)),
        overflow: scroller.scrollWidth > scroller.clientWidth }
    })
    assert.ok(facts.found && facts.count === 36 && facts.spread > .15
      && facts.activeWidest && facts.activeBrightest && !facts.overflow, `${version}: ${JSON.stringify(facts)}`)
    await page.hover('nav')
    await page.waitForTimeout(180)
    const released = await page.evaluate(() => ({
      armed: document.documentElement.classList.contains('dsh-rail-music'),
      pinned: [...document.querySelectorAll('nav button')].some(mark => mark.style.getPropertyValue('--rm-tick')),
      activeScale: getComputedStyle(document.querySelector('._compat_markActive'), '::before').transform,
    }))
    assert.ok(!released.armed && !released.pinned && released.activeScale.startsWith('matrix(1,'), `${version}: handoff`)
    await page.evaluate(() => { clearInterval(audioTimer); disposePlugin() })
    assert.ok(await page.evaluate(() => !window.__railMusic && !document.querySelector('.rm-control')), `${version}: unload`)
    assert.equal(errors.length, 0, `${version}: ${errors}`)
    console.log(`PASS ${version}: rail discovery, spectrum, navigation priority, geometry, hover restoration, native effect unload`)
    await page.close()
  }
  console.log('Six tag-specific CSS/DOM checks passed. This does not boot six complete DSH applications.')
} finally { await browser.close() }
