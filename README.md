# OpenMirror

开源、跨平台的无线投屏**接收端**软件（对标 AirServer）。把你的 Windows / macOS / Linux 电脑变成投屏接收器：iPhone/iPad 通过系统自带的"屏幕镜像"（AirPlay）、Android/Chrome 通过 Google Cast，即可把画面无线投到这台电脑上。

> 状态：早期开发中。当前已实现 mDNS 服务发现、RTSP 控制通道、二进制 plist 编解码、AirPlay legacy 配对、真实 PlayFair/SAPv2.5 媒体密钥解包及 pair-verify 密钥绑定、镜像 TCP/音频 RTP 接收、主动 NTP timing 校时、音频 RTP↔NTP 锚定、反向 HTTP 事件通道、H.264 Annex-B 转换与 SPS 分辨率/方向识别，以及 AAC-ELD→RFC 3640 RTP→ffplay 解码/输出。音视频使用同一远端时钟安排呈现；接收器还提供 RTP 丢包/重排、延迟、A/V 偏差和时钟漂移统计，并能在 FLUSH、锁屏静默、旋转、RTSP 异常断开与重新连接时回收/重建播放器。详见 [真机互操作回归](docs/INTEROPERABILITY_TESTING.md)和[开发计划](docs/DEVELOPMENT_PLAN.md)。

## 快速开始

```bash
npm install        # 零第三方依赖，仅链接 workspace
npm test           # 运行协议层单元测试
npm start          # 启动 CLI 接收器（mDNS 通告 + RTSP 服务）
```

CLI 会为可解密的 H.264 镜像流启动 `ffplay` 视频窗口，并为 AAC-ELD 启动独立的低延迟音频解码进程；请先安装 FFmpeg（包含 ffplay）。服务器或 CI 环境可使用 `npm start -- --headless`，只关闭声音可使用 `--mute`，自定义路径可使用 `--ffplay <path>`。

启动后，同一局域网内的 iPhone 打开控制中心 → 屏幕镜像，应能看到 `OpenMirror` 设备。

真机回归时建议同时写入脱敏 JSONL 报告：

```bash
npm start -- --verbose --diagnostics .openmirror-diagnostics/iphone.jsonl
```

报告不保存网络地址、设备名、RTSP/媒体原始负载、配对秘密或 PlayFair 密钥材料。可用 `--stats-interval 2` 调整统计周期；`--video-idle-ms` 和 `--media-idle-ms` 可调整锁屏/断流后的播放器回收时间。

Windows 真机回归可在**与 iPhone/iPad 同一物理 Wi‑Fi/LAN 的管理员 PowerShell**中运行：

```powershell
.\tools\run-windows-interoperability.ps1
```

脚本会预检 ffplay/workspace/LAN 地址，创建仅限 `node.exe` 与 `LocalSubnet` 的临时 TCP/UDP 规则，并在规则创建失败、异常或正常退出时自动删除；测试结束后还会询问实际画面、声音、旋转、锁屏和重连结果。完成后可重复分析已经包含现场确认的报告：

```bash
npm run interop:report -- .openmirror-diagnostics/iphone.jsonl
```

手动启动接收器后首次生成严格报告时，请追加 `--confirm` 录入不含设备信息的现场确认：

```bash
npm run interop:report -- .openmirror-diagnostics/iphone.jsonl --confirm
```

## 仓库结构

- `packages/core` — 协议核心库（纯 JS、零依赖）：mDNS/DNS、RTSP、bplist、配对加密
- `packages/media` — 媒体输出适配器：低延迟 ffplay H.264 播放、AAC-ELD/RFC 3640 音频、共享时钟调度与进程生命周期
- `apps/cli` — 命令行接收器，用于协议开发与联调
- `docs/INTEROPERABILITY_TESTING.md` — iPhone/iPad 真机端到端回归步骤与判定标准
- `docs/DEVELOPMENT_PLAN.md` — 详细开发计划（架构、协议拆解、里程碑、风险）

## 法律声明

本项目为独立的开源实现，与 Apple Inc.、Google LLC、App Dynamic（AirServer）均无关联。AirPlay、AirServer、Google Cast、Miracast 为其各自所有者的商标。本项目仅出于互操作性目的实现相关网络协议。

## 许可证

GPL-3.0
