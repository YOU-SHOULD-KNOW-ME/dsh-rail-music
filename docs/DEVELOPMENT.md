# 配置与开发指南

[返回首页](../README.md) · [版本兼容](../COMPATIBILITY.md)

以下命令在插件源码目录执行；本地路径按实际环境替换。

## 平台采音

0.3.0 按系统选择 Windows WASAPI loopback、Linux PulseAudio/PipeWire monitor、macOS CoreAudio 虚拟输入。安装条件、设备列表和路由步骤见[平台设置指南](PLATFORMS.md)。Windows 默认解释器是 `python`，Linux/macOS 是 `python3`；虚拟环境可用 `pythonPath` 指定。

## 控制条位置

控制条位于页面右上方，自动向下避开已有的顶部栏、工具栏和右侧面板标签栏。设置面板向下展开，并根据剩余视口高度滚动；宿主菜单和弹窗保持更高层级。窗口、标题栏尺寸或侧栏结构变化时重新计算位置，暂停音乐模式时也保留这项布局监听，完全卸载时一起释放。

## 本地安装与 pnpm 环境

插件源代码放在固定目录后，使用 `dsh plugin --profile web add link:D:\Plugins\dsh-rail-music` 引用它。若出现 `ERR_PNPM_UNEXPECTED_STORE`，先确认 profile 与当前 pnpm 版本一致；不要把一次依赖安装失败当作插件采集错误。

需要手工恢复本地链接时，在 profile 的 `package.json` 中把 `dsh-rail-music` 加入 `dependencies`（值为 `link:<绝对路径>`）和 `dsh.profile.bundles`，再通过该 profile 对应的 pnpm 环境安装，生成链接。保留现有依赖和 bundles 列表，修改后重启 DSH。

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖（**patch 会替换整个 config 对象，用到的字段都要写全**）：

```yaml
- id: dsh-rail-music
  config:
    pythonPath: 'C:\Python311\python.exe'   # 需要能 import soundcard
    # device: 'BlackHole 2ch'               # macOS 虚拟输入；Linux 可填 monitor/sink，Windows 可填 loopback ID/名称
    # depth: 0.7                            # 律动幅度
    # barWidth: 32                          # 条宽
    # theme: aurora                         # rainbow / aurora / ember / mono
    # profile: responsive                   # balanced 默认；responsive 更快，低频更粗
    # window: 1024                          # 可选 1024 / 2048 / 4096，覆盖 profile 的窗长
    # bands: 24                             # 对数频段数
    # fps: 80                               # balanced=80；responsive=100；显式值优先
    # rate: 48000
    # startDelayMs: 0                       # 默认无固定等待；确有端点初始化问题时再增大
    logFile: 'D:\path\to\capture.log'       # 采集端自己的日志，排查首选
```

排查问题先看两处：**`logFile`** 和浏览器控制台的 `__railMusic.status()`。另外 `GET /api/rail-music/status` 也返回采集进程状态（需要页面已登录的 cookie）。

浏览器设置按站点保存在 `localStorage`，优先于 Host 的 `theme`、`depth`、`barWidth` 默认值。需要恢复 Host 默认时，在控制台执行 `localStorage.removeItem('dsh-rail-music:v2')` 后刷新。

`profile`、`window`、`fps` 在 Host 配置中修改，需要重启 `dsh web`；界面的配色、条宽和幅度即时生效。首次默认开启，之后记住暂停状态；系统「减少动态效果」开启时保持暂停，可用 `force()` 明确覆盖。

## 它是怎么做的

```
┌─ DSH Host ───────────────────────────────────────────────┐
│  lib/index.js  (cordis 插件)                              │
│    1. 拉起并看管 lib/capture.py（stdio 管道，不用网络）      │
│    2. 在 DSH 自己的 web 服务上注册三条 /api/rail-music/*    │
│    3. dsh.client 声明 → DSH 加载/卸载浏览器工厂            │
└──────────────────────────────────────────────────────────┘
        │ stdout: 每帧一行 JSON          │ SSE ~60/s（同源）
        ▼                                ▼
   lib/capture.py                   lib/client.js
   平台音频输入 → FFT             包络跟随 + 自适应增益
   → 24 个对数频段(dB)              → 直接写 CSS 变量驱动刻度
```

**Host 与原生浏览器工厂**：采集仍由 Host 管理，同源 SSE 不需要额外端口或 CORS；浏览器工厂直接写成零依赖脚本，通过 `exports["./client"]` 发布，不需要构建步骤。`webserver/index-inject` 只传初始配置，实时启用会从 status 路由读取当前配置。

**为什么使用 Host 采音**：浏览器屏幕共享需要反复授权，且各系统的系统音频共享能力不同。Host 路径在 Windows/Linux 读取系统输出混音，macOS 读取已配置的虚拟输入；实际权限与路由以平台指南为准。

## 设计上踩过的坑

这些是实测撞出来的，都写在代码注释里：

1. **覆盖必须能撤下。** 轨道四种状态各自是一条**同优先级** CSS 规则，所以任何强到能驱动刻度的覆盖，也强到能把四种状态**永久抹掉**。第一版释放后所有刻度卡在 `0.6`，当前轮次和未加载轮次全分不出来。修法：把覆盖藏在 `html.dsh-rail-music` 后面，只在音频层真正在写的时候存在。

2. **写入抑制缓存必须和属性一起失效。** 清掉元素上的 `--rm-*` 时如果不清 `lastTick` 记录，因为**色相是位置决定的、永远不变**，重新接管时写入会被永久跳过 → 所有刻度落到 CSS 兜底值 → **悬停一次之后整条轨道变浅蓝**。而且断言不能用「不同颜色数」抓它（兜底蓝的明度仍在变），必须看**色相跨度**。

