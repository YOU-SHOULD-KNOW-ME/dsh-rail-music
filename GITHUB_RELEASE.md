# GitHub 发布准备

当前版本：0.3.0。安装产物直接包含 Host 模块与 DSH 原生浏览器工厂，不需要运行客户端构建，也没有 npm 运行依赖。Python 依赖在 `requirements.txt` 中。

0.3.0 增加 Linux monitor 与 macOS 虚拟输入；安装提示词已包含平台前提。Windows 真实采集通过，Linux/macOS 设备选择通过模拟测试，实机录音仍待验收。请保留[平台指南](docs/PLATFORMS.md)和 README 的验证范围说明。

当前支持清单与验证范围见 [DSH 版本兼容审查](COMPATIBILITY.md)：最低 0.1.7-alpha.1，推荐 0.2.0-rc.2。发布时应保留精确版本清单，不能只凭“能安装”宣称兼容。

## 1. 本地验收

```powershell
npm run check
npm test
python -m pip install -r requirements.txt
npm run test:dsp
npm run test:devices
npm pack --dry-run
```

浏览器与声卡测试需要实际开发环境；GitHub Actions 不依赖虚拟机是否有可用声卡：

```powershell
$env:DSH_CHECKOUT = 'D:\path\to\deepseek-harness'
node tools\build-harness.mjs
npm run test:browser
node test\host.smoke.mjs --python 'D:\path\to\python.exe' --seconds 6
$env:RAIL_MUSIC_PYTHON = 'D:\path\to\python.exe'
node test\host.lifecycle.mjs
```

升级到 0.3.0 后需要重启 `dsh web` 并刷新已有页面，让 Host/helper 和客户端加载新代码。随后 Plugins 页的开关由原生插件生命周期管理。插件激活不会等待 Python 初始化，但第一次产生真实音频帧仍有 Python 和设备打开的冷启动耗时。

## 2. 生成只含项目文件的源码包

```powershell
npm run release:source
```

产物：`dist/dsh-rail-music-0.3.0-source.zip`。归档采用明确的文件清单，包含代码、说明、测试、CI 和选定的截图，不包含运行日志、用户 profile、调试抓包、依赖、Python 缓存、生成的 harness 或父目录中的其他项目。

当前开发目录位于另一个 Git 仓库下面。建议将源码包解压到独立目录，例如 `D:\Projects\dsh-rail-music`，再在那里创建仓库，避免把父项目一同上传。

## 3. 配置真实 GitHub 地址

源码中已经移除虚构的 `repository`、`bugs`、`homepage` 元数据。创建自己的 GitHub 仓库后，在独立源码目录中填写：

```powershell
npm pkg set "repository.type=git"
npm pkg set "repository.url=git+https://github.com/YOU-SHOULD-KNOW-ME/dsh-rail-music.git"
npm pkg set "bugs.url=https://github.com/YOU-SHOULD-KNOW-ME/dsh-rail-music/issues"
npm pkg set "homepage=https://github.com/YOU-SHOULD-KNOW-ME/dsh-rail-music#readme"
```

README 的 GitHub 安装示例也需要换成同一仓库地址。默认端口、Python 解释器和采集日志路径由安装者的 profile 配置，不应写入插件的 bundle patch。

README 的 `YOUR_GITHUB_NAME` 占位符已在 0.3.0 首次发布时全局替换为 `YOU-SHOULD-KNOW-ME`，覆盖中文/英文 Agent 安装提示词与手动命令。首页默认引导用户复制 prompt 给能访问本机的 Agent，手动安装方式保留在折叠区。`docs/assets/` 的封面、主题图、设置图和动图需要一起提交；源码 ZIP 已包含这些文件。封面是示意图，动图是合成音频驱动的真实插件渲染，页面保留了来源说明。

## 4. 上传和发布

在解压后的独立目录中操作；先在 GitHub 创建同名空仓库：

```powershell
git init
git add .
git commit -m "Release dsh-rail-music 0.3.0"
git branch -M main
git remote add origin https://github.com/YOU-SHOULD-KNOW-ME/dsh-rail-music.git
git push -u origin main
git tag v0.3.0
git push origin v0.3.0
```

也可以使用 GitHub Desktop 创建并发布该独立目录。等待 CI 成功后创建 GitHub Release，可附上源码 ZIP；发布描述可直接使用 `CHANGELOG.md` 的 0.3.0 条目。

他人的安装方式：

```powershell
python -m pip install soundcard numpy
dsh plugin --profile web add github:YOU-SHOULD-KNOW-ME/dsh-rail-music
```

安装者需要兼容性清单内的 DSH Web 与对应平台音频条件：Windows 共享输出、Linux PulseAudio/PipeWire monitor，或 macOS 已路由的虚拟输入；Python ≥3.9 能导入 SoundCard/NumPy，建议 Node 24。插件自身最低 Node 20，而上述 DSH 源码要求 `^22.19.0 || >=24.0.0`；安装新依赖后首次重启 DSH。插件不会自动执行 pip 安装。

## 5. 验证范围

- `npm test` 覆盖配置注入、流背压、流关闭和路由清理。
- DSP 检查覆盖反相立体声、FFT 窗长/采样率边界、静音与分块一致性。
- 原生浏览器测试覆盖懒注册、快速取消、15 次开关、卸载清理、快捷键唯一性和偏好保留。
- Headless browser 的局部卸载耗时不等于 Plugins 页整个请求耗时；DSH 自身仍需要保存 profile 和完成热重载。
- GitHub CI 配置包含 Windows/Linux/macOS 基础检查和 Linux PulseAudio null-sink 真实采集任务，本次尚未在 GitHub 执行；推送后以 Actions 结果为准。macOS CI 的模拟路由检查不代表录音权限和真实设备已验收。
