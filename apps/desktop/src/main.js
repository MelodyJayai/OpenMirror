// Electron main process: hosts the AirPlayReceiver, forwards H.264 access
// units to the renderer for WebCodecs decoding, and provides the tray +
// settings shell. Audio is normalized here (ALAC decoded in-process, RAOP L16
// byte-swapped) and handed to the renderer's WebAudio graph; AAC-ELD access
// units go through the renderer's WebCodecs AudioDecoder.

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } from 'electron';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AirPlayReceiver, localIPv4Addresses } from '@openmirror/core';
import { AAC_ELD_CONFIG, alacDecoderFromAnnounce } from '@openmirror/media';
import { loadSettings, pickDisplay, saveSettings } from './settings.js';

const appDir = dirname(fileURLToPath(import.meta.url));
const smokeTest = process.env.OPENMIRROR_SMOKE === '1';

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let receiver = null;
let settings = null;
let quitting = false;
let receiverInfo = { name: null, port: null, addresses: [] };

const settingsFile = () => join(app.getPath('userData'), 'settings.json');

let logPath = null;
function logEvent(kind, detail = {}) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ t: new Date().toISOString(), kind, ...detail })}\n`);
  } catch {
    // Diagnostics must never break the receiver.
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function broadcastStatus(message) {
  send('om:status', { message, at: Date.now() });
}

function broadcastReceiverInfo() {
  send('om:receiver-info', receiverInfo);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('om:receiver-info', receiverInfo);
  }
}

async function startReceiver() {
  const instance = new AirPlayReceiver({ name: settings.name, port: settings.port });
  receiver = instance;
  const raopAnnounces = new Map();
  const alacDecoders = new Map();
  const counters = { videoFrame: 0, videoData: 0, audioData: 0 };
  instance.on('error', (error) => {
    logEvent('error', { message: error.message });
    broadcastStatus(`接收器错误：${error.message}`);
  });
  instance.on('warning', (error) => logEvent('warning', { message: error.message }));
  instance.on('session-opened', (session) => {
    logEvent('session-opened', { remote: session.remoteAddress });
    broadcastStatus(`${session.remoteAddress} 已连接`);
  });
  instance.on('session-closed', (session) => {
    logEvent('session-closed', { remote: session.remoteAddress });
    broadcastStatus(`${session.remoteAddress} 已断开`);
    raopAnnounces.delete(session);
    alacDecoders.delete(session);
    send('om:reset');
  });
  instance.on('request', ({ method, uri, bodyBytes }) => logEvent('rtsp', { method, uri, bodyBytes }));
  instance.on('fp-setup', ({ phase, bytes }) => logEvent('fp-setup', { phase, bytes }));
  instance.on('paired', () => logEvent('paired'));
  instance.on('setup', ({ payload, crypto }) => logEvent('setup', {
    crypto,
    streamTypes: Array.isArray(payload?.streams) ? payload.streams.map((s) => s.type) : [],
  }));
  instance.on('record', () => logEvent('record'));
  instance.on('video-connection', (event) => logEvent('video-connection', { activeConnections: event.activeConnections }));
  instance.on('video-disconnection', (event) => logEvent('video-disconnection', { activeConnections: event.activeConnections }));
  instance.on('video-frame', ({ type, payload, encrypted }) => {
    counters.videoFrame++;
    if (counters.videoFrame <= 5 || counters.videoFrame % 300 === 0) {
      logEvent('video-frame', { n: counters.videoFrame, type, bytes: payload?.length ?? 0, encrypted });
    }
  });
  instance.on('media-state', ({ component, state, reason }) => {
    logEvent('media-state', { component, state, reason });
    // iOS pauses the mirror stream entirely while a fullscreen video is paused
    // ("playing on external display" mode) — surface it so a frozen last frame
    // reads as sender-side silence rather than a receiver hang.
    if (component !== 'video') return;
    if (state === 'idle') broadcastStatus('发送端画面已暂停（无新帧）');
    else if (reason === 'resumed') broadcastStatus('发送端画面已恢复');
  });
  instance.on('teardown', ({ session, streamTypes, partial }) => {
    logEvent('teardown', { streamTypes, partial });
    if (partial) {
      // Audio-only stream teardown (leaving a video app) keeps the mirror
      // alive; only reset the renderer when the video stream itself is gone.
      if (streamTypes.some((type) => type !== 96)) send('om:reset');
      return;
    }
    raopAnnounces.delete(session);
    alacDecoders.delete(session);
    send('om:reset');
  });
  instance.on('flush', () => {
    logEvent('flush');
    send('om:reset');
  });
  instance.on('video-codec', ({ sps, annexB, dimensions }) => {
    logEvent('video-codec', { dimensions });
    // parseAvcC yields sps as Buffer[]; the renderer derives the codec string
    // from the first (and in practice only) SPS.
    send('om:codec', { sps: sps?.[0], annexB });
  });
  instance.on('video-data', ({ annexB, keyframe, timing }) => {
    counters.videoData++;
    // Keyframes are rare (codec changes, refreshes) and mark exactly where the
    // renderer can (re)start decoding — always log them.
    if (keyframe || counters.videoData <= 5 || counters.videoData % 300 === 0) {
      logEvent('video-data', { n: counters.videoData, bytes: annexB?.length ?? 0, keyframe });
    }
    send('om:video', {
      annexB,
      keyframe,
      presentationTimeMs: timing?.presentationTimeMs ?? null,
    });
  });
  instance.on('announce', ({ session, codec, encryption, sampleRate, channels, alac }) => {
    logEvent('announce', { codec, encryption, sampleRate, channels });
    broadcastStatus(`${session.remoteAddress} RAOP 音频会话（${codec ?? 'unknown'}，${encryption}）`);
    raopAnnounces.set(session, { sampleRate, channels, alac });
    alacDecoders.delete(session);
  });
  instance.on('audio-data', (packet) => {
    counters.audioData++;
    if (counters.audioData <= 5 || counters.audioData % 500 === 0) {
      logEvent('audio-data', {
        n: counters.audioData,
        ct: packet.compressionType,
        bytes: packet.payload?.length ?? 0,
        encrypted: packet.encrypted,
      });
    }
    if (packet.encrypted) return;
    const { session, payload, timing } = packet;
    const presentationTimeMs = timing?.presentationTimeMs ?? null;
    if (packet.compressionType === 8) {
      send('om:audio', {
        kind: 'aac-eld',
        config: AAC_ELD_CONFIG,
        sampleRate: packet.sampleRate ?? 44100,
        channels: 2,
        data: payload,
        presentationTimeMs,
      });
      return;
    }
    const announce = raopAnnounces.get(session);
    const base = {
      kind: 'pcm',
      sampleRate: packet.sampleRate ?? announce?.sampleRate ?? 44100,
      channels: announce?.channels ?? 2,
      presentationTimeMs,
    };
    if (packet.compressionType === 2) {
      let alacDecoder = alacDecoders.get(session);
      if (!alacDecoder) {
        try {
          alacDecoder = alacDecoderFromAnnounce(announce);
        } catch {
          return;
        }
        alacDecoders.set(session, alacDecoder);
      }
      try {
        const { samples } = alacDecoder.decode(payload);
        send('om:audio', {
          ...base,
          pcm: Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2),
        });
      } catch {
        // Corrupt ALAC frames are dropped; the stream resynchronizes itself.
      }
      return;
    }
    if (packet.compressionType === 1 && payload.length && payload.length % 2 === 0) {
      send('om:audio', { ...base, pcm: Buffer.from(payload).swap16() });
    }
  });
  instance.on('volume', ({ volumeDb, muted }) => {
    logEvent('volume', { volumeDb, muted });
    broadcastStatus(muted ? '发送端已静音' : `发送端音量 ${volumeDb} dB`);
    send('om:volume', { volumeDb, muted });
  });
  instance.on('stream-error', ({ type, error }) => {
    logEvent('stream-error', { type, message: error?.message });
    broadcastStatus(`媒体流错误（${type ?? 'pipeline'}）：${error.message}`);
  });
  const { port } = await instance.start();
  receiverInfo = {
    name: settings.name,
    port,
    addresses: localIPv4Addresses().map((address) => address.address),
  };
  broadcastReceiverInfo();
  updateTray();
  return port;
}

async function stopReceiver() {
  const instance = receiver;
  receiver = null;
  if (instance) await instance.stop().catch(() => {});
}

async function restartReceiver() {
  await stopReceiver();
  send('om:reset');
  await startReceiver();
}

function trayIcon() {
  // 16x16 raw BGRA rounded square so we do not need binary icon assets.
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= 1 && x <= 14 && y >= 1 && y <= 14
        && !((x <= 2 || x >= 13) && (y <= 2 || y >= 13));
      if (!inside) continue;
      const offset = (y * size + x) * 4;
      bitmap[offset] = 0xd4;
      bitmap[offset + 1] = 0xa0;
      bitmap[offset + 2] = 0x2a;
      bitmap[offset + 3] = 0xff;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`OpenMirror — ${receiverInfo.name ?? settings.name} (端口 ${receiverInfo.port ?? '-'})`);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showMainWindow() },
    { label: '设置…', click: () => openSettingsWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('double-click', () => showMainWindow());
  updateTray();
}

function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    label: display.label || `显示器 ${index + 1}`,
    bounds: { ...display.bounds },
    primary: display.id === primaryId,
  }));
}

function applyDisplaySettings(window) {
  if (!window || window.isDestroyed()) return;
  const target = pickDisplay(listDisplays(), settings.display);
  if (target) {
    const current = screen.getDisplayMatching(window.getBounds());
    if (current.id !== target.id) {
      if (window.isFullScreen()) window.setFullScreen(false);
      const [width, height] = window.getSize();
      const { bounds } = target;
      window.setBounds({
        x: bounds.x + Math.max(0, Math.round((bounds.width - width) / 2)),
        y: bounds.y + Math.max(0, Math.round((bounds.height - height) / 2)),
        width: Math.min(width, bounds.width),
        height: Math.min(height, bounds.height),
      });
    }
  }
  if (window.isFullScreen() !== settings.fullscreen) {
    window.setFullScreen(settings.fullscreen);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#101418',
    title: 'OpenMirror',
    webPreferences: {
      preload: join(appDir, 'preload.cjs'),
    },
  });
  mainWindow.setMenuBarVisibility(false);
  applyDisplaySettings(mainWindow);
  // The menu bar is hidden, so Electron's default F11 accelerator never fires.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    } else if (input.key === 'Escape' && mainWindow.isFullScreen()) {
      event.preventDefault();
      mainWindow.setFullScreen(false);
    }
  });
  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) logEvent('renderer-console', { level, message });
    if (smokeTest) console.log(`[renderer:${level}] ${message}`);
  });
  mainWindow.loadFile(join(appDir, 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    if (quitting) return;
    // Keep receiving in the tray like other receiver apps.
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.webContents.on('did-finish-load', () => broadcastReceiverInfo());
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 420,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'OpenMirror 设置',
    backgroundColor: '#101418',
    webPreferences: {
      preload: join(appDir, 'preload.cjs'),
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(join(appDir, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

ipcMain.handle('om:toggle-fullscreen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});
ipcMain.handle('om:get-settings', () => ({ ...settings }));
ipcMain.handle('om:get-receiver-info', () => ({ ...receiverInfo }));
ipcMain.handle('om:get-displays', () => listDisplays());
ipcMain.handle('om:save-settings', async (event, raw) => {
  const previous = settings;
  settings = await saveSettings(settingsFile(), raw);
  applyDisplaySettings(mainWindow);
  if (settings.name !== previous.name || settings.port !== previous.port) {
    await restartReceiver();
  }
  return { settings: { ...settings }, receiver: { ...receiverInfo } };
});

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    if (smokeTest) console.log('[smoke] app ready');
    logPath = join(app.getPath('userData'), 'openmirror.log');
    try {
      writeFileSync(logPath, '');
    } catch {
      logPath = null;
    }
    logEvent('app-start', { version: app.getVersion() });
    settings = await loadSettings(settingsFile());
    createTray();
    createMainWindow();
    if (smokeTest) console.log('[smoke] window created, starting receiver');
    try {
      const port = await startReceiver();
      if (smokeTest) console.log(`[smoke] receiver started on port ${port}`);
    } catch (error) {
      broadcastStatus(`接收器启动失败：${error.message}`);
      if (smokeTest) {
        console.error(`[smoke] receiver failed: ${error.message}`);
        process.exitCode = 1;
      }
    }
    if (smokeTest) setTimeout(() => app.quit(), 1500);
  });

  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', (event) => {
    if (!receiver) return;
    event.preventDefault();
    stopReceiver().finally(() => {
      if (smokeTest) console.log('[smoke] receiver stopped, exiting');
      // A re-entrant app.quit() after preventDefault does not reliably restart
      // the quit sequence; cleanup is done, so exit directly.
      app.exit(0);
    });
  });
  app.on('window-all-closed', () => {
    // Stay resident in the tray; quitting happens via the tray menu.
  });
}
