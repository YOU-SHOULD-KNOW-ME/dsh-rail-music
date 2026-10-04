/** Deterministic browser regressions using the real DSH rail CSS and DOM. */
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
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
await page.route('http://rail.test/**', route => route.fulfill({
  contentType: 'text/html', body: harness.replace('</body>',
    `<script>globalThis.__DSH_RAIL_MUSIC__={version:'0.3.0',barWidth:40}</script><script>${script}</script></body>`),
}))
await page.addInitScript(() => {
  class FakeSource {
    constructor() {
      window.testSource = this
      this.closed = false
      setTimeout(() => this.onopen?.(), 0)
    }
    close() { this.closed = true }
  }
  window.EventSource = FakeSource
  window.emit = (extra = {}) => window.testSource.onmessage?.({ data: JSON.stringify({
    rms: -20, peak: -8, beat: 0, bands: Array.from({ length: 24 }, (_, i) => -22 - i * 2),
    idle: false, ...extra,
  }) })
})
let passed = 0
const check = (label, result) => { assert.ok(result, label); passed++; console.log(`PASS ${label}`) }
const status = () => page.evaluate(() => __railMusic.status())

try {
  await page.goto('http://rail.test/')
  await page.waitForFunction(() => __railMusic.status().connected)
  check('control lives in the top right and panel opens downward', await page.evaluate(() => {
    const control = document.querySelector('.rm-control').getBoundingClientRect()
    document.querySelector('.rm-control details').open = true
    const panel = document.querySelector('.rm-panel').getBoundingClientRect()
    document.querySelector('.rm-control details').open = false
    return control.top < 100 && control.right <= innerWidth && panel.top >= control.bottom
  }))
  await page.evaluate(() => {
    const header = document.createElement('header')
    header.id = 'host-toolbar'
    header.style.cssText = 'position:fixed;top:0;left:0;right:0;height:64px;background:#222;z-index:10'
    header.innerHTML = '<button style="position:absolute;right:16px;height:32px;top:16px">宿主菜单</button>'
    document.body.append(header)
  })
  await page.waitForFunction(() => document.querySelector('.rm-control').getBoundingClientRect().top >= 72)
  check('control avoids native header actions', await page.evaluate(() => {
    const host = document.getElementById('host-toolbar').getBoundingClientRect()
    const control = document.querySelector('.rm-control').getBoundingClientRect()
    return control.top >= host.bottom + 8
  }))
  await page.evaluate(() => document.getElementById('host-toolbar').style.height = '88px')
  await page.waitForFunction(() => document.querySelector('.rm-control').getBoundingClientRect().top >= 96)
  check('header resize updates avoidance', true)
  await page.evaluate(() => {
    const dock = document.createElement('div')
    dock.id = 'host-dock-tabs'
    dock.setAttribute('role', 'tablist')
    dock.style.cssText = 'position:fixed;right:0;top:88px;width:320px;height:40px;background:#222'
    document.body.append(dock)
  })
  await page.waitForFunction(() => document.querySelector('.rm-control').getBoundingClientRect().top >= 136)
  check('right sidebar tabs are not covered', true)
  await page.evaluate(() => { document.getElementById('host-toolbar').remove(); document.getElementById('host-dock-tabs').remove() })
  await page.waitForFunction(() => document.querySelector('.rm-control').getBoundingClientRect().top === 16)
  check('removed host chrome releases its reserved space', true)
  await page.evaluate(() => {
    const box = document.querySelector('.rm-control').getBoundingClientRect()
    const menu = document.createElement('div')
    menu.id = 'host-popup-menu'
    menu.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;z-index:100;background:#333`
    document.body.append(menu)
  })
  check('native popup layer stays above music controls', await page.evaluate(() => {
    const box = document.querySelector('.rm-control').getBoundingClientRect()
    return document.elementFromPoint(box.left + 10, box.top + 10).id === 'host-popup-menu'
  }))
  await page.evaluate(() => document.getElementById('host-popup-menu').remove())
  check('host barWidth reaches the client', (await status()).barWidth === 40)
  // Make sure the engine is in its idle timeout, then inject one live frame.
  const wakeMs = await page.evaluate(async () => {
    const at = performance.now()
    emit()
    while (__railMusic.status().gain === 0 && performance.now() - at < 300) {
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    return performance.now() - at
  })
  check(`audio wakes sleeping render loop (${wakeMs.toFixed(1)}ms)`, wakeMs < 80)
  await page.evaluate(() => {
    window.fixtureTimer = setInterval(() => emit({
      rms: -22 + Math.sin(performance.now() / 90) * 10,
      bands: Array.from({ length: 24 }, (_, i) => -25 - i * 2 + Math.sin(performance.now() / 80 + i) * 8),
      beat: Math.floor(performance.now() / 400),
    }), 12)
  })
  await page.waitForTimeout(300)
  const widths = await page.evaluate(() => [...document.querySelectorAll('nav button')]
    .map(mark => Number(mark.style.getPropertyValue('--rm-tick'))))
  check('frequency bands produce different bar lengths', Math.max(...widths) - Math.min(...widths) > .15)
  const activeIsWidest = await page.evaluate(() => {
    const marks = [...document.querySelectorAll('nav button')]
    const active = marks.find(mark => /_markActive/.test(mark.className))
    return Number(active.style.getPropertyValue('--rm-tick')) >= Math.max(...marks.map(mark => Number(mark.style.getPropertyValue('--rm-tick'))))
  })
  check('current turn remains widest', activeIsWidest)
  await page.hover('nav[class*="_frame"]')
  check('pointer immediately releases audio override', !(await page.evaluate(() => document.documentElement.classList.contains('dsh-rail-music'))))
  check('hover keeps stable hit area', await page.evaluate(() => document.documentElement.classList.contains('dsh-rail-music-wide')))
  await page.mouse.move(500, 400)
  await page.waitForTimeout(200)
  check('colours return after hover', await page.evaluate(() => {
    const hues = [...document.querySelectorAll('nav button')].map(x => +x.style.getPropertyValue('--rm-hue'))
    return Math.max(...hues) - Math.min(...hues) > 100
  }))
  await page.locator('nav button').nth(0).focus()
  check('keyboard navigation releases override', !(await page.evaluate(() => document.documentElement.classList.contains('dsh-rail-music'))))
  await page.evaluate(() => document.activeElement.blur())
  await page.waitForTimeout(200)
  await page.locator('.rm-control summary').click()
  await page.getByRole('combobox', { name: '配色' }).selectOption('aurora')
  await page.getByRole('checkbox', { name: '峰值保持' }).check()
  check('theme and peak hold controls work', (await status()).theme === 'aurora' && (await status()).peakHold)
  await page.getByRole('slider', { name: '条宽', exact: true }).fill('48')
  await page.getByRole('slider', { name: '条宽', exact: true }).dispatchEvent('input')
  await page.waitForTimeout(150)
  check('bar geometry stays inside scroller', await page.evaluate(() => {
    const scroller = document.querySelector('[class*="_scroller"]')
    return scroller.scrollWidth <= scroller.clientWidth
  }))
  await page.keyboard.press('Escape')
  check('Escape closes settings and returns focus', await page.evaluate(() =>
    !document.querySelector('.rm-control details').open && document.activeElement.matches('.rm-control summary')))
  await page.getByRole('button', { name: '暂停音乐律动' }).click()
  check('pause disconnects and resets state', !(await status()).enabled && !(await status()).connected && (await status()).gain === 0)
  check('paused mode keeps an accessible restart control', await page.getByRole('button', { name: '开启音乐律动' }).count() === 1)
  await page.getByRole('button', { name: '开启音乐律动' }).click()
  check('restart succeeds', (await status()).enabled)
  await page.evaluate(() => __railMusic.disable())
  check('full disable removes controls and styles', await page.evaluate(() =>
    !document.querySelector('.rm-control') && !document.getElementById('dsh-rail-music-style')))
  await page.reload()
  check('preferences survive refresh', (await status()).theme === 'aurora' && (await status()).barWidth === 48 && !(await status()).enabled)
  await page.getByRole('button', { name: '开启音乐律动' }).click()
  await page.evaluate(() => {
    emit()
    window.fixtureTimer = setInterval(() => emit(), 12)
  })
  await page.waitForTimeout(200)
  const oldCount = (await status()).receivedFrames
  await page.evaluate(() => testSource.onmessage({ data: '{"rms":null,"bands":[null]}' }))
  check('invalid audio frame is ignored', (await status()).receivedFrames <= oldCount + 2)
  await page.evaluate(() => __railMusic.setTheme('mono'))
  await page.waitForTimeout(80)
  check('mono has no saturation', await page.evaluate(() => [...document.querySelectorAll('nav button')]
    .every(mark => mark.style.getPropertyValue('--rm-sat') === '0%')))
  await page.evaluate(() => __railMusic.setTheme('aurora'))
  await page.locator('.rm-control summary').click()
  await mkdir(join(root, 'shots/review'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots/review/aurora-settings.png') })
  await page.locator('.rm-control summary').click()
  for (const theme of ['rainbow', 'aurora', 'ember', 'mono']) {
    await page.evaluate(value => __railMusic.setTheme(value), theme)
    await page.waitForTimeout(60)
    await page.screenshot({ path: join(root, `shots/review/${theme}.png`) })
  }
  await page.evaluate(() => {
    document.body.removeAttribute('data-ds-dark-theme')
    document.body.style.background = '#f5f5f7'
    __railMusic.setTheme('aurora')
  })
  await page.locator('.rm-control summary').click()
  await page.waitForTimeout(80)
  check('light settings text has readable contrast', await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.rm-panel'))
    const luminance = color => {
      const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => {
        const s = x / 255
        return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
      })
      return r * .2126 + g * .7152 + b * .0722
    }
    const a = luminance(style.color), b = luminance(style.backgroundColor)
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5
  }))
  await page.screenshot({ path: join(root, 'shots/review/light-settings.png') })
  await page.setViewportSize({ width: 360, height: 640 })
  check('settings remain inside a narrow viewport', await page.evaluate(() => {
    const box = document.querySelector('.rm-panel').getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
  }))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(200)
  await page.waitForFunction(() => !__railMusic.status().enabled, null, { timeout: 3000, polling: 100 })
  check('reduced motion change pauses active mode', !(await status()).enabled)
  check('enable respects reduced motion', await page.evaluate(() => __railMusic.enable().refused === 'reduced-motion'))
  check('no browser exceptions', errors.length === 0)
  console.log(`\n${passed} checks passed; receive-to-paint ${(await status()).receiveToPaintMs}ms (fixture, not audio latency)`)
} finally {
  await browser.close()
}
