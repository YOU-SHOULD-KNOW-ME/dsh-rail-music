# 三个平台的系统音频采集

版本：0.3.1；更新日期：2026-10-04。Host/浏览器协议和 DSH 版本范围沿用现有实现，采音端按操作系统选择输入。Linux 和 macOS 设备路由已实现并通过模拟设备测试；当前开发环境只有 Windows，其他系统仍需要按下表完成实机验收。

| Host 系统 | 音频路径 | 必需条件 | 本次验证 |
| --- | --- | --- | --- |
| Windows | WASAPI output loopback | 共享模式输出；可导入 NumPy/SoundCard 的 Python | 真实采集、SSE、启动/退出测试 |
| Linux | PulseAudio sink monitor；PipeWire 经 `pipewire-pulse` 提供相同接口 | libpulse 和当前用户的 PulseAudio 兼容服务 | 设备选择/DSP/协议测试；已提供 Linux null-sink CI，尚未在 GitHub 执行 |
| macOS | CoreAudio 虚拟输入，如 BlackHole 2ch | 虚拟音频设备、把播放声音路由到该设备、录音输入权限 | 虚拟设备选择、明确错误和单声道/双声道参数测试；未实机录音 |

**macOS 支持需要音频路由配置，并非安装插件后自动读取扬声器。** 当前 SoundCard CoreAudio 后端没有系统输出 loopback API。本插件使用已配置的虚拟输入，不自动切换系统输出，也不在没有虚拟设备时改用内置麦克风。

## 通用 Python 环境

Linux/macOS 默认调用 `python3`；Windows 默认调用 `python`。建议给插件建专用虚拟环境，避免受管系统 Python 的 `externally-managed-environment` 问题。

从源码目录执行 Linux/macOS 示例：

```bash
python3 -m venv ~/.dsh/venvs/rail-music
~/.dsh/venvs/rail-music/bin/python -m pip install -r requirements.txt
~/.dsh/venvs/rail-music/bin/python -c "import soundcard, numpy; print('Audio dependencies ready')"
```

然后在实际 Web profile 的 `cordis.patch.yml` 中设置绝对路径：

```yaml
- id: dsh-rail-music
  config:
    pythonPath: '/home/YOUR_USER/.dsh/venvs/rail-music/bin/python'
```

macOS 路径通常是 `/Users/YOUR_USER/.dsh/venvs/rail-music/bin/python`。配置示例中的用户名需要替换；设置 `DSH_HOME` 后，profile 位置以该目录为准。合并已有 config 时保留原有设置。

## Linux：PulseAudio / PipeWire

### 1. 确认声音服务

在运行 DSH 的同一个桌面用户会话中检查：

```bash
pactl info
pactl get-default-sink
pactl list short sources
```

应能看到默认输出设备和 monitor source（通常以 `.monitor` 结尾）。PipeWire 的服务端名称可能包含 `PulseAudio (on PipeWire ...)`，插件仍使用 PulseAudio 兼容接口。

Ubuntu/Debian 缺少客户端库或诊断命令时：

```bash
sudo apt install libpulse0 pulseaudio-utils
```

桌面已经使用 PipeWire 时，保留该音频系统，并确认 `pipewire-pulse` 安装/运行。不要为了插件再启动第二个 PulseAudio 服务。纯 ALSA/JACK、没有 PulseAudio 兼容服务的机器不在自动采集范围。

```bash
systemctl --user status pipewire-pulse
```

声音服务与 DSH 必须属于同一可访问音频的用户会话。以 root、系统服务或容器启动 DSH 时可能无法访问桌面用户的 Pulse socket；需要部署者配置正确的 socket、权限和环境，不能靠切换到默认麦克风解决。

### 2. 默认选择与手动选择

未设置 `device` 时，插件找到默认 sink 对应的 `<sink>.monitor`，并约每秒检查默认 sink 是否变化。输出改变后重新打开对应 monitor。

需要固定设备时，可以设置 monitor 的 ID、准确名称，也可以设置 sink 的 ID/名称：

```yaml
- id: dsh-rail-music
  config:
    pythonPath: '/home/YOUR_USER/.dsh/venvs/rail-music/bin/python'
    device: 'alsa_output.YOUR_OUTPUT.analog-stereo.monitor'
```

这里的设备字符串是格式示例，应从本机列表取得。显式设备不跟随系统默认输出切换。名称有歧义时会要求使用准确 ID，不会随机挑选。

## macOS：BlackHole 等虚拟音频输入

