# OpenMirror

开源、跨平台的无线投屏**接收端**软件（对标 AirServer）。把你的 Windows / macOS / Linux 电脑变成投屏接收器：iPhone/iPad 通过系统自带的"屏幕镜像"（AirPlay）、Android/Chrome 通过 Google Cast，即可把画面无线投到这台电脑上。

> 状态：早期开发中。当前已实现 mDNS 服务发现、RTSP 控制通道、二进制 plist 编解码、AirPlay legacy 配对、真实 PlayFair/SAPv2.5 媒体密钥解包及 pair-verify 密钥绑定、镜像 TCP/音频 RTP 接收、主动 NTP timing 校时、音频 RTP↔NTP 锚定、反向 HTTP 事件通道、H.264 Annex-B 转换，以及 AAC-ELD→RFC 3640 RTP→ffplay 解码/输出。音视频使用同一远端时钟安排呈现；真机互操作与延迟参数仍需持续回归。详见 [开发计划](docs/DEVELOPMENT_PLAN.md)。

## 快速开始

```bash
npm install        # 零第三方依赖，仅链接 workspace
npm test           # 运行协议层单元测试
npm start          # 启动 CLI 接收器（mDNS 通告 + RTSP 服务）
```

CLI 会为可解密的 H.264 镜像流启动 `ffplay` 视频窗口，并为 AAC-ELD 启动独立的低延迟音频解码进程；请先安装 FFmpeg（包含 ffplay）。服务器或 CI 环境可使用 `npm start -- --headless`，只关闭声音可使用 `--mute`，自定义路径可使用 `--ffplay <path>`。

启动后，同一局域网内的 iPhone 打开控制中心 → 屏幕镜像，应能看到 `OpenMirror` 设备。

## 仓库结构

- `packages/core` — 协议核心库（纯 JS、零依赖）：mDNS/DNS、RTSP、bplist、配对加密
- `packages/media` — 媒体输出适配器：低延迟 ffplay H.264 播放、AAC-ELD/RFC 3640 音频、共享时钟调度与进程生命周期
- `apps/cli` — 命令行接收器，用于协议开发与联调
- `docs/DEVELOPMENT_PLAN.md` — 详细开发计划（架构、协议拆解、里程碑、风险）

## 法律声明

本项目为独立的开源实现，与 Apple Inc.、Google LLC、App Dynamic（AirServer）均无关联。AirPlay、AirServer、Google Cast、Miracast 为其各自所有者的商标。本项目仅出于互操作性目的实现相关网络协议。

## 许可证

GPL-3.0
