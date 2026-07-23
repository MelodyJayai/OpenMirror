// WebCodecs H.264 rendering: the main process forwards decrypted Annex-B
// access units; keyframes are prefixed with the latest parameter sets so the
// decoder can (re)start mid-stream. Audio arrives as normalized PCM (played
// through the WebAudio graph) or AAC-ELD access units (WebCodecs AudioDecoder).

import { AudioGraph, hexToBytes } from './audio-graph.js';

const canvas = document.getElementById('video');
const context = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayAddress = document.getElementById('overlay-address');
const statusLine = document.getElementById('status');

let decoder = null;
let parameterSets = null;
let codecString = null;
let awaitingKeyframe = true;
let fallbackTimestampUs = 0;

function setStatus(message) {
  statusLine.textContent = message;
}

function showOverlay() {
  overlay.classList.remove('hidden');
}

function codecFromSps(sps) {
  const hex = (value) => value.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

function concat(a, b) {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}

function closeDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  awaitingKeyframe = true;
}

function paint(frame) {
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }
  context.drawImage(frame, 0, 0, canvas.width, canvas.height);
  frame.close();
  overlay.classList.add('hidden');
}

function configureDecoder({ sps, annexB }) {
  parameterSets = new Uint8Array(annexB);
  codecString = codecFromSps(new Uint8Array(sps));
  closeDecoder();
  if (typeof VideoDecoder !== 'function') {
    setStatus('此环境不支持 WebCodecs VideoDecoder');
    return;
  }
  decoder = new VideoDecoder({
    output: paint,
    error: (error) => {
      setStatus(`解码错误：${error.message}`);
      closeDecoder();
    },
  });
  decoder.configure({ codec: codecString, optimizeForLatency: true });
  awaitingKeyframe = true;
  setStatus(`H.264 ${codecString}`);
}

window.openmirror.onCodec(configureDecoder);

window.openmirror.onVideo(({ annexB, keyframe, presentationTimeMs }) => {
  if (!decoder || decoder.state !== 'configured') return;
  if (awaitingKeyframe && !keyframe) return;
  const payload = new Uint8Array(annexB);
  const data = keyframe && parameterSets ? concat(parameterSets, payload) : payload;
  fallbackTimestampUs = presentationTimeMs != null
    ? Math.max(fallbackTimestampUs + 1, Math.round(presentationTimeMs * 1000))
    : fallbackTimestampUs + 16667;
  try {
    decoder.decode(new EncodedVideoChunk({
      type: keyframe ? 'key' : 'delta',
      timestamp: fallbackTimestampUs,
      data,
    }));
    awaitingKeyframe = false;
  } catch (error) {
    setStatus(`解码错误：${error.message}`);
    closeDecoder();
  }
});

const audioGraph = new AudioGraph();
let aacDecoder = null;
let aacUnsupported = false;
let aacFallbackTimestampUs = 0;

function closeAacDecoder() {
  if (aacDecoder && aacDecoder.state !== 'closed') aacDecoder.close();
  aacDecoder = null;
}

async function ensureAacDecoder({ config, sampleRate, channels }) {
  if (aacUnsupported) return null;
  if (aacDecoder && aacDecoder.state === 'configured') return aacDecoder;
  if (typeof AudioDecoder !== 'function') {
    aacUnsupported = true;
    setStatus('此环境不支持 WebCodecs AudioDecoder，AAC-ELD 音频已禁用');
    return null;
  }
  const decoderConfig = {
    codec: 'mp4a.40.39',
    sampleRate,
    numberOfChannels: channels,
    description: hexToBytes(config),
  };
  const support = await AudioDecoder.isConfigSupported(decoderConfig).catch(() => null);
  if (!support?.supported) {
    aacUnsupported = true;
    setStatus('此环境不支持 AAC-ELD 音频解码');
    return null;
  }
  aacDecoder = new AudioDecoder({
    output: (audioData) => {
      const planes = [];
      for (let channel = 0; channel < audioData.numberOfChannels; channel++) {
        const plane = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
        planes.push(plane);
      }
      audioGraph.playPlanar({
        planes,
        sampleRate: audioData.sampleRate,
        presentationTimeMs: audioData.timestamp / 1000,
      });
      audioData.close();
    },
    error: (error) => {
      setStatus(`音频解码错误：${error.message}`);
      closeAacDecoder();
    },
  });
  aacDecoder.configure(decoderConfig);
  return aacDecoder;
}

window.openmirror.onAudio((packet) => {
  if (packet.kind === 'pcm') {
    const raw = packet.pcm instanceof Uint8Array ? packet.pcm : new Uint8Array(packet.pcm);
    // Int16Array views require 2-byte alignment; IPC buffers may not have it.
    const bytes = raw.byteOffset % 2 === 0 ? raw : raw.slice();
    audioGraph.playPcm({
      pcm: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
      sampleRate: packet.sampleRate,
      channels: packet.channels,
      presentationTimeMs: packet.presentationTimeMs,
    });
    return;
  }
  if (packet.kind !== 'aac-eld') return;
  ensureAacDecoder(packet).then((decoder) => {
    if (!decoder) return;
    aacFallbackTimestampUs = packet.presentationTimeMs != null
      ? Math.max(aacFallbackTimestampUs + 1, Math.round(packet.presentationTimeMs * 1000))
      : aacFallbackTimestampUs + Math.round(1e6 * 480 / packet.sampleRate);
    try {
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: aacFallbackTimestampUs,
        data: new Uint8Array(packet.data),
      }));
    } catch (error) {
      setStatus(`音频解码错误：${error.message}`);
      closeAacDecoder();
    }
  });
});

window.openmirror.onVolume(({ volumeDb, muted }) => {
  audioGraph.setVolume({ volumeDb, muted });
});

window.openmirror.onReset(() => {
  closeDecoder();
  closeAacDecoder();
  audioGraph.reset();
  showOverlay();
});

window.openmirror.onStatus(({ message }) => setStatus(message));

function renderReceiverInfo(info) {
  if (!info || !info.port) return;
  overlayTitle.textContent = info.name ?? 'OpenMirror';
  const addresses = info.addresses?.length ? info.addresses.join(', ') : '未找到局域网地址';
  overlayAddress.textContent = `${addresses} — 端口 ${info.port}`;
}

window.openmirror.onReceiverInfo(renderReceiverInfo);
window.openmirror.getReceiverInfo().then(renderReceiverInfo);
