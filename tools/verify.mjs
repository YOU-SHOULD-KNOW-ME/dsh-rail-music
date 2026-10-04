/**
 * Drive the harness in real Edge and check what actually renders.
 *
 * Four things are being proven, none of which can be established by reading the
 * source: that the injected rule outranks the rail's own stylesheet, that the
 * custom property reaches the ::before pseudo-element, that the audio layer
 * releases the rail completely when the pointer arrives, and that the width cap
 * keeps the scroller from overflowing.
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

/**
 * Playwright is not a dependency of this plugin — it is borrowed from a DSH
 * checkout, which is also where the harness generator reads the rail's real
 * stylesheet from. Point DSH_CHECKOUT at one to run this.
 */
const REPO = process.env.DSH_CHECKOUT ?? 'D:/PythonCode/Agent/deepseek-harness'
const require = createRequire(pathToFileURL(join(REPO, 'package.json')).href)
let chromium
try {
  ({ chromium } = require('playwright'))
} catch (error) {
  console.error(`cannot load playwright from ${REPO}\n`
    + '  set DSH_CHECKOUT to a deepseek-harness checkout that has node_modules installed\n'
    + `  (${error.message})`)
  process.exit(2)
}

/**
 * The harness is served by test/serve.mjs, which injects the same config global
 * and <script src> the Host plugin injects. There is no file:// mode: the
 * browser half only ever runs against the plugin's own routes.
 */
const HARNESS = process.env.RAIL_MUSIC_URL
if (HARNESS === undefined) {
  console.error('set RAIL_MUSIC_URL to the running test server, e.g.\n'
    + '  node test/serve.mjs --port 8791\n'
    + '  RAIL_MUSIC_URL=http://127.0.0.1:8791/ node tools/verify.mjs')
  process.exit(2)
}
const SHOTS = fileURLToPath(new URL('../shots', import.meta.url))
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const consoleErrors = []
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', error => consoleErrors.push(String(error)))

/** Widest hue separation across a set of ticks, or 0 when none are coloured. */
function hueSpread(marks) {
  const hues = marks.map(m => m.hue).filter(value => value !== null)
  if (hues.length < 2) return 0
  // Hue wraps at 360, so the spread is 360 minus the widest gap.
  const sorted = [...hues].sort((a, b) => a - b)
  let widestGap = sorted[0] + 360 - sorted[sorted.length - 1]
  for (let i = 1; i < sorted.length; i++) {
    widestGap = Math.max(widestGap, sorted[i] - sorted[i - 1])
  }
  return 360 - widestGap
}

await page.goto(HARNESS)

/** Read every mark's inline variable and the transform the engine resolved. */
const sample = () => page.evaluate(() => {
  /** Hue in degrees, or null for a neutral grey. Runs in the page, so it is
   *  redefined here rather than shared with the Node-side helpers. */
  const hueOf = (channels) => {
    if (channels === null || channels.some(Number.isNaN)) return null
    const [r, g, b] = channels
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const span = max - min
    if (span === 0) return null
    let hue
    if (max === r) hue = ((g - b) / span) % 6
    else if (max === g) hue = (b - r) / span + 2
    else hue = (r - g) / span + 4
    return ((hue * 60) + 360) % 360
  }

  const nav = document.querySelector('nav[class*="_frame"]')
  if (nav === null) return null
  const marks = [...nav.querySelectorAll('button')]
  return {
    status: window.__railMusic?.status() ?? null,
    // Read atomically with the colours: checking "disarmed" in a separate
    // evaluate let the two reads disagree about which moment they described.
    armed: document.documentElement.classList.contains('dsh-rail-music'),
    // Geometry is armed for the whole session, so it must still be wide while
    // the pointer is inside — otherwise the hit area shrinks under the pointer.
    wide: document.documentElement.classList.contains('dsh-rail-music-wide'),
    frameWidth: Math.round(nav.getBoundingClientRect().width),
    scroller: (() => {
      const scroller = nav.querySelector('[class*="_scroller"]')
      return { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth }
    })(),
    marks: marks.map((mark) => {
      const before = getComputedStyle(mark, '::before')
      const match = /matrix\(([-0-9.]+)/.exec(before.transform)
      const rgb = /rgba?\(([^)]+)\)/.exec(before.backgroundColor)
      const channels = rgb === null ? null : rgb[1].split(',').slice(0, 3).map(Number)
      return {
        inline: mark.style.getPropertyValue('--rm-tick'),
        scaleX: match === null ? null : Number(match[1]),
        raw: before.backgroundColor,
        // Hue is what proves the rainbow is real. Counting distinct colour
        // strings does not: the stylesheet fallback is one fixed hue whose
        // brightness still varies per tick, which reads as "15 distinct
        // colours" while every tick is the same blue.
        hue: hueOf(channels),
        // How colourful the tick is: 0 = grey, 1 = fully saturated.
        chroma: channels === null || channels.some(Number.isNaN) ? null
          : (Math.max(...channels) - Math.min(...channels)) / Math.max(1, Math.max(...channels)),
        state: /_markActive/.test(mark.className) ? 'active'
          : /_markPreview/.test(mark.className) ? 'preview'
            : /_markUnloaded/.test(mark.className) ? 'unloaded' : 'rest',
      }
    }),
  }
})

