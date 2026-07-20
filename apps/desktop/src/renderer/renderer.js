// WebCodecs H.264 rendering: the main process forwards decrypted Annex-B
// access units; keyframes are prefixed with the latest parameter sets so the
// decoder can (re)start mid-stream.

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

window.openmirror.onReset(() => {
  closeDecoder();
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
