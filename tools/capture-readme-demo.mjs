/** Capture the actual browser plugin driven by synthetic band frames. No sound playback. */
import { readFile, mkdir } from 'node:fs/promises'
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
const root = fileURLToPath(new URL('../', import.meta.url))
const harness = await readFile(join(root, 'harness.html'), 'utf8')
const client = await readFile(join(root, 'lib/client.js'), 'utf8')
const start = harness.indexOf('/* ---- real rail stylesheet')
const stop = harness.indexOf('</style>', start)
const railCss = harness.slice(start, stop)
const hash = /\._([^\s.{}]+)_frame/.exec(railCss)[1]
const cls = name => `_${hash}_${name}`
const tokens = harness.slice(harness.indexOf('<style>') + 7, harness.indexOf('</style>'))
const marks = Array.from({ length: 36 }, (_, i) => `<button type="button" class="${cls('mark')}${i < 6 ? ` ${cls('markUnloaded')}` : ''}${i === 27 ? ` ${cls('markActive')}` : ''}" style="transform:translateY(${1 + i * 10}px)" aria-label="轮次 ${i + 1}"></button>`).join('')
const pageHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${tokens}</style><style>${railCss}</style><style>
*{box-sizing:border-box}html,body{margin:0;background:#101118;color:#eef1f7;font-family:'Segoe UI','Microsoft YaHei',sans-serif}
.demo{position:relative;margin:20px 24px;border:1px solid #353b50;border-radius:22px;height:504px;overflow:hidden;background:#171a24;--dsh-conversation-viewport-height:550px;--dsh-composer-height:92px;--dsh-composer-side-clearance:0px}
.header{display:flex;justify-content:space-between;padding:20px 26px;border-bottom:1px solid #2d3346;font-size:14px;color:#9aa4bc}
.brand{color:#84e1cd;font-weight:600;letter-spacing:2px}.body{width:670px;padding:27px 28px}.body h1{font-size:28px;margin:0 0 20px;font-weight:600}.label{font-size:11px;letter-spacing:2px;color:#808daa;margin-bottom:9px}.message{padding:17px 20px;border:1px solid #353b50;background:#1d2230;border-radius:16px;margin-bottom:18px;color:#cbd2e2;font-size:15px;line-height:1.9}.answer{background:#191d29;border-color:#2c3446}.answer strong{color:#87dfcc}.footer{position:absolute;bottom:24px;left:28px;font-size:12px;color:#8c99b1}.phase{display:inline-flex;gap:8px;align-items:center;color:#88e4cd;font-size:13px}.phase::before{content:'';width:6px;height:6px;background:currentColor;border-radius:50%}.right-label{position:absolute;right:108px;bottom:74px;font-size:11px;color:#8390aa}.demo .${cls('slot')}{position:absolute;inset:0;height:0}.demo .${cls('frame')}{right:44px;top:271px}.rm-control{right:49px!important}.hint{position:absolute;right:99px;top:74px;font-size:11px;color:#91a1bd;pointer-events:none}
</style></head><body data-ds-dark-theme><main class="demo"><header class="header"><span class="brand">RAIL MUSIC / DSH</span><span id="phase" class="phase">01 · 音乐接管频谱</span></header><div class="body"><div class="label">A LITTLE RHYTHM FOR YOUR CONVERSATION</div><h1>让对话，有点节奏。</h1><div class="message">打开你喜欢的播放器，再回到 DSH。<br>每一根刻度，开始跟着不同频段轻轻起伏。</div><div class="message answer"><strong>你需要导航时，它懂得让路。</strong><br>鼠标进入轨道，原来的导航样式立即接管。<br>当前轮次依然醒目，键盘焦点也优先。</div></div><span class="hint">当前轮次 →</span><span class="right-label">低频 ↓</span><div class="footer">合成音频演示 · DSH 轨道真样式 · 插件实际渲染</div><div class="${cls('slot')}"><nav class="${cls('frame')}" aria-label="轮次导航"><div class="${cls('scroller')}"><div class="${cls('marks')}" style="height:362px">${marks}</div></div></nav></div></main><script>window.__DSH_RAIL_MUSIC__={version:'0.3.0',theme:'aurora',depth:.65,barWidth:44}</script><script src="/api/rail-music/client.js"></script></body></html>`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 550 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(() => {
    localStorage.removeItem('dsh-rail-music:v2')
    window.EventSource = class {
      constructor() { window.audioSource = this; setTimeout(() => this.onopen?.(), 0) }
      close() {}
      addEventListener() {}
    }
  })
  await page.route('http://demo.test/**', route => route.fulfill(new URL(route.request().url()).pathname.endsWith('/client.js')
    ? { contentType: 'text/javascript', body: client } : { contentType: 'text/html', body: pageHtml }))
  await page.goto('http://demo.test/')
  await page.waitForFunction(() => window.__railMusic?.status().connected)
  await page.evaluate(() => {
    let n = 0
    window.audioTimer = setInterval(() => {
      const t = n++ / 60
      const kick = Math.exp(-((t * 2) % 1) * 8)
      const bands = Array.from({ length: 24 }, (_, i) => {
        const texture = Math.sin(t * 4.2 + i * .54) * 8 + Math.cos(t * 6 - i * .83) * 6
        return -25 - i * 1.6 + texture + (i < 8 ? kick * 12 : 0)
      })
      audioSource.onmessage?.({ data: JSON.stringify({ rms: -25 + kick * 8, peak: -11,
        bands, beat: Math.floor(t * 2), idle: false }) })
    }, 16)
  })
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    const active = document.querySelector('[class*="_markActive"]')
    const canvas = document.querySelector('.demo')
    document.querySelector('.hint').style.top = `${active.getBoundingClientRect().y - canvas.getBoundingClientRect().y + 1}px`
  })
  const folder = join(root, 'dist/readme-frames')
  await mkdir(folder, { recursive: true })
  const box = await page.locator('nav').boundingBox()
  for (let i = 0; i < 84; i++) {
    if (i === 31) {
      await page.mouse.move(box.x + box.width - 10, box.y + box.height * .6)
      await page.evaluate(() => { document.getElementById('phase').textContent = '02 · 悬停，还给导航'; document.getElementById('phase').style.color = '#ccd1df' })
    }
    if (i === 51) {
      await page.mouse.move(500, 530)
      await page.evaluate(() => { document.getElementById('phase').textContent = '03 · 离开，继续律动'; document.getElementById('phase').style.color = '#88e4cd' })
    }
    await page.waitForTimeout(60)
    await page.screenshot({ path: join(folder, `${String(i).padStart(3, '0')}.png`) })
  }
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`Captured 84 frames to ${folder}; real plugin + synthetic band stream.`)
} finally { await browser.close() }