await page.waitForFunction(
  () => window.__railMusic !== undefined && window.__railMusic.status().connected
    && document.querySelector('nav[class*="_frame"]') !== null,
  null, { timeout: 15000 },
)

// The frame widens with a 200ms transition, so measure only once it has settled.
await page.waitForTimeout(500)

const first = await sample()
console.log('rail found:', first.status.railFound, '| marks:', first.status.marks,
  '| events:', first.status.eventsPath ?? first.status.port, '| connected:', first.status.connected)
console.log('bar width:', first.status.barWidth, 'px | frame width:',
  first.status.frameWidth, 'px | measured frame:', first.frameWidth, 'px',
  '| wide armed:', first.wide)

// ---- sample the live audio response -------------------------------------
const railBox = await page.locator('nav[class*="_frame"]').boundingBox()
const clip = {
  x: Math.max(0, railBox.x - 44),
  y: Math.max(0, railBox.y - 18),
  width: railBox.width + 64,
  height: railBox.height + 36,
}
const STRIP_AT = [4, 16, 28]
const samples = []
let loudShot = false
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(90)
  const read = await sample()
  if (read === null) continue
  samples.push(read)
  if (!loudShot && read.status.rms !== null && read.status.rms > -16) {
    await page.screenshot({ path: `${SHOTS}/loud.png` })
    loudShot = true
  }
  const strip = STRIP_AT.indexOf(i)
  if (strip >= 0 && read.status.gain > 0.9) {
    await page.screenshot({ path: `${SHOTS}/rail-${strip + 1}.png`, clip })
  }
}
if (!loudShot) await page.screenshot({ path: `${SHOTS}/loud.png` })

const flat = state => samples.flatMap(s => s.marks.filter(m => m.state === state).map(m => m.scaleX))
const range = values => values.length === 0 ? { min: NaN, max: NaN }
  : { min: Math.min(...values), max: Math.max(...values) }

const rest = range(flat('rest'))
const unloaded = range(flat('unloaded'))
const active = range(flat('active'))
console.log('\n--- live audio response (45 samples @90ms) ---')
console.log('rest      scaleX', rest.min.toFixed(3), '..', rest.max.toFixed(3),
  ` swing ${(rest.max - rest.min).toFixed(3)}`)
console.log('unloaded  scaleX', unloaded.min.toFixed(3), '..', unloaded.max.toFixed(3))
console.log('active    scaleX', active.min.toFixed(3), '..', active.max.toFixed(3))
console.log('peak rms seen:', Math.max(...samples.map(s => s.status.rms ?? -99)), 'dB',
  '| beats fired:', samples.at(-1).status.beats)
console.log('max scaleX observed:', Math.max(...flat('rest'), ...flat('active'), ...flat('unloaded')).toFixed(3))