3. **几何开关必须和音频开关分开。** 加宽容器同时会加宽鼠标命中区，如果宽度跟着音频层启停走，悬停时容器缩回 → 指针落到界外 → 又变宽 → **抖动死循环**。所以宽度挂在常驻的 `dsh-rail-music-wide` 上，悬停只让条回到 20px。

4. **每频段各自 AGC 会抹平频谱形状。** 每个频段填满自己的量程，低频就不再看起来最大，高低音区分不出来。正解是**所有频段共用一个刻度窗口 + 频谱倾斜补偿**。

5. **`--watch-parent` 必须显式开启。** helper 靠「stdin 关闭 = Host 没了」判断退出，但**任何非管道 stdin 都会立刻读到 EOF**（NUL、已关闭句柄、终端）→ 启动瞬间自杀 → 每 2 秒重启一次的 crash loop。另外 spawn 失败**不会**触发 `exit`，所以 `error` 里也得安排重启，否则 `pythonPath` 写错一次就把插件永久卡死。

6. **延迟要拆开量。** 见下。

### 延迟测量边界

`tools/measure-sync.py` 对多个随机时刻的咔嗒声做峰值匹配；时间参考是 `play()` 调用，**包含播放 API 启动和缓冲，也没有浏览器渲染时间**。它不能单独证明听觉与画面同步。

| 环节 | 说明 |
|---|---|
| helper stdout → Python 测量消费者 | 原作者记录中位数 0.0ms；本次未重新测量，不能据此认定 Node + SSE 全链路为 0ms |
| WASAPI blocksize 请求值 | balanced 12.5ms；responsive 10ms；实际缓冲取决于驱动与音频引擎 |
| FFT 窗总长 / 窗中心 | balanced 42.7 / 21.3ms；responsive 21.3 / 10.7ms，均为 48kHz 的计算值 |
| 浏览器从休眠唤醒 | 改为音频帧触发 rAF，移除最长 250ms 轮询等待；本次 fixture 测试约 2–3ms，非声学端到端延迟 |
| 接管增益包络 | 时间常数由 120ms 缩短为 25ms；每频段仍快起慢落，不叠加 CSS transform 过渡 |

原作者记录的 142–186ms 只能视为播放调用到 helper 帧的综合滞后。本次的链路、稳定性和浏览器验证结果见 [报告](../REVIEW_AND_OPTIMIZATION.md)，没有宣称已获得真实听觉到屏幕的同步测量值。

## 开发与验证

```powershell
# 离线 harness：从 DSH checkout 读真样式 + 真类名哈希生成预览页
$env:DSH_CHECKOUT = 'D:\path\to\deepseek-harness'
node tools\build-harness.mjs

# Host 半侧：真实子进程 + 真实路由 + 真实 SSE
$env:RAIL_MUSIC_PYTHON = 'D:\path\to\python.exe'
node test\host.smoke.mjs --seconds 6

# 45 秒 soak：抓 crash loop（通过 Host 的 restarts 计数检查重启）
node test\soak.mjs --seconds 45 --log capture.log

# 孤儿检测：Host 被 SIGKILL（不跑 disposer）后 helper 必须自己退出
node test\orphan.mjs

# 整条链路（含浏览器）：测试服务器挂真实路由 + harness
node test\serve.mjs --port 8791
$env:RAIL_MUSIC_URL = 'http://127.0.0.1:8791/'
node tools\verify.mjs          # Playwright 驱动本机 Edge，17 项断言

# 不依赖正在播放的歌曲：DSP、传输与交互回归
python test\analyser.test.py
node test\host.regression.mjs
node test\client.regression.mjs  # 从 DSH_CHECKOUT 借 Playwright
node test\client.lifecycle.mjs   # 原生工厂：连续开关、快速取消、卸载清理

# 延迟与频谱差异的量化
python tools\test-signal.py --seconds 20    # 合成测试曲，没音乐时用
python tools\measure-sync.py
```

`tools/verify.mjs` 需要 Playwright —— 它不随本仓库安装，而是从 `DSH_CHECKOUT` 借。

## 已知限制

- **平台前提**：Windows 共享 loopback；Linux 需要 PulseAudio 或 pipewire-pulse；macOS 需要虚拟输入和音频路由。Linux/macOS 已实现适配，真实设备验收仍待完成。
- **独占模式抓不到**。播放器若开了 WASAPI 独占输出，它绕过共享混音，loopback 会是静音——改回共享输出即可。
- **布局范围**：已检查当前 DSH 对话页面与右侧栏开合、顶部栏避让、深浅主题和窄视口；其他插件自定义浮层仍需按实际布局确认。可用 `__railMusic.disable()` 完全撤下。
- **采样率**默认请求 48kHz，不自动读取设备采样率；音频引擎可能重采样。`rate` 改了要确认设备支持。
- 频谱是装饰性频段映射，不是校准的音频测量仪器；低频分辨率受 FFT 窗长限制。
- 部分 SoundCard/驱动组合在设备名称枚举时可能原生崩溃。默认设备路径已通过公开 API 的 ID 匹配绕开；显式配置设备名称仍需在实际驱动上验证。
- 隐藏标签页会断开 SSE 并停止绘制；Host 的音频采集仍继续。Windows/Linux 默认输出约每秒检查一次；macOS 保持读取选定的虚拟输入，需要使用者维护多输出路由。跨平台实机切换体验尚未验证。

## 许可

[MIT](../LICENSE)
