# OpenMirror 开发计划

> 一款开源、跨平台、对标 AirServer 的无线投屏接收软件。
> 项目代号：**OpenMirror**　许可证：GPL-3.0　文档版本：2026-07-16

---

## 1. 目标与对标分析

### 1.1 AirServer 是什么

AirServer 是一款商业投屏**接收端**软件：把一台 PC/Mac 变成"电视/机顶盒"，让手机、平板、电脑通过系统自带的投屏功能把画面无线投到这台机器上。其核心能力：

| 能力 | 协议 | 发送端 |
|---|---|---|
| 屏幕镜像 + 音频 | AirPlay Mirroring | iPhone / iPad / Mac |
| 纯音频 | AirPlay Audio (RAOP) | iOS / macOS / iTunes |
| 屏幕镜像 / 投放 | Google Cast | Android / Chrome 浏览器 |
| 屏幕镜像 | Miracast (Wi-Fi Direct) | Windows / 部分 Android |
| 多路同屏 | — | 多台设备同时投屏、分屏显示 |

### 1.2 我们的目标

**做一个开源替代品**，按价值排序分阶段支持：

1. **AirPlay 镜像接收**（价值最高，iOS 设备无第三方 App 即可投屏）——首要目标
2. **AirPlay 音频接收（RAOP）**——与镜像共享大部分协议栈，顺带完成
3. **Google Cast 接收**——第二阶段
4. **Miracast 接收**——最后阶段（依赖 OS 的 Wi-Fi Direct 栈，跨平台难度最大）

跨平台目标：Windows / macOS / Linux。

### 1.3 现有开源参考（协议依据）

- **UxPlay / RPiPlay / shairplay**（C，GPL）：AirPlay 镜像接收的成熟实现，协议流程可参考
- **pyatv / owntone**：RAOP 与 AirPlay 2 协议文档化程度高
- **openairplay/airplay2-receiver**（Python）：AirPlay 2 协议研究性实现
- **fcast / MirrorCast** 等：Cast 协议参考

> 注意许可证兼容性：参考 GPL 项目的协议知识没有问题，但若移植代码则整个项目须 GPL。我们选择 **GPL-3.0**，与生态一致且保证衍生品开源。

---

## 2. 协议栈拆解（AirPlay 镜像，首要目标）

iOS 设备投屏到接收端的完整链路：

```
①发现        ②信息交换      ③配对/加密        ④会话建立         ⑤媒体流
mDNS/Bonjour → RTSP GET /info → pair-setup      → SETUP (plist)   → 视频: TCP 端口, H.264
_airplay._tcp                  → pair-verify    → SETUP 2nd       → 音频: UDP RTP, AAC-ELD
_raop._tcp                     → fp-setup       → RECORD          → 时钟: NTP/PTP 同步
                                (FairPlay DRM)                     → 事件: 反向 HTTP 通道
```

各层要点：

1. **发现层（mDNS/Bonjour）**：在组播 `224.0.0.251:5353` 上应答 `_airplay._tcp.local` 与 `_raop._tcp.local` 的 PTR/SRV/TXT 查询，TXT 记录声明设备能力（features 位掩码）、设备 ID（MAC）、公钥等。features 位掩码决定 iOS 端展示什么能力、走什么协议分支——是兼容性调试的核心。
2. **控制层（RTSP over TCP）**：非标准 RTSP——方法有 `GET /info`、`POST /pair-setup`、`POST /pair-verify`、`POST /fp-setup`、`SETUP`、`RECORD`、`SET_PARAMETER`、`GET_PARAMETER`、`TEARDOWN`、`POST /feedback`。消息体大量使用 **二进制 plist（bplist00）**。
3. **加密层**：
   - *legacy pair-verify*（features bit 后接非 HomeKit 路径）：ed25519 设备身份 + x25519 ECDH → 共享密钥 → AES-128-CTR 加密签名交换。
   - *HomeKit 透明配对*（AirPlay 2）：SRP6a + HKDF + ChaCha20-Poly1305（pin 配对时用）。
   - *FairPlay*：Apple 私有 DRM，用于加密 AES 流密钥。开源实现（UxPlay/shairplay 系）通过已被逆向的 fp-setup 交换计算流密钥。