// Two things are checked per frame now. Width carries the spectrum, so the old
// "states stay 0.2 apart" claim is gone by design; what must still hold is that
// the active turn is never out-shouted, and that the ladder actually renders a
// spectrum rather than one shared pulse. (The bug this replaced: frequency
// content drove 0.7px of a 20px tick while loudness drove 14px.)
let orderingViolations = 0
let engagedFrames = 0
let spreadTotal = 0
let loudestSpread = 0
for (const snapshot of samples) {
  if ((snapshot.status?.gain ?? 0) < 0.5) continue
  engagedFrames++
  const at = state => snapshot.marks.filter(m => m.state === state).map(m => m.scaleX)
  const activeMax = Math.max(...at('active'))
  const widestOther = Math.max(...snapshot.marks.filter(m => m.state !== 'active').map(m => m.scaleX))
  if (activeMax < widestOther - 0.001) orderingViolations++
  const rest = at('rest')
  const spread = Math.max(...rest) - Math.min(...rest)
  spreadTotal += spread
  if (spread > loudestSpread) loudestSpread = spread
}
const averageSpread = engagedFrames === 0 ? 0 : spreadTotal / engagedFrames
const worstOverflow = Math.max(...samples.map(s => s.scroller.scrollWidth - s.scroller.clientWidth))

// Colour is the other half of the request: rainbow while the music drives the
// rail, the rail's own white/grey the moment the pointer arrives. The engaged
// half is collected here; the released half needs the handoff sample below.
const engagedChroma = samples
  .filter(s => (s.status?.gain ?? 0) > 0.9)
  .flatMap(s => s.marks.map(m => m.chroma))
  .filter(value => value !== null)
const avg = values => values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length

// ---- pointer handoff ----------------------------------------------------
await page.hover('nav[class*="_frame"]')
await page.waitForFunction(() => window.__railMusic.status().gain === 0, null, { timeout: 6000 })
// Let the handoff settle before judging the steady state.
await page.waitForTimeout(400)
const released = await sample()
const pinned = released.marks.filter(m => m.inline !== '')
const releasedChroma = released.marks.map(m => m.chroma).filter(value => value !== null)
// Note the negation: `armed` is what the page reports, `disarmed` is the claim.
const disarmed = !released.armed
console.log('\n--- pointer handoff ---')
console.log('gain:', released.status.gain, '| marks still pinned:', pinned.length,
  '| override disarmed:', disarmed, '| frame still wide:', released.wide, `${released.frameWidth}px`)

