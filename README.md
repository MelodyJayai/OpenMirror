# OpenMirror

开源、跨平台的无线投屏**接收端**软件（对标 AirServer）。把你的 Windows / macOS / Linux 电脑变成投屏接收器：iPhone/iPad 通过系统自带的"屏幕镜像"（AirPlay）、Android/Chrome 通过 Google Cast，即可把画面无线投到这台电脑上。

> 状态：早期开发中。当前已实现 mDNS 服务发现、RTSP 控制通道、二进制 plist 编解码、AirPlay legacy 配对握手，以及 SETUP 媒体端口分配与镜像 TCP 帧接收。FairPlay 解密、音视频解码和渲染仍在开发。详见 [开发计划](docs/DEVELOPMENT_PLAN.md)。

## 快速开始

```bash
npm install        # 零第三方依赖，仅链接 workspace
npm test           # 运行协议层单元测试
npm start          # 启动 CLI 接收器（mDNS 通告 + RTSP 服务）
```

启动后，同一局域网内的 iPhone 打开控制中心 → 屏幕镜像，应能看到 `OpenMirror` 设备。

## 仓库结构

- `packages/core` — 协议核心库（纯 JS、零依赖）：mDNS/DNS、RTSP、bplist、配对加密
- `apps/cli` — 命令行接收器，用于协议开发与联调
- `docs/DEVELOPMENT_PLAN.md` — 详细开发计划（架构、协议拆解、里程碑、风险）

## 法律声明

本项目为独立的开源实现，与 Apple Inc.、Google LLC、App Dynamic（AirServer）均无关联。AirPlay、AirServer、Google Cast、Miracast 为其各自所有者的商标。本项目仅出于互操作性目的实现相关网络协议。

## 许可证

GPL-3.0
