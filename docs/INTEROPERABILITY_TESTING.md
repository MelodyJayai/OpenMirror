# iPhone/iPad AirPlay 真机互操作回归

本流程用于验证 OpenMirror 的真实 PlayFair 密钥协商、H.264 与 AAC-ELD 解密播放，以及旋转、锁屏、断线重连和时钟同步稳定性。

## 准备

- iPhone/iPad 与接收端位于同一局域网，网络允许 mDNS（UDP 5353）和设备间 TCP/UDP 通信。
- 接收器在 `_airplay._tcp`、`_raop._tcp` 与 `/info` 中统一使用经过真机验证的 legacy mirroring feature mask `0x5A7FFEE6`；不要为尚未实现的 HLS 或现代配对能力额外置位。
- `_airplay` TXT 与 `/info` 必须返回同一个、由设备 ID 确定性生成的 UUID 格式 `pi`，并显式广播 `pw=false`；这可以避免 iOS 把同一接收器误判成未建立信任的新端点。
- 初始 `GET /info` 的 `txtAirPlay`/`txtRAOP` qualifier 必须返回与 mDNS 广播相同的原始 TXT RDATA；完整 `/info` 使用 Apple 约定的 `deviceID`、`sourceVersion` 与状态/显示字段。
- CLI 默认持久保存设备 ID 与 Ed25519 私有身份；连续两次启动应打印相同的 `device id`，且不应删除或共享身份文件。可用 `--identity <path>` 为隔离测试指定专用身份。
- Node.js 20 或更高版本。
- 已安装包含 `ffplay` 的 FFmpeg，并可从终端执行 `ffplay -version`。
- 首次运行若 Windows/macOS 弹出防火墙提示，应允许当前局域网访问。

Windows 将网卡标记为 Public 时，系统可能在不弹窗的情况下阻止 Node.js 接收入站连接。若终端在手机打开“屏幕镜像”后仍提示 `no external AirPlay discovery query`，可由管理员临时创建仅限本地子网的 Node.js 入站规则：

```powershell
$node = (Get-Command node).Source
New-NetFirewallRule -DisplayName "OpenMirror Test TCP" -Direction Inbound -Action Allow -Program $node -Protocol TCP -RemoteAddress LocalSubnet
New-NetFirewallRule -DisplayName "OpenMirror Test UDP" -Direction Inbound -Action Allow -Program $node -Protocol UDP -RemoteAddress LocalSubnet
```

完成联调后删除：

```powershell
Remove-NetFirewallRule -DisplayName "OpenMirror Test TCP","OpenMirror Test UDP"
```

## 启动接收器

Windows 推荐从管理员 PowerShell 使用自动清理脚本：

```powershell
.\tools\run-windows-interoperability.ps1
```

脚本会先验证 Node.js、ffplay、npm workspace 和活动 LAN 地址，再创建仅允许
`node.exe`/`LocalSubnet` 的临时 TCP/UDP 入站规则；规则创建失败、CLI 异常或正常退出时
都会执行清理。只有一个带默认网关的 LAN 地址时会自动选用；检测到多个地址时必须使用
`-AdvertiseAddress` 明确指定。虚拟机必须使用桥接网络接入手机所在的同一二层 LAN。
如果管理员控制台被直接关闭而来不及执行清理，下次启动脚本会根据规则名中的失联进程 ID
自动回收遗留规则；仍在运行的其他 OpenMirror 回归进程所拥有的规则不会被删除。

当前机器有多个真实网卡时可明确指定手机所在 LAN 地址：

```powershell
.\tools\run-windows-interoperability.ps1 -AdvertiseAddress 192.168.1.20
```

macOS/Linux 或手动运行：

```bash
npm install
npm test
npm start -- --verbose --stats-interval 2 --diagnostics .openmirror-diagnostics/iphone.jsonl
```

若只验证协议和解密事件，可加 `--headless`；若只关闭声音，可加 `--mute`。

## 回归步骤

