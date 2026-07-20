// Electron main process: hosts the AirPlayReceiver, forwards H.264 access
// units to the renderer for WebCodecs decoding, and provides the tray +
// settings shell. Audio playback still goes through the CLI's ffplay sinks;
// the desktop audio path lands with the unified WebAudio media graph.

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AirPlayReceiver, localIPv4Addresses } from '@openmirror/core';
import { loadSettings, saveSettings } from './settings.js';

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
  instance.on('error', (error) => broadcastStatus(`接收器错误：${error.message}`));
  instance.on('warning', () => {});
  instance.on('session-opened', (session) => broadcastStatus(`${session.remoteAddress} 已连接`));
  instance.on('session-closed', (session) => {
    broadcastStatus(`${session.remoteAddress} 已断开`);
    send('om:reset');
  });
  instance.on('teardown', () => send('om:reset'));
  instance.on('flush', () => send('om:reset'));
  instance.on('video-codec', ({ sps, annexB }) => send('om:codec', { sps, annexB }));
  instance.on('video-data', ({ annexB, keyframe, timing }) => send('om:video', {
    annexB,
    keyframe,
    presentationTimeMs: timing?.presentationTimeMs ?? null,
  }));
  instance.on('announce', ({ session, codec, encryption }) => {
    broadcastStatus(`${session.remoteAddress} RAOP 音频会话（${codec ?? 'unknown'}，${encryption}）`);
  });
  instance.on('volume', ({ volumeDb, muted }) => {
    broadcastStatus(muted ? '发送端已静音' : `发送端音量 ${volumeDb} dB`);
  });
  instance.on('stream-error', ({ type, error }) => {
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
  if (smokeTest) {
    mainWindow.webContents.on('console-message', (event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
  }
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

ipcMain.handle('om:get-settings', () => ({ ...settings }));
ipcMain.handle('om:get-receiver-info', () => ({ ...receiverInfo }));
ipcMain.handle('om:save-settings', async (event, raw) => {
  settings = await saveSettings(settingsFile(), raw);
  await restartReceiver();
  return { settings: { ...settings }, receiver: { ...receiverInfo } };
});

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    if (smokeTest) console.log('[smoke] app ready');
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
