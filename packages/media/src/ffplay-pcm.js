import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const DEFAULT_MAX_QUEUE_PACKETS = 256;

const CHANNEL_LAYOUTS = new Map([[1, 'mono'], [2, 'stereo']]);

export function pcmChannelLayout(channels) {
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
    throw new Error('PCM channels must be an integer between 1 and 8');
  }
  return CHANNEL_LAYOUTS.get(channels) ?? `${channels}c`;
}

export function buildFfplayPcmArgs({
  sampleRate = 44100,
  channels = 2,
  extraArgs = [],
} = {}) {
  if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new Error('invalid sample rate');
  if (!Array.isArray(extraArgs) || extraArgs.some((arg) => typeof arg !== 'string')) {
    throw new Error('ffplay extraArgs must be an array of strings');
  }
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-probesize', '32',
    '-analyzeduration', '0',
    ...extraArgs,
    '-f', 's16le',
    '-sample_rate', String(sampleRate),
    '-ch_layout', pcmChannelLayout(channels),
    '-i', 'pipe:0',
    '-vn',
    '-nodisp',
  ];
}

/**
 * PCM ffplay sink. Interleaved signed 16-bit little-endian samples (decoded
 * ALAC frames or byte-swapped RAOP L16) are paced on the receiver's shared
 * media clock and streamed to ffplay's stdin as a raw s16le stream.
 */
export class FfplayPcmSink extends EventEmitter {
  #options;
  #child = null;
  #startPromise = null;
  #queue = [];
  #timer = null;
  #readyAtMs = 0;
  #stopping = false;

  constructor(options = {}) {
    super();
    const maxQueuePackets = options.maxQueuePackets ?? DEFAULT_MAX_QUEUE_PACKETS;
    if (!Number.isSafeInteger(maxQueuePackets) || maxQueuePackets < 1) {
      throw new Error('maxQueuePackets must be a positive safe integer');
    }
    const startupDelayMs = options.startupDelayMs ?? 80;
    const lateToleranceMs = options.lateToleranceMs ?? 250;
    const maxScheduleDelayMs = options.maxScheduleDelayMs ?? 5000;
    if (!Number.isFinite(startupDelayMs) || startupDelayMs < 0) {
      throw new Error('startupDelayMs must be non-negative');
    }
    if (!Number.isFinite(lateToleranceMs) || lateToleranceMs < 0) {
      throw new Error('lateToleranceMs must be non-negative');
    }
    if (!Number.isFinite(maxScheduleDelayMs) || maxScheduleDelayMs < 1) {
      throw new Error('maxScheduleDelayMs must be positive');
    }
    const channels = options.channels ?? 2;
    this.#options = {
      executable: options.executable ?? 'ffplay',
      extraArgs: options.extraArgs ?? [],
      maxQueuePackets,
      startupDelayMs,
      lateToleranceMs,
      maxScheduleDelayMs,
      sampleRate: options.sampleRate ?? 44100,
      channels,
      frameBytes: channels * 2,
      spawnProcess: options.spawnProcess ?? spawn,
      clock: options.clock ?? Date.now,
    };
    if (typeof this.#options.clock !== 'function') throw new Error('clock must be a function');
    pcmChannelLayout(channels);
  }

