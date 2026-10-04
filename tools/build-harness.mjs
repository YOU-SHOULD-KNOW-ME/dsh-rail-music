/**
 * Build a faithful offline harness for the DSH turn rail.
 *
 * The harness is not a mock-up: it takes the rail's real stylesheet, the real
 * design tokens, and the class-name hashes that the shipped bundle actually
 * generated, then reproduces the DOM the virtualizer produces (absolutely
 * positioned marks, translateY(i * 10px)). That is what makes it useful for
 * checking the audio override's specificity and rendering.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Where the DSH checkout lives.
 *
 * The harness is built from the rail's real stylesheet, real design tokens and
 * real class-name hashes, so the generator has to read a checkout. Everything
 * else in this repo is self-contained; only this tool needs one.
 *
 *   DSH_CHECKOUT=/path/to/deepseek-harness node tools/build-harness.mjs
 */
const REPO = process.env.DSH_CHECKOUT
if (!REPO) {
  console.error('DSH_CHECKOUT is required: point it at a deepseek-harness checkout.')
  process.exit(2)
}
const OUT = fileURLToPath(new URL('../harness.html', import.meta.url))
const COUNT = 36
const SPACING = 10
const INSET = 6
const ACTIVE_INDEX = 27

const LOCALS = [
  'slot', 'frame', 'scroller', 'fadeTop', 'fadeBottom', 'marks', 'mark',
  'markUnloaded', 'markPreview', 'markBusy', 'markActive', 'preview',
  'previewPrompt', 'previewResponse',
]

// ---------------------------------------------------------------- the hash

const bundle = readFileSync(`${REPO}/packages/client/ui-chat/lib/client.js`, 'utf8')
const hashesFor = local => new Set(
  [...bundle.matchAll(new RegExp(`_([A-Za-z0-9]+)_${local}(?![A-Za-z0-9])`, 'g'))].map(m => m[1]),
)
const candidates = LOCALS.map(local => [local, hashesFor(local)])
const shared = [...candidates[0][1]].filter(hash =>
  candidates.every(([, set]) => set.has(hash)))
if (shared.length !== 1) {
  throw new Error(`expected one shared hash, got ${JSON.stringify(shared)}; per-local: `
    + JSON.stringify(Object.fromEntries(candidates.map(([l, s]) => [l, [...s]]))))
}
const HASH = shared[0]
const cls = local => `_${HASH}_${local}`

// ------------------------------------------------------------- the styles

/** Strip CSS-module `:global(...)` wrappers, which are build-time only. */
const unglobal = css => css.replace(/:global\(([^)]*)\)/g, '$1')

/** Rewrite bare local class selectors to the emitted hashed names. */
function localize(css) {
  const known = new Set(LOCALS)
  return css.replace(/\.([A-Za-z][A-Za-z0-9]*)/g, (whole, name) =>
    (known.has(name) ? `.${cls(name)}` : whole))
}

const railCss = localize(unglobal(readFileSync(
  `${REPO}/packages/client/ui-chat/src/client/chat/TurnNavigator.module.css`, 'utf8')))
const tokenCss = readFileSync(`${REPO}/packages/client/ui-theme/src/styles/design-platform.css`, 'utf8')

// Sanity: one generated rule must byte-match the shipped bundle.
const probe = `transform:translateY(-50%)scaleX(.6)`
const minified = railCss.replace(/\s*\n\s*/g, '').replace(/;}/g, '}')
if (!bundle.replace(/\s*\n\s*/g, '').includes(`top:50%;right:0;${probe}`)) {
  throw new Error('shipped bundle does not contain the expected tick rule')
}
console.log(`hash ${HASH}; ${LOCALS.length} locals localized`)

// -------------------------------------------------------------- the markup

const marks = Array.from({ length: COUNT }, (_, index) => {
  const classes = [cls('mark')]
  // A realistic ladder: the first few turns are still unloaded history.
  if (index < 6) classes.push(cls('markUnloaded'))
  if (index === ACTIVE_INDEX) classes.push(cls('markActive'))
  const top = INSET - SPACING / 2 + index * SPACING
  return `      <button type="button" data-index="${index}" class="${classes.join(' ')}"`
    + ` style="transform:translateY(${top}px)" aria-label="turn ${index + 1}"></button>`
}).join('\n')

const height = INSET - SPACING / 2 + COUNT * SPACING + INSET - SPACING / 2

writeFileSync(OUT, `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>dsh-rail-music harness</title>
<style>
${tokenCss}
</style>
<style>
html, body { margin: 0; height: 100%; background: #0d0d0d; }
.shell { display: flex; height: 100%; font: 14px/1.7 ui-sans-serif, "Segoe UI", system-ui; color: #ddd }
.transcript { flex: 1; padding: 28px 40px; position: relative; overflow: hidden }
.transcript h1 { font-size: 15px; font-weight: 600; margin: 0 0 18px }
.transcript p { margin: 0 0 14px; color: #b9b9b9; max-width: 62ch }
.transcript .you { color: #7aa2f7 }
.transcript .meta { color: #6b6b6b; font-size: 12px }
/* The rail frame measures itself against these two custom properties. */
.transcript { --dsh-conversation-viewport-height: 800px; --dsh-composer-height: 152px;
              --dsh-composer-side-clearance: 0px }
</style>
<style>
/* ---- real rail stylesheet, hashed exactly as shipped ---- */
${railCss}
</style>
<style>
/* In the app the slot is a direct child of the scrollport, so its sticky
   positioning resolves against the viewport band. Here the page is ordinary
   flow, so the slot is pinned to the top of the transcript instead. */
.transcript .${cls('slot')} { position: absolute; top: 0; right: 0; left: 0 }
</style>
</head>
<body data-ds-dark-theme>
<div class="shell">
  <div class="transcript" data-conversation-scroll>
    <h1>harness — Turn navigation rail</h1>
    <p class="you">把这个轨道和我本地电脑的音频结合，做成随音乐律动的效果。</p>
    <p>轨道是 <code>nav[aria-label="轮次导航"]</code>，刻度定距 ${SPACING}px，
       静息态 <code>scaleX(.6)</code>，悬停态 <code>scaleX(.9)</code>。
       下面每一根刻度的宽度都由 sidecar 的频段数据驱动。</p>
    <p class="meta">hash ${HASH} · ${COUNT} marks · active #${ACTIVE_INDEX + 1}</p>
    <p>Move the pointer over the rail: the audio layer must hand back to the
       rail's own hover behaviour and release every tick.</p>
    <div class="${cls('slot')}">
      <nav class="${cls('frame')}" aria-label="轮次导航">
        <div class="${cls('scroller')} ${cls('fadeTop')}">
          <div class="${cls('marks')}" style="height:${height}px">
${marks}
          </div>
        </div>
      </nav>
    </div>
  </div>
</div>
<!-- No script tag here on purpose: test/serve.mjs injects the config global
     and <script src="/api/rail-music/client.js">, which is exactly what the
     Host plugin's webserver/index-inject row produces. -->
</body></html>
`)

console.log(`wrote ${OUT}`)
