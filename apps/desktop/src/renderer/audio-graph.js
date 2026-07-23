// WebAudio playback graph shared by the desktop renderer: decoded PCM (or
// WebCodecs AudioDecoder output) is scheduled on the AudioContext clock at the
// receiver's shared presentation time, with sender volume applied via a gain
// node. Dependency-injected so the scheduling logic is testable under Node.

export const AIRPLAY_MUTE_DB = -144;

export function dbToGain(volumeDb, muted = false) {
  if (muted) return 0;
  if (!Number.isFinite(volumeDb)) return 1;
  if (volumeDb <= AIRPLAY_MUTE_DB) return 0;
  return Math.min(1, 10 ** (volumeDb / 20));
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2) {
    throw new Error('invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Interleaved signed 16-bit samples → one Float32Array per channel. */
export function planarize(samples, channels) {
  if (!Number.isInteger(channels) || channels < 1) throw new Error('invalid channel count');
  if (samples.length % channels) throw new Error('sample count is not channel-aligned');
  const frames = samples.length / channels;
  const planes = [];
  for (let channel = 0; channel < channels; channel++) {
    const plane = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      plane[frame] = samples[frame * channels + channel] / 32768;
    }
    planes.push(plane);
  }
  return planes;
}

export class AudioGraph {
  #createContext;
  #clock;
  #lateToleranceMs;
  #maxScheduleDelayMs;
  #context = null;
  #gainNode = null;
  #sampleRate = null;
  #nextTime = 0;
  #gain = 1;

  constructor({
    createContext,
    clock = Date.now,
    lateToleranceMs = 250,
    maxScheduleDelayMs = 5000,
  } = {}) {
    this.#createContext = createContext
      ?? ((sampleRate) => new AudioContext({ sampleRate, latencyHint: 'interactive' }));
    this.#clock = clock;
    this.#lateToleranceMs = lateToleranceMs;
    this.#maxScheduleDelayMs = maxScheduleDelayMs;
  }

  get sampleRate() {
    return this.#sampleRate;
  }

  /** Interleaved Int16Array (little-endian host order) → scheduled playback. */
  playPcm({ pcm, sampleRate, channels, presentationTimeMs = null }) {
    return this.playPlanar({
      planes: planarize(pcm, channels),
      sampleRate,
      presentationTimeMs,
    });
  }

  /** One Float32Array per channel (e.g. AudioDecoder f32-planar output). */
  playPlanar({ planes, sampleRate, presentationTimeMs = null }) {
    if (!Array.isArray(planes) || planes.length < 1 || planes[0].length < 1) {
      return { dropped: 'empty' };
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 1) return { dropped: 'invalid-rate' };
    const context = this.#ensureContext(sampleRate);
    const frames = planes[0].length;
    const now = context.currentTime;
    let when = Math.max(this.#nextTime, now);
    if (presentationTimeMs != null) {
      const delayMs = presentationTimeMs - this.#clock();
      if (delayMs < -this.#lateToleranceMs) return { dropped: 'late' };
      if (delayMs > this.#maxScheduleDelayMs) return { dropped: 'timing-outlier' };
      when = Math.max(now + Math.max(delayMs, 0) / 1000, this.#nextTime);
    }
    const buffer = context.createBuffer(planes.length, frames, sampleRate);
    for (let channel = 0; channel < planes.length; channel++) {
      buffer.getChannelData(channel).set(planes[channel]);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#gainNode);
    source.start(when);
    this.#nextTime = when + frames / sampleRate;
    return { when, frames };
  }

  setVolume({ volumeDb, muted = false } = {}) {
    this.#gain = dbToGain(volumeDb, muted);
    if (this.#gainNode) this.#gainNode.gain.value = this.#gain;
    return this.#gain;
  }

  reset() {
    this.#nextTime = 0;
  }

  close() {
    const context = this.#context;
    this.#context = null;
    this.#gainNode = null;
    this.#sampleRate = null;
    this.#nextTime = 0;
    context?.close?.();
  }

  #ensureContext(sampleRate) {
    if (this.#context && this.#sampleRate === sampleRate) return this.#context;
    this.close();
    const context = this.#createContext(sampleRate);
    const gainNode = context.createGain();
    gainNode.gain.value = this.#gain;
    gainNode.connect(context.destination);
    this.#context = context;
    this.#gainNode = gainNode;
    this.#sampleRate = sampleRate;
    return context;
  }
}