4. **视频流**：单独 TCP 端口，128 字节头 + H.264 裸流（AVCC），AES-CTR 解密后送解码器。
5. **音频流**：UDP RTP，AAC-ELD（镜像时）或 ALAC（RAOP），AES-CBC 解密。
6. **时钟同步**：NTP 风格 timing 通道（AirPlay 2 用 PTP），用于音画同步。

---

## 3. 总体架构

```
┌────────────────────────────────────────────────────────┐
│                     应用层（分阶段）                      │
│   apps/cli（先行：无 UI 接收器/协议验证）                  │
│   apps/desktop（后续：Electron/Tauri，渲染+托盘+设置）     │
├────────────────────────────────────────────────────────┤
│              核心协议库  packages/core（纯 JS，零依赖）     │
│  discovery/  mDNS 应答器 + DNS 报文编解码                  │
│  rtsp/       增量式 RTSP/HTTP 解析器 + 服务器              │
│  plist/      二进制 plist (bplist00) 编解码               │
│  crypto/     pair-setup / pair-verify / 流密钥派生        │
│  stream/     视频(TCP)/音频(UDP RTP)接收、解密、去包头      │
│  cast/       (M5) Google Cast 接收协议                    │
├────────────────────────────────────────────────────────┤
│              媒体层  packages/media                         │
│  ffplay.js   H.264 Annex-B 低延迟播放、背压与进程管理       │
│  (后续)      AAC 解码/音频输出、WebCodecs 桌面渲染          │
└────────────────────────────────────────────────────────┘
```

**设计原则**：

- 协议核心与媒体/UI 严格分层：核心库不依赖任何原生模块，可独立测试、可被任何前端复用。
- 每层可单独验证：DNS 编解码、plist、RTSP 解析、加密握手全部有单元测试，不依赖真机即可回归。
- 真机联调放在每个里程碑末尾：用 iPhone/Mac 实测发现与握手。

**技术选型**：

| 部分 | 选型 | 理由 |
|---|---|---|
| 协议核心 | Node.js ≥ 20, 纯 ESM, 零第三方依赖 | node:crypto 原生支持 ed25519/x25519/AES；node:dgram/net 足够实现 mDNS/RTSP；零依赖免除供应链与安装问题 |
| 解码 | 阶段一用 ffmpeg 子进程/WebCodecs；阶段二评估原生绑定 | 快速可用，跨平台一致 |
| 桌面 UI | Electron（内置 WebCodecs/WebAudio，可直接解码渲染）| 一套代码三平台；Tauri 作为候选（体积小但媒体栈需自带）|
| 测试 | node:test（内置） | 零依赖 |
| CI | GitHub Actions（三平台矩阵） | 开源标配 |

---

## 4. 里程碑

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 项目奠基** | monorepo、许可证、README、CI 骨架、本计划 | 仓库可 clone 即测 |
| **M1 服务发现** | DNS 报文编解码；mDNS 应答器（通告、应答、goodbye）；AirPlay/RAOP TXT 记录 | iPhone 控制中心"屏幕镜像"列表中出现设备名 |
| **M2 控制通道** | bplist00 编解码；增量式 RTSP 解析器；RTSP 服务器；`GET /info` | iPhone 点击设备后能完成 /info 交换（抓包验证） |
| **M3 配对与加密** | legacy pair-setup/pair-verify（ed25519+x25519+AES-CTR）；fp-setup（FairPlay 密钥交换）；SETUP 解析与端口分配 | 与 iPhone 完成握手，进入 RECORD 状态 |
| **M4 媒体流（MVP 达成）** | 视频 TCP 通道收流+解密+去头 → H.264 送 ffmpeg/WebCodecs 解码渲染；音频 RTP+AAC-ELD；音画同步 | iPhone 镜像画面流畅显示在接收端窗口 |
| **M5 桌面应用 + RAOP** | Electron 壳、托盘、设置（设备名/PIN/多显示器）；RAOP 纯音频；打包三平台安装包 | 普通用户可下载安装使用 |
| **M6 Google Cast** | mDNS `_googlecast._tcp`、TLS 8009、protobuf CastChannel、镜像 app | Android/Chrome 可投放 |
| **M7 Miracast（评估）** | Windows 上依托 OS Wi-Fi Direct API 评估可行性 | 可行性报告 + 原型 |

