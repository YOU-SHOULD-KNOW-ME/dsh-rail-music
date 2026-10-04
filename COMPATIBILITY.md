# DSH 版本兼容审查

DSH 接口审查日期：2026-10-03；平台更新：2026-10-04。当前插件版本：**dsh-rail-music 0.3.0**。结论只覆盖当前已经发布且已核对的版本，不承诺未来版本。

## 结论

**最低适配版本是 DSH 0.1.7-alpha.1；推荐 DSH 0.2.0-rc.2。** 下列 DSH Web 接口与轨道范围沿用 0.2.1 审查结果，0.3.0 增加 Linux/macOS 音频适配；六版本不是逐一启动完整应用验证。操作系统采音条件和实机范围见本文后半及[平台指南](docs/PLATFORMS.md)。

| DSH 版本 | 发布标签日期 | 当前插件结论 | 验证程度 |
| --- | --- | --- | --- |
| 0.1.7-alpha.1 | 2026-09-22 | 可适配，最低版本 | 发布源码接口 + 该版本轨道样式/DOM 回归 |
| 0.1.7-alpha.2 | 2026-09-22 | 可适配 | 发布源码接口 + 该版本轨道样式/DOM 回归 |
| 0.1.7-rc.1 | 2026-09-23 | 可适配 | 发布源码接口 + 该版本轨道样式/DOM 回归 |
| 0.1.7-rc.2 | 2026-09-24 | 可适配 | 发布源码接口 + 该版本轨道样式/DOM 回归 |
| 0.2.0-rc.1 | 2026-09-28 | 可适配 | 发布源码接口 + 该版本轨道样式/DOM 回归 |
| **0.2.0-rc.2** | 2026-09-29 | **推荐** | 上述核查 + 本地开发基准与前轮真实采集/路由/渲染验证 |

本次实时核对 npm：`@deepseek-ai/dsh` 的 **latest = next = 0.2.0-rc.2**，`alpha = 0.1.7-alpha.2`。因此普通 latest 安装和 next 安装当前都落在推荐版本；单独使用 alpha 标签也落在表内。

“可适配”表示当前代码需要的接口存在且轨道集成回归通过，不表示已对所有发行方式、设备驱动和完整应用开关过程完成认证。

## 不支持的版本与原因

| DSH 版本组 | 当前实现的问题（0.2.1/0.3.0） |
| --- | --- |
| **0.1.6-alpha.2** | 服务接口与客户端实时加载机制已经具备，但轨道采用 `.marks > .markPosition > button.mark`。插件 `findRail()` 只从 `.marks` 的直接子元素提取 `_mark` 类名，因此返回找不到轨道；采集和小控制条可能存在，轨道不会律动。 |
| **0.1.6-alpha.1** | 同样存在旧轨道定位包装层，且缺少本次依赖的客户端实时增删协调机制。 |
| **0.1.5 系列、0.1.3 系列** | 所核对发布标签缺少客户端实时协调机制，轨道也不满足直接按钮结构。不能保证 Plugins 页开关同步。 |
| **0.1.2 及更早版本** | 所核对发布标签还缺少当前 `connection.fetch` 精确 Fetch 路由接口，部分版本也没有相同轨道或注入接口。 |
| 未发布的 0.1.8、0.2.0 正式版、未来版本、第三方改版 | 未验证。不能根据版本号比最低版本大就自动认为兼容；轨道 DOM/CSS 属于界面实现细节。 |

源码审查覆盖上游目前的 25 个 `dsh-v*` 发布标签，从 0.1.0-rc.7 到 0.2.0-rc.2。npm 还保留部分更早但没有对应 Git 标签的发布物；没有对这些发行物做完整源码还原，当前支持清单不包含它们。

要支持 0.1.6-alpha.2，需要实际改写轨道发现、按钮枚举及旧 CSS 的恢复逻辑，并验证旧结构下的导航和几何行为。当前的 `/api/rail-music/client.js` 兼容脚本路由只是给升级前页面和测试 harness 使用，不能解决旧 DSH 的轨道结构差异。

## 插件具体依赖什么

| 依赖 | 本插件用途 | 审查依据 |
| --- | --- | --- |
| `dsh.bundle.patch` 与 profile bundle 配置 | Plugins 页识别、安装和 Host 行挂载 | `packages/boot/app-boot/src/profile.ts`、`index.ts` |
| `ctx.connection.fetch.register({path, methods, requestBody, fetch})` | 同源脚本、状态和 SSE 路由 | `packages/client/connection/src/rpc.ts`、`rpc-host.ts` |
| `webserver/index-inject` 的 global 行 | 首次页面加载的默认配置 | `packages/host/webserver/src/index.ts` |
| `dsh.client`、`exports["./client"]` | 注册原生浏览器模块 | `packages/client/modules/src/index.ts` |
| `__ModuleLoader__.load({id, factory})` | 懒加载浏览器工厂 | `packages/client/modules/src/client/manifest.ts` |
| 客户端 entry 的加载/移除与 `ctx.effect()` | Plugins 页停用时清理界面、连接和监听器 | `packages/client/modules/src/client/entries.ts`、Cordis effect 实现 |
| `.slot`、`.frame`、`.marks > button.mark` 及状态类 | 发现轨道并逐条写入 CSS 变量 | `packages/client/ui-chat/src/client/chat/TurnNavigator.tsx`、`.module.css` |
| `body[data-ds-dark-theme]` 与 DSH 颜色变量 | 深浅主题面板与轨道强调 | `packages/client/ui-theme/src/styles/design-platform.css` |