1. 在控制中心打开“屏幕镜像”，连接 `OpenMirror`。
2. 确认日志依次出现 pair-verify、两个 fp-setup 阶段、SETUP，以及 `key/video/audio=ready`。
3. 播放包含运动画面和声音的内容至少 60 秒，确认视频窗口和音频输出正常。
4. 在横屏与竖屏之间往返旋转两次，确认日志出现新的 H.264 分辨率/方向和 codec revision，播放器自动重建且继续播放。
5. 锁屏至少 10 秒后解锁，确认媒体进入 idle/closed，再出现 resumed；恢复后不应保留僵尸 ffplay 进程。
6. 在 iPhone/iPad 上停止镜像，再立即重新连接两次，确认每次都建立新会话且旧媒体端口/播放器被释放。
7. 连续播放 3–5 分钟，观察 RTP gap、音视频延迟、A/V 偏差和 clock drift；记录任何爆音、冻结、黑屏或持续漂移。
8. 正常停止镜像并在脚本窗口按 Enter；脚本会请求接收器优雅退出，确保 JSONL 最后包含 `session-report` 与 `final-snapshot`，然后继续现场确认。Ctrl+C 只用于异常中止，仍会清理临时规则，但不会进入确认步骤。
9. 回答脚本的五项现场确认；结果会以不含设备信息的 `manual-verification` 记录追加到 JSONL。

自动检查报告；手动启动接收器时使用 `--confirm` 录入现场观察：

```bash
npm run interop:report -- .openmirror-diagnostics/iphone.jsonl --confirm
```

只有 `run-start` 证明预期的 legacy feature mask、持久身份与 H.264/AAC-ELD 能力配置，并且完整且全部关闭的 `final-snapshot`、真实 PlayFair、H.264/AAC-ELD 管线证据与现场画面/声音确认、旋转、锁屏恢复、两次已清理媒体会话、RTP 指标、至少 30 秒时钟漂移统计以及零媒体/播放器错误全部满足时，验证器才返回 `PASS`。不带 `--confirm` 可重复分析已有报告，但报告中必须已经存在 `manual-verification`。

## 通过标准

- 会话报告中的 `crypto.sessionKeyReady` 为 `true`，对应媒体的 decryptor 为 ready。
- H.264 有有效 access unit 和关键帧，`encryptedVideoFrames` 为 0，ffplay 无持续解码错误，并现场确认画面可见。
- AAC-ELD 有解密后的音频包，`encryptedAudioPackets` 为 0，有 `playback.audio.forwarded` 计数，并现场确认声音可闻。
- 旋转后 `videoFormat.width/height/orientation/revision` 更新，播放自动恢复。
- FLUSH、锁屏静默、异常 RTSP 断开和主动 TEARDOWN 均会回收播放器；重连产生同一匿名 peer 的递增 `reconnectIndex`。
- iOS 的 `POST /feedback` 心跳计入 `counts.feedbacks`，首个心跳记录为 `milestones.firstFeedback`，用于区分仍活跃的控制会话与无心跳的异常断线。
- `streamErrors` 不持续增长；RTP 报告包含乱序/重复/迟到/最终缺口，以及 `retransmitRequests`、`retransmittedReceived`、`retransmittedRecovered` 和实际控制报文发送统计。弱网出现丢包时应优先由 `0x55/0x56` 重传恢复，`gapsSkipped`/`retransmitUnrecovered` 不应持续增长。
- iOS 启动 AAC-ELD 时的空 RTP 与 `00 68 34 00` 占位报文只推进序列号，并计入 `audioNoDataPackets`；它们不应计入已解密音频包、首个音频里程碑或延迟统计。
- 延迟 p95、A/V 偏差和 drift ppm 应结合实际网络记录并用于后续调优。

## 诊断数据说明

JSONL 报告只记录匿名 `runId` / `peer-N` / `session-N`、非敏感 capability profile、阶段、计数、格式、统计摘要、现场确认布尔值和脱敏错误文本。`run-start.capabilityProfile.featureMask` 可用于确认实际测试构建广播了预期的 feature mask。重复使用同一路径时，验证器只分析最后一个 `run-start` 之后的记录。它不会记录 IPv4/IPv6 地址、设备名、原始 RTSP 头/体、媒体负载、配对秘密、AES 密钥或 PlayFair 消息内容，因此可用于提交兼容性问题。若问题仍需抓包，应在获得网络参与者授权后单独采集并自行脱敏。
CLI 会在启动网络服务前同步追加 `run-start`；即使管理员终端随后被强制关闭，报告也应保留本次运行 ID 与 capability profile，而不是成为 0 字节文件。