### 1. 安装虚拟设备

推荐单独安装 [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole)。已使用 Homebrew 时可执行：

```bash
brew install --cask blackhole-2ch
```

也可按 BlackHole 官方安装方式操作。驱动独立安装，本插件不打包或修改该驱动。已经有 Soundflower、Loopback Audio、VB-Cable 等路由设备时，也可以使用，前提是系统音频确实进入其输入通道。

### 2. 同时听到声音与驱动频谱

打开 **Audio MIDI Setup / 音频 MIDI 设置**：

1. 创建 **Multi-Output Device / 多输出设备**。
2. 选中物理扬声器或耳机，以及 **BlackHole 2ch**。
3. 按 BlackHole 官方向导设置时钟源、采样率和漂移校正；通常让物理输出作为主时钟，采样率保持一致。
4. 将系统或播放器的输出设为该多输出设备，使同一声音同时送到耳机/扬声器和 BlackHole。
5. 插件从 **BlackHole 输入**读取前两个通道。不要把插件的 `device` 配成“多输出设备”本身，它通常只是输出组合。

详细步骤：[BlackHole Multi-Output Device 指南](https://github.com/ExistentialAudio/BlackHole/wiki/Multi-Output-Device)。只把系统输出改成 BlackHole 而没有物理输出路由时，频谱可能工作，但耳机/扬声器听不到声音。

### 3. 选择输入和允许访问

默认优先选择准确名称 **BlackHole 2ch**；没有它时，只在识别到唯一的其他虚拟输入时自动选择。多个虚拟输入需要设置 `device`，不会选择内置麦克风。

```yaml
- id: dsh-rail-music
  config:
    pythonPath: '/Users/YOUR_USER/.dsh/venvs/rail-music/bin/python'
    device: 'BlackHole 2ch'
```

自定义 Loopback 总线可以填其准确名称或 CoreAudio 数字 ID（配置里用字符串也可以）。显式输入由用户选择，因此应确认它是接收音乐的路由输入。16/64 声道虚拟设备默认分析前两个通道，路由时也应把声音送到通道 1–2。

首次采集时，如果 macOS 请求录音权限，请允许实际运行 DSH/Python 的应用访问音频输入。通常需要检查 **系统设置 → 隐私与安全性 → 麦克风** 中的终端或对应应用；被拒绝后可能需要重新启动启动器。具体权限提示以 macOS 版本为准。

切换到新的耳机或扬声器后，应更新/重新选择多输出路由。macOS 分析器保持读取选定的虚拟输入，不会自动改动系统输出。

## 查看设备与状态

在插件源码目录，使用配置中的同一解释器列出采集设备：

```bash
python3 lib/capture.py --list-devices
```

实际有虚拟环境时把 `python3` 换成虚拟环境绝对路径。输出是一份 JSON，不开始录音：

- Windows：仅列出 WASAPI loopback，使用 ID 展示，避免不必要的友好名称属性读取。
- Linux：仅列出 monitor source。
- macOS：列出 CoreAudio 输入，`recommended: true` 标出已识别的虚拟设备。

Host 状态路由新增 `platform` 与 `capture` 字段，包含实际后端、设备 ID/名称、采集声道数与是否跟随默认输出。浏览器 `__railMusic.status()` 继续提供连接和轨道状态。只有 `ready` 和真实音频帧持续到达，才能确认采集工作；只看到设备名称不等于音乐已经正确路由。

## 测试范围

```bash
python test/audio_devices.test.py
python test/analyser.test.py
npm test
```

设备测试不导入 SoundCard，也不开声卡，适合所有 CI 平台。GitHub Actions 已配置 Windows/Linux/macOS 的检查矩阵；Linux 另有真实 PulseAudio null-sink 采集任务，使用 CI 专用静音输出，不通过扬声器播放测试音。本次尚未推送或执行这些云端任务。

macOS 实机验收仍需：正确路由的虚拟输入、授权后的持续录音、静音恢复、设备断开/重连、耳机更换及停用退出。Linux 实机需要覆盖 PulseAudio 和 PipeWire 两种服务。不能把模拟设备测试或 CI 里的虚拟 sink 当作全部桌面设备已经验证。

参考：[SoundCard 文档](https://soundcard.readthedocs.io/en/latest/) · [PipeWire PulseAudio 兼容服务](https://docs.pipewire.org/page_man_pipewire-pulse_1.html) · [BlackHole](https://github.com/ExistentialAudio/BlackHole)