**当前实现进度**：M0、M1、M2 已完成；M3 已完成 pair-setup/pair-verify、SETUP 解析及媒体端口分配，并集成 GPL PlayFair/SAPv2.5 的无宿主导入 WebAssembly provider，可完成四模式 fp-setup 与 72 字节 `ekey` → 16 字节媒体密钥解包；M4 已具备镜像 TCP 帧增量解析、AES 视频/音频解密器、H.264 avcC 参数集解析与 AVCC→Annex-B 转换、音频 RTP 解包和重排序、NTP timing 自动应答、eventPort 反向 HTTP/bplist 事件通道，以及独立 `packages/media` 的 ffplay 低延迟视频窗口。**尚未完成**：AAC 解码/输出与精确音画同步、真机互操作回归、M5 桌面应用与完整 RAOP。

---

## 5. 目录结构

```
/
├─ docs/DEVELOPMENT_PLAN.md      本计划
├─ packages/core/                协议核心库 @openmirror/core
│   └─ src/
│       ├─ discovery/            dns.js（编解码）、responder.js（mDNS 应答器）、airplay.js（TXT 记录）
│       ├─ plist/                bplist.js（bplist00 编解码）
│       ├─ rtsp/                 parser.js（增量解析）、server.js（RTSP 服务器）
│       ├─ crypto/               pairing.js（pair-setup/verify）、fairplay.js（fp-setup）、playfair-provider.js/WASM（密钥解包）、stream.js（流解密）
│       ├─ stream/               mirror.js（镜像 TCP/UDP 传输）、h264.js（AVCC→Annex-B）、rtp.js（音频 RTP）、timing.js（NTP 应答）
│       └─ index.js              总入口 AirPlayReceiver
├─ apps/cli/                     命令行接收器（协议验证用）
├─ packages/media/               ffplay 视频输出与媒体进程管理
└─ test/ (packages/core/test)    单元测试
```

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| FairPlay 为 Apple 私有 DRM | 无法解密流密钥 → 无画面 | 采用社区已公开的 fp-setup 实现路径（UxPlay 等已验证多年）；features 位掩码选择 legacy 路径降低复杂度 |
| iOS 版本更新改变协议行为 | 握手失败 | features 位掩码保守声明；跟踪 UxPlay/pyatv 社区 issue |
| 法律/商标 | 项目名或宣传语侵权 | 不使用 AirPlay/AirServer 商标做项目名；README 声明非官方、仅互操作 |
| Miracast 跨平台几乎不可行 | 功能缺失 | 明确降级为 Windows-only 或砍掉，投屏三协议中价值最低 |
| 纯 JS 性能（解密/去头） | 高分辨率丢帧 | AES-CTR 走 node:crypto（OpenSSL 原生）；瓶颈实测后再考虑原生模块 |

## 7. 开源治理

- 许可证：GPL-3.0（与参考生态一致，保证衍生开源）
- 贡献流程：GitHub PR + CI 必须绿；协议行为改动须附抓包/真机验证说明
- 版本策略：`0.x` 阶段每完成一个里程碑发一个 minor
