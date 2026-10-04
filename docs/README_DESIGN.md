# README 设计说明与参考

日期：2026-10-03。目标产物是仓库首页 `README.md`，采用 GitHub 支持的 Markdown、HTML 图片/折叠区块和 Mermaid；没有依赖自定义网页脚本来呈现主要内容。

2026-10-04 的 0.3.0 更新：封面平台标签和 README 支持表改为 Windows/Linux/macOS；平台条件与验证范围相邻展示，macOS 需要虚拟路由，Linux/macOS 实机录音尚未验证。

## 搜索与参考

通过 GitHub 仓库搜索选择音频可视化与终端工具，再直接读取项目 README。Star 数是本次搜索时的快照，后续会变化；它用于选择案例，不代表可量化的设计评分。

| 项目 | 本次 Star 快照 | 实际阅读到的组织方式 | 采用的思路 |
| --- | --- | --- | --- |
| [Starship](https://github.com/starship/starship) | 60,120 | 居中品牌区、简短用途、演示、语言与文档入口 | 首页的品牌识别与短导航 |
| [Glow](https://github.com/charmbracelet/glow) | 27,556 | 动态品牌图、真实界面演示、What is it、直接安装入口 | 视觉之后立刻解释功能，把可复制安装步骤提前 |
| [SPlayer](https://github.com/SPlayer-Dev/SPlayer) | 7,396 | 大图、分组功能、折叠截图和不同发行方式 | 主题展示与折叠 FAQ；没有复制项目的许可/限制表述 |
| [CAVA](https://github.com/karlstav/cava) | 6,451 | 频谱动图先行、目录、采音机制、分平台安装与排查 | 用动图解释频谱，先讲音频来源，再讲设置 |
| [Monstercat Visualizer](https://github.com/marcopixel/monstercat-visualizer) | 961 | 音乐组件截图、系统前提、功能、明确安装与设置入口 | 让读者知道显示的是系统混音；给出安装成功后的界面标志 |
| [Lively](https://github.com/rocksdanister/lively) | 本次未取得可靠数字 | 演示按功能分组，下载入口，文档和贡献链接 | 用状态变化演示“为什么有用”，不用全部技术参数占据首屏 |

读取的是这些项目当时默认分支上的 README。Starship、Glow、SPlayer 与 CAVA 属于高星参考；Monstercat 是功能领域更贴近的补充案例。Lively 仓库 README 已读取，未把没有成功取得的 Star 数写成事实。

没有下载或使用参考项目的图片、动图、Logo 或界面素材，也没有把它们的说明当作插件能力。所有视觉素材来自本项目原创绘制或本插件渲染。

## 信息设计

页面阅读顺序：

1. **看见它**：品牌海报与一句话用途。
2. **理解它**：实际插件渲染动图，展示“律动 → 悬停导航 → 恢复律动”。
3. **装上它**：Windows/DSH 前提，可复制给本机 Agent 的安装提示词与成功标志；手动命令折叠保留。
4. **调成自己的样子**：四种配色、深浅设置面板、常用参数和快捷操作。
5. **确认可用范围**：精确 DSH 清单与测试范围。
6. **解决问题**：折叠 FAQ、开发资料和反馈说明。

首次阅读者可以在安装完成后停下；维护者从底部进入兼容报告、优化记录和开发指南。

## 视觉方向

- 深蓝黑底、青绿强调、灰白文字；用固定网格和大字组成“音乐海报”。
- 封面右侧保留原插件的竖向频谱识别；不引入播放器封面或歌曲元数据能力的暗示。
- 配色卡片使用一致几何，让四种皮肤可直接比较。
- 深浅设置图截取实际测试截图中的控制面板，保留真实 UI。
- 静态事实徽章表示版本、平台、Web profile 与许可，没有添加虚构 Star 数、下载量、CI 成功或已发布 npm 状态。
- 文档有 `prefers-reduced-motion` 的静态演示备选图片，并保留用途说明文字。

## 图像来源和复现

| 文件 | 来源 |
| --- | --- |
| `assets/hero.png` | PIL 原创海报；抽象对话与频谱示意 |
| `assets/themes.png` | PIL 原创主题配色卡；颜色取自现有插件主题 |
| `assets/settings.png` | 拼版现有插件深浅主题真实设置截图 |
| `assets/demo.gif` | 浏览器运行当前 `lib/client.js`，使用真实 DSH 轨道样式与合成频段帧，录制 84 帧 |
| `assets/demo-still.png` | 同一演示的静态帧 |

复现需要当前 DSH checkout 的 Playwright、Edge 和已生成的 `harness.html`；图像合成需要 Pillow 与 Windows 字体：

```powershell
node tools\capture-readme-demo.mjs
python tools\build-readme-assets.py
```

`demo.gif` 是展示素材，不是声学同步测量，也没有录入用户的真实对话或声音。README 紧邻动图标注了这个范围。GIF 约 1.3MB，其余四张图片合计约 230KB，全部随仓库与发布包提供。录制包含 84 帧，GIF 编码会合并相同静态帧并延长其持续时间。

## 发布前最后一步

README 中的 `YOUR_GITHUB_NAME` 占位符已在 0.3.0 首次发布时全局替换为 `YOU-SHOULD-KNOW-ME`，包括中文/英文 Agent 安装提示词和手动命令；`package.json` 的仓库地址已按 `GITHUB_RELEASE.md` 填写。当前版本不添加指向尚未创建仓库的 Releases/Issues 按钮。

上线后的仓库 README 渲染应再验收一次，特别是 GIF、Mermaid 和折叠区块。本地预览用于检查内容、排版、资源及深浅主题，不能完全复刻 GitHub 的 HTML 清洗与页面外框。