  get running() {
    return Boolean(this.#child);
  }

  start() {
    if (this.#child) return Promise.resolve(this.#child);
    if (this.#startPromise) return this.#startPromise;
    this.#stopping = false;
    this.#startPromise = Promise.resolve().then(() => this.#start()).finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  writePcm(packet) {
    const reason = this.#invalidPcmReason(packet);
    if (reason) {
      this.emit('dropped', { packets: 1, bytes: packet?.pcm?.length ?? 0, reason });
      return false;
    }
    const item = {
      pcm: Buffer.from(packet.pcm),
      sequence: packet.sequence,
      timestamp: packet.timestamp,
      presentationTimeMs: packet.timing?.presentationTimeMs,
    };
    if (this.#queue.length >= this.#options.maxQueuePackets) {
      const dropped = this.#queue.shift();
      this.emit('dropped', { packets: 1, bytes: dropped.pcm.length, reason: 'queue-limit' });
    }
    this.#queue.push(item);
    this.#queue.sort((a, b) => presentationOf(a) - presentationOf(b));
    this.start().then(() => this.#schedule()).catch(() => {});
    return true;
  }

  async stop({ forceAfterMs = 1000 } = {}) {
    if (!Number.isFinite(forceAfterMs) || forceAfterMs < 0) {
      throw new Error('forceAfterMs must be a non-negative number');
    }
    this.#stopping = true;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#dropQueue('stop');
    if (this.#startPromise) await this.#startPromise.catch(() => {});
    const child = this.#child;
    if (!child) return;
    try { child.stdin?.end(); } catch { /* already closed */ }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', finish);
        child.removeListener('error', finish);
        resolve();
      };
      child.once('exit', finish);
      child.once('error', finish);
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already exited */ }
        finish();
      }, forceAfterMs);
      timer.unref?.();
      try { child.kill(); } catch { finish(); }
    });
    this.#release(child);
  }

  #start() {
    try {
      if (this.#stopping) return null;
      const args = buildFfplayPcmArgs(this.#options);
      const child = this.#options.spawnProcess(this.#options.executable, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      });
      this.#child = child;
      this.#readyAtMs = this.#options.clock() + this.#options.startupDelayMs;
      child.once('spawn', () => this.emit('started', {
        executable: this.#options.executable,
        args,
        pid: child.pid,
      }));
      child.once('error', (error) => {
        this.emit('process-error', error);
        this.#release(child);
      });
      child.once('exit', (code, signal) => {
        this.emit('exit', { code, signal });
        this.#release(child);
      });
      child.stdin?.on('error', (error) => this.emit('process-error', error));
      child.stderr?.on('data', (chunk) => {
        const message = chunk.toString('utf8').trim();
        if (message) this.emit('diagnostic', message.slice(0, 4096));
      });
      return child;
    } catch (error) {
      this.emit('process-error', error);
      this.#dropQueue('process-error');
      return null;
    }
  }

  #schedule() {
    clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#child?.stdin || !this.#queue.length) return;
    const now = this.#options.clock();
    const item = this.#queue[0];
    const requested = Number.isFinite(item.presentationTimeMs) ? item.presentationTimeMs : now;
    const target = Math.max(requested, this.#readyAtMs);
    const delay = target - now;
    if (delay > this.#options.maxScheduleDelayMs) {
      this.#queue.shift();
      this.emit('dropped', { packets: 1, bytes: item.pcm.length, reason: 'timing-outlier' });
      this.#schedule();
      return;
    }
    if (delay > 1) {
      // Keep the event loop alive while samples are queued: an unref()ed
      // pacing timer lets Node exit before pending audio is forwarded.
      this.#timer = setTimeout(() => this.#schedule(), delay);
      return;
    }
    this.#queue.shift();
    if (now - requested > this.#options.lateToleranceMs && now >= this.#readyAtMs) {
      this.emit('dropped', { packets: 1, bytes: item.pcm.length, reason: 'late' });
    } else {
      this.#child.stdin.write(item.pcm, (error) => {
        if (error) this.emit('process-error', error);
      });
      this.emit('packet', {
        bytes: item.pcm.length,
        samples: item.pcm.length / this.#options.frameBytes,
        sequence: item.sequence,
        timestamp: item.timestamp,
        scheduledForMs: requested,
        sentAtMs: now,
      });
    }
    this.#schedule();
  }

  #invalidPcmReason(packet) {
    if (!packet) return 'empty';
    const pcm = packet.pcm;
    if (!Buffer.isBuffer(pcm) && !(pcm instanceof Uint8Array)) return 'empty';
    if (pcm.length === 0) return 'empty';
    if (pcm.length % this.#options.frameBytes) return 'unaligned';
    return null;
  }

  #dropQueue(reason) {
    if (!this.#queue.length) return;
    const packets = this.#queue.length;
    const bytes = this.#queue.reduce((total, item) => total + item.pcm.length, 0);
    this.#queue = [];
    this.emit('dropped', { packets, bytes, reason });
  }

  #release(child) {
    if (this.#child !== child) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#child = null;
    this.#dropQueue('process-exit');
  }
}

function presentationOf(item) {
  return Number.isFinite(item.presentationTimeMs) ? item.presentationTimeMs : -Infinity;
}