动态读取类名哈希能适应重新构建，但不能保证适应 DOM 层级、类名后缀或状态含义变化。因此版本支持不能只看 `dsh.client` 是否存在。

## 本次实际做了哪些验证

1. 在线核对上游 Git 标签与 npm dist-tags，确认本地源码版本与最新发布标签相符。
2. 静态审查 25 个发布标签，逐项检查路由、注入、工厂、实时协调、bundle 及轨道结构。完整结果在 `docs/compatibility-source-audit.json`，附精确 commit SHA。
3. 核对六个候选版本的 `dsh-client-modules`、`dsh-client-connection`、`dsh-client-ui-chat` 都有 npm 发布物；读取最低版本与最新版本的实际 npm 模块内容，核查工厂、Fetch 路由与直接轨道标记。
4. 用六个版本各自的轨道 CSS 和主题 token，在浏览器中重建其直接按钮结构，执行当前插件。逐个验证发现轨道、频谱差异、当前轮次最宽/最亮、无横向溢出、悬停恢复和客户端 effect 卸载，全部通过。
5. 再运行当前插件的原生生命周期回归，确认多次加载/卸载、取消配置请求、shutdown 和快捷键清理仍通过。

这里的 Host 和客户端服务是通过源码及发布模块核查，六版本浏览器测试使用测试 effect/音频源。**没有逐版启动真实 DSH profile，也没有把各版 Plugins 页 RPC 耗时当作已测量结果。** 前轮 0.2.0-rc.2 环境已经做过真实音频到路由/浏览器的检查，但原生客户端声明更新仍需要首次重启和刷新。

## 运行环境和发行形态

| 环境 | 结论 |
| --- | --- |
| Windows 上的 `dsh web`，使用表内 DSH 版本 | 支持清单覆盖；Python 在 Host 上运行，抓取的是 Host 的系统混音。 |
| 浏览器在其他电脑打开 DSH 页面 | 仍显示 Host 的音频；不会采集访问页面的电脑的声音。网络延迟另计。 |
| Windows 桌面版 DSH | 未验证。当前 Host 需要 `webServer` 与 `connection`，客户端使用同源 `/api` 和 EventSource；不声明支持只有桌面 carrier 的 profile。 |
| Linux Host | 0.3.0 已实现 PulseAudio monitor / PipeWire PulseAudio 兼容服务采集；需 libpulse 和可访问的同用户声音会话。模拟设备测试通过，Linux null-sink CI 已提供但本次未执行。 |
| macOS Host | 0.3.0 已实现 CoreAudio 虚拟输入，需 BlackHole 等设备、音乐路由与输入权限；不会自动读取原生扬声器或默认麦克风。模拟设备测试通过，实机录音待验收。 |
| 纯 CLI / raw / SDK profile | 没有 Web 轨道与完整服务组合，不支持本功能。 |

Node 的两层要求要区分：插件自己写的是 `>=20`，但六个 DSH 源码发布版本的根 manifest 要求 **`^22.19.0 || >=24.0.0`**。实际部署建议 Node 24；Node 20 不能据此宣称支持运行这些 DSH。Python 仍需能导入 NumPy/SoundCard，源码说明要求 3.9+，本地采集验证使用 Python 3.11。

## GitHub 发布时怎样写兼容范围

建议 README 使用已核查的六版本清单，并推荐 0.2.0-rc.2。不要写“支持全部 DSH 版本”，也不要用没有上限的 `>=0.1.7` 声明未来兼容。

当前 `package.json` **尚未声明 DSH peerDependencies**。DSH 能安装它不代表版本兼容。如果要在发布时让 DSH 的兼容检查识别这些版本，可增加可选 peer：

```json
{
  "peerDependencies": {
    "@deepseek-ai/dsh": "0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/dsh": { "optional": true }
  }
}
```

可选 peer 可避免 pnpm 为插件自动安装另一份 CLI。DSH 的兼容检查会检查 `@deepseek-ai/dsh` peer；本次仅提出这项发布建议，没有修改该声明。不要依赖单独的 `engines.dsh` 达到相同的拒绝安装效果。

升级插件后首次重启 `dsh web` 并刷新旧页面，以更新缓存的客户端声明。完成后应再在目标发行版的实际 Plugins 页面做安装、开启、关闭与重新开启验收。

## 复现审查

先准备含发布标签的 DSH 源码 checkout 和其现有 Playwright 开发依赖：

```powershell
python tools\audit-dsh-compatibility.py --repo 'D:\path\to\deepseek-harness'
$env:DSH_CHECKOUT = 'D:\path\to\deepseek-harness'
node test\version.compatibility.mjs
node test\client.lifecycle.mjs
```

测试不会切换现有 DSH checkout 的分支、安装其他 DSH 版本或修改用户 profile。

## 上游证据

- [DSH 发布标签](https://github.com/deepseek-ai/deepseek-harness/tags)
- [CLI 的 npm 发布记录](https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions)
- [0.1.7-alpha.1 轨道实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/packages/client/ui-chat/src/client/chat/TurnNavigator.tsx)
- [0.1.6-alpha.2 旧轨道包装层](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.2/packages/client/ui-chat/src/client/chat/TurnNavigator.tsx)
- [0.1.7-alpha.1 精确 Fetch 接口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/packages/client/connection/src/rpc.ts)
- [0.2.0-rc.2 客户端模块声明与工厂协议](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/modules/src/client/manifest.ts)
- [0.2.0-rc.2 插件版本兼容检查](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/boot/app-boot/src/plugin-compatibility.ts)
