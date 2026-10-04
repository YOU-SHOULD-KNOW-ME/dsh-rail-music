/** Render trusted project Markdown into a local review page with GitHub-like layout. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const repo = process.env.DSH_CHECKOUT ?? 'D:/PythonCode/Agent/deepseek-harness'
const require = createRequire(pathToFileURL(join(repo, 'package.json')))
const { marked } = await import(pathToFileURL(require.resolve('marked')))
let html = marked.parse(await readFile(join(root, 'README.md'), 'utf8'), { gfm: true })
// Asset links are relative to the repository root, one directory above this preview.
html = html.replace(/(src|srcset)="docs\//g, '$1="../docs/')
html = html.replace(/href="(?!https?:|#)([^"]+)"/g, 'href="../$1"')
html = html.replace(/<h([1-6])>(.*?)<\/h\1>/gs, (all, level, value) => {
  const id = value.replace(/<[^>]*>/g, '').toLowerCase().replace(/[\s/]+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-+/g, '-')
  return `<h${level} id="${id}">${value}</h${level}>`
})
// GitHub renders Mermaid natively. The local review shows the same simple flow as HTML.
html = html.replace(/<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/, '<div class="flow"><span>Windows 系统输出</span> → <span>WASAPI loopback</span> → <span>Python / FFT</span> → <span>DSH / SSE</span> → <span>频谱轨道</span></div>')
const result = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rail Music · README 预览</title><style>
:root{color-scheme:dark;--bg:#0d1117;--panel:#0d1117;--text:#e6edf3;--muted:#919ba9;--line:#30363d;--code:#161b22;--accent:#85b9ff}
body.light{color-scheme:light;--bg:#fff;--panel:#fff;--text:#1f2328;--muted:#59636e;--line:#d1d9e0;--code:#f6f8fa;--accent:#0969da}
*{box-sizing:border-box}body{background:var(--bg);color:var(--text);margin:0;font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}.toolbar{position:sticky;top:0;z-index:5;background:var(--code);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:12px 22px;font-size:13px;color:var(--muted)}.toolbar button{cursor:pointer;border:1px solid var(--line);color:var(--text);background:var(--bg);border-radius:8px;padding:7px 11px}.markdown-body{max-width:940px;margin:30px auto 80px;padding:32px;border:1px solid var(--line);border-radius:8px;background:var(--panel);overflow-wrap:break-word}.markdown-body>div[align=center]{text-align:center}.markdown-body img{max-width:100%;height:auto;border-radius:8px}.markdown-body h1{font-size:2em;line-height:1.3;padding-bottom:12px;border-bottom:1px solid var(--line)}.markdown-body h2{font-size:1.5em;padding-bottom:10px;border-bottom:1px solid var(--line);margin-top:40px;scroll-margin-top:70px}.markdown-body h3{font-size:1.1em;margin-top:28px}.markdown-body p{margin:16px 0}.markdown-body a{color:var(--accent);text-decoration:none}.markdown-body a:hover{text-decoration:underline}.markdown-body table{border-collapse:collapse;margin:20px 0;display:block;max-width:100%;overflow:auto;font-size:14px}.markdown-body th,.markdown-body td{border:1px solid var(--line);padding:10px 13px}.markdown-body th{font-weight:600}.markdown-body tr:nth-child(2n){background:var(--code)}.markdown-body code{font-family:Consolas,monospace;font-size:.86em;background:var(--code);border-radius:5px;padding:3px 5px}.markdown-body pre{background:var(--code);padding:16px;overflow:auto;border-radius:8px;line-height:1.6}.markdown-body pre code{padding:0;font-size:13px;white-space:pre}.markdown-body blockquote{border-left:3px solid var(--line);padding:0 16px;color:var(--muted);margin:18px 0}.markdown-body sub{font-size:11px;color:var(--muted)}.markdown-body details{margin:12px 0;padding:12px 14px;border:1px solid var(--line);border-radius:8px}.markdown-body summary{cursor:pointer;line-height:1.6}.markdown-body li{margin:7px 0}.markdown-body hr{border:0;height:1px;background:var(--line);margin:30px 0}.flow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:20px 12px;background:var(--code);border-radius:8px;font-size:11px}.flow span{padding:10px 8px;border:1px solid var(--line);border-radius:8px}.markdown-body a:focus-visible,summary:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
@media(max-width:650px){.markdown-body{margin:14px 10px 35px;padding:16px}.toolbar{padding:10px 14px}.markdown-body table{font-size:12px}.markdown-body h1{font-size:1.65em}}
.markdown-body pre{position:relative;padding-top:42px}.copy-button{position:absolute;right:10px;top:8px;border:1px solid var(--line);background:var(--bg);color:var(--muted);border-radius:6px;padding:3px 9px;font-size:12px;line-height:1.5;font-family:inherit;cursor:pointer}
</style></head><body><header class="toolbar"><span>dsh-rail-music / README.md · 本地排版预览</span><button id="theme">切换深浅主题</button></header><main class="markdown-body">${html}</main><script>
document.getElementById('theme').onclick=()=>document.body.classList.toggle('light');
for(const pre of document.querySelectorAll('pre')){
  const code=pre.querySelector('code');if(!code)continue;
  const button=document.createElement('button');button.className='copy-button';
  button.type='button';button.textContent='复制';button.setAttribute('aria-label','复制代码块');
  button.onclick=async()=>{
    try{await navigator.clipboard.writeText(code.textContent);button.textContent='已复制';}
    catch{button.textContent='请选中文本复制';}
    setTimeout(()=>button.textContent='复制',2000);
  };
  pre.append(button);
}
</script></body></html>`
await mkdir(join(root, 'dist'), { recursive: true })
await writeFile(join(root, 'dist/readme-preview.html'), result)
console.log(join(root, 'dist/readme-preview.html'))
