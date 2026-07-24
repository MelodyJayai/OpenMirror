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

function createVideoDecoder() {
  closeDecoder();
  decoder = new VideoDecoder({
    output: paint,
    error: (error) => {
      console.warn(`video decoder error: ${error.message}`);
      setStatus(`解码错误：${error.message}`);
      closeDecoder();
    },
  });
  decoder.configure({ codec: codecString, optimizeForLatency: true });
  awaitingKeyframe = true;
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function configureDecoder({ sps, annexB }) {
  try {
    const newParameterSets = new Uint8Array(annexB);
    const spsBytes = new Uint8Array(sps);
    if (spsBytes.length < 4) throw new Error(`SPS 过短（${spsBytes.length} 字节）`);
    const newCodecString = codecFromSps(spsBytes);
    if (typeof VideoDecoder !== 'function') {
      setStatus('此环境不支持 WebCodecs VideoDecoder');
      return;
    }
    // Senders resend identical SPS/PPS on picture-in-picture and audio
    // toggles. Rebuilding the decoder there re-enters awaiting-keyframe and
    // freezes the picture until the next IDR arrives — which may be seconds
    // away — so only rebuild when the parameters actually change.
    if (decoder && decoder.state === 'configured'
      && newCodecString === codecString && sameBytes(newParameterSets, parameterSets)) {
      return;
    }
    parameterSets = newParameterSets;
    codecString = newCodecString;
    createVideoDecoder();
    console.warn(`video decoder configured as ${codecString}`);
    setStatus(`H.264 ${codecString}`);
  } catch (error) {
    console.warn(`video decoder configure failed: ${error.message}`);
    setStatus(`视频配置错误：${error.message}`);
    closeDecoder();
  }
}

window.openmirror.onCodec(configureDecoder);

let droppedAwaitingKeyframe = 0;
let decodedSinceBacklogWarn = 0;

window.openmirror.onVideo(({ annexB, keyframe, presentationTimeMs }) => {
  // A decoder killed by a mid-stream error can restart on any keyframe with
  // the cached parameter sets — mirror senders emit IDRs far more often than
  // codec changes, so this recovers without waiting for the next om:codec.
  if ((!decoder || decoder.state !== 'configured') && keyframe && codecString) {
    try {
      createVideoDecoder();
      console.warn(`video decoder rebuilt on keyframe as ${codecString}`);
    } catch (error) {
      console.warn(`video decoder rebuild failed: ${error.message}`);
      setStatus(`视频配置错误：${error.message}`);
      closeDecoder();
      return;
    }
  }
  if (!decoder || decoder.state !== 'configured') return;
  if (awaitingKeyframe && !keyframe) {
    droppedAwaitingKeyframe++;
    if (droppedAwaitingKeyframe === 1 || droppedAwaitingKeyframe % 300 === 0) {
      console.warn(`video dropped awaiting keyframe, total ${droppedAwaitingKeyframe}`);
    }
    return;
  }
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
    if (decoder.decodeQueueSize > 30 && ++decodedSinceBacklogWarn >= 120) {
      decodedSinceBacklogWarn = 0;
      console.warn(`video decode queue backlog: ${decoder.decodeQueueSize}`);
    }
  } catch (error) {
    console.warn(`video decode failed: ${error.message}`);
    setStatus(`解码错误：${error.message}`);
    closeDecoder();
  }
});

const audioGraph = new AudioGraph();
let aacDecoder = null;
let aacUnsupported = false;
let aacFallbackTimestampUs = 0;
// Chromium's WebCodecs whitelist rejects the honest 'mp4a.40.39' (AAC-ELD)
// codec string, but its FFmpeg-backed AAC decoder follows the
// AudioSpecificConfig in `description`, which declares ELD. Try the honest
// string first, then whitelisted AAC strings with the same ELD description.
const AAC_CODEC_CANDIDATES = ['mp4a.40.39', 'mp4a.40.2', 'mp4a.40.5'];
const failedAacCodecs = new Set();
// Chromium's FFmpeg audio decoder anchors output timestamps at the first
// chunk and accumulates decoded frames, ignoring later chunk timestamps.
// After a stream pause (audio-only teardown while mirroring) the outputs lag
// the wall clock and the graph would drop everything as late, so the packet
// presentation times are matched to outputs through a FIFO instead.
const aacPresentationTimesMs = [];
let aacDroppedCount = 0;

function closeAacDecoder() {
  if (aacDecoder && aacDecoder.state !== 'closed') aacDecoder.close();
  aacDecoder = null;
  aacPresentationTimesMs.length = 0;
}

async function ensureAacDecoder({ config, sampleRate, channels }) {
  if (aacUnsupported) return null;
  if (aacDecoder && aacDecoder.state === 'configured') return aacDecoder;
  if (typeof AudioDecoder !== 'function') {
    aacUnsupported = true;
    setStatus('此环境不支持 WebCodecs AudioDecoder，AAC-ELD 音频已禁用');
    return null;
  }
  const description = hexToBytes(config);
  for (const codec of AAC_CODEC_CANDIDATES) {
    if (failedAacCodecs.has(codec)) continue;
    const decoderConfig = { codec, sampleRate, numberOfChannels: channels, description };
    const support = await AudioDecoder.isConfigSupported(decoderConfig).catch(() => null);
    if (!support?.supported) {
      failedAacCodecs.add(codec);
      continue;
    }
    aacDecoder = new AudioDecoder({
      output: (audioData) => {
        const planes = [];
        for (let channel = 0; channel < audioData.numberOfChannels; channel++) {
          const plane = new Float32Array(audioData.numberOfFrames);
          audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
          planes.push(plane);
        }
        const result = audioGraph.playPlanar({
          planes,
          sampleRate: audioData.sampleRate,
          presentationTimeMs: aacPresentationTimesMs.shift() ?? null,
        });
        if (result.dropped) {
          aacDroppedCount++;
          if (aacDroppedCount === 1 || aacDroppedCount % 250 === 0) {
            console.warn(`AAC audio dropped (${result.dropped}), total ${aacDroppedCount}`);
          }
        }
        audioData.close();
      },
      error: (error) => {
        // This codec string cannot decode the ELD bitstream; blacklist it and
        // let the next packet retry with the following candidate.
        console.warn(`AAC codec ${codec} failed: ${error.message}`);
        failedAacCodecs.add(codec);
        closeAacDecoder();
      },
    });
    aacDecoder.configure(decoderConfig);
    console.warn(`AAC-ELD decoder configured as ${codec}`);
    return aacDecoder;
  }
  aacUnsupported = true;
  setStatus('此环境不支持 AAC-ELD 音频解码');
  return null;
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
      aacPresentationTimesMs.push(packet.presentationTimeMs ?? null);
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
  // A fresh session deserves a fresh codec probe; earlier failures may have
  // been transient (e.g. mid-stream junk), not real capability limits.
  failedAacCodecs.clear();
  aacUnsupported = false;
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