// The harness has no React, so the hover class the rail would apply on
// pointermove is applied directly. What matters is that once the audio layer
// has released, the rail's own stylesheet controls the tick again — and the
// read has to wait out that stylesheet's own 140ms transform transition.
await page.evaluate(() => {
  const marks = [...document.querySelectorAll('nav[class*="_frame"] button')]
  const prefix = [...marks[0].classList].find(token => /_mark$/.test(token)).replace(/_mark$/, '')
  const rest = marks.find(mark => mark.classList.contains(`${prefix}_mark`)
    && !mark.classList.contains(`${prefix}_markUnloaded`)
    && !mark.classList.contains(`${prefix}_markActive`))
  rest.dataset.probe = 'preview'
  rest.classList.add(`${prefix}_markPreview`)
})
await page.waitForTimeout(300)
const stateAfterRelease = await page.evaluate(() => {
  const scaleOf = (mark) => {
    if (mark == null) return null
    const match = /matrix\(([-0-9.]+)/.exec(getComputedStyle(mark, '::before').transform)
    return match === null ? null : Number(match[1])
  }
  const marks = [...document.querySelectorAll('nav[class*="_frame"] button')]
  const prefix = [...marks[0].classList].find(token => /_mark$/.test(token)).replace(/_mark$/, '')
  const result = {
    preview: scaleOf(document.querySelector('[data-probe="preview"]')),
    active: scaleOf(marks.find(mark => mark.classList.contains(`${prefix}_markActive`))),
    unloaded: scaleOf(marks.find(mark => mark.classList.contains(`${prefix}_markUnloaded`))),
  }
  document.querySelector('[data-probe="preview"]')?.classList.remove(`${prefix}_markPreview`)
  return result
})
console.log('after release -> preview', stateAfterRelease.preview,
  '| active', stateAfterRelease.active, '| unloaded', stateAfterRelease.unloaded)
await page.screenshot({ path: `${SHOTS}/hover.png` })

// ---- re-engage ----------------------------------------------------------
// The regression that matters here is colour, not gain: the write-suppression
// cache used to survive the release, and because hue is positional (constant)
// the re-engage write was skipped forever, leaving every tick on the
// stylesheet's default blue. A saturation check cannot see that — the default
// is saturated too — so the assertion counts *distinct* colours.
await page.mouse.move(640, 400)
await page.waitForTimeout(900)
const resumed = await sample()
const resumedColours = [...new Set(resumed.marks.map(m => m.raw))]
const engagedHueSpread = Math.max(...samples
  .filter(s => (s.status?.gain ?? 0) > 0.9)
  .map(s => hueSpread(s.marks)), 0)
const resumedHueSpread = hueSpread(resumed.marks)
console.log('re-engaged gain:', resumed.status.gain,
  '| distinct tick colours:', resumedColours.length,
  `| hue spread: engaged ${engagedHueSpread.toFixed(0)}deg, resumed ${resumedHueSpread.toFixed(0)}deg`)
console.log('  sample:', resumedColours.slice(0, 3).join(' | '))

await browser.close()

console.log('\n--- verdict ---')
const near = (value, target, tolerance = 0.01) =>
  value !== null && Math.abs(value - target) <= tolerance

const checks = [
  ['injected rule outranks rail CSS', rest.max > 0.62],
  ['ticks move with the audio', rest.max - rest.min > 0.08],
  ['ladder renders a spectrum, not one shared pulse', averageSpread > 0.15],
  ['active turn is never out-shouted', engagedFrames > 5 && orderingViolations === 0],
  ['rainbow while the music drives it', avg(engagedChroma) > 0.5 && engagedHueSpread > 100],
  ['hover returns the rail to white/grey', avg(releasedChroma) < 0.15],
  ['bars are wider than the rail ships', first.frameWidth >= 44],
  ['frame stays wide while hovered', released.wide && released.frameWidth >= 44],
  ['width capped, no horizontal overflow', worstOverflow <= 0],
  ['pointer releases every tick', pinned.length === 0],
  ['override disarmed on release', disarmed],
  ['release restores preview width 0.9', near(stateAfterRelease.preview, 0.9)],
  ['release restores active width 1.0', near(stateAfterRelease.active, 1.0)],
  ['release restores unloaded width 0.4', near(stateAfterRelease.unloaded, 0.4)],
  ['audio re-engages after the pointer leaves', resumed.status.gain > 0.9],
  ['rainbow returns after the pointer leaves', resumedHueSpread > 100],
  ['no page errors', consoleErrors.length === 0],
]
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
console.log(`  spectrum spread: avg ${averageSpread.toFixed(3)} scaleX`
  + ` = ${(averageSpread * first.status.barWidth).toFixed(1)}px of a ${first.status.barWidth}px bar,`
  + ` peak ${(loudestSpread * first.status.barWidth).toFixed(1)}px`)
console.log(`  (the rail ships a 20px bar, where the same spread would be`
  + ` ${(averageSpread * 20).toFixed(1)}px)`)
console.log(`  chroma while engaged ${avg(engagedChroma).toFixed(3)} -> on hover ${avg(releasedChroma).toFixed(3)}`
  + ' (0 = grey, 1 = saturated)')
const distinct = [...new Set(released.marks.map(m => m.raw))]
console.log(`  hovered tick colours (${distinct.length} distinct): ${distinct.slice(0, 4).join(' | ')}`)
if (orderingViolations > 0) console.log('  frames where a band out-shouted the active turn:', orderingViolations, '/', engagedFrames)
if (worstOverflow > 0) console.log('  worst scroller overflow:', worstOverflow, 'px')
if (consoleErrors.length > 0) console.log('  page errors:', consoleErrors.slice(0, 5))
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
