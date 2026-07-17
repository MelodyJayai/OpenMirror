import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const AAC_ELD_CONFIG = 'f8e85000';
export const AAC_ELD_SAMPLE_RATE = 44100;
export const AAC_ELD_CHANNELS = 2;
export const AAC_ELD_SAMPLES_PER_FRAME = 480;
export const AAC_ELD_NO_DATA_MARKER = Buffer.from([0x00, 0x68, 0x34, 0x00]);

const DEFAULT_MAX_QUEUE_PACKETS = 256;

/** RFC 3640 SDP for one MPEG4-GENERIC AAC-ELD access unit per RTP packet. */
export function buildAacEldSdp({
  port,
  host = '127.0.0.1',
  payloadType = 96,
  sampleRate = AAC_ELD_SAMPLE_RATE,
  channels = AAC_ELD_CHANNELS,
  samplesPerFrame = AAC_ELD_SAMPLES_PER_FRAME,
  config = AAC_ELD_CONFIG,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid RTP port');
  if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127) {
    throw new Error('invalid RTP payload type');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new Error('invalid sample rate');
  if (!Number.isInteger(channels) || channels < 1) throw new Error('invalid channel count');
  if (!Number.isInteger(samplesPerFrame) || samplesPerFrame < 1) {
    throw new Error('invalid samples per frame');
  }
  if (!/^[0-9a-f]+$/i.test(config) || config.length % 2) throw new Error('invalid AAC config');
  return [
    'v=0',
    `o=- 0 0 IN IP4 ${host}`,
    's=OpenMirror AAC-ELD',
    `c=IN IP4 ${host}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} MPEG4-GENERIC/${sampleRate}/${channels}`,
    `a=fmtp:${payloadType} streamtype=5; mode=AAC-hbr; config=${config}; SizeLength=13; IndexLength=3; IndexDeltaLength=3; constantDuration=${samplesPerFrame}`,
    'a=recvonly',
    '',
  ].join('\r\n');
}

/** Wrap a raw AAC-ELD access unit in RTP + one 16-bit RFC 3640 AU header. */
export function wrapAacEldRtp(payload, {
  sequence = 0,
  timestamp = 0,
  ssrc = 0x4f4d4952,
  payloadType = 96,
  marker = true,
} = {}) {
  if (!Buffer.isBuffer(payload) || payload.length < 1 || payload.length > 0x1fff) {
    throw new Error('AAC access unit must be a 1..8191 byte Buffer');
  }
  const packet = Buffer.allocUnsafe(16 + payload.length);
  packet[0] = 0x80;
  packet[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f);
  packet.writeUInt16BE(sequence & 0xffff, 2);
  packet.writeUInt32BE(timestamp >>> 0, 4);
  packet.writeUInt32BE(ssrc >>> 0, 8);
  packet.writeUInt16BE(16, 12); // AU-headers-length in bits
  packet.writeUInt16BE(payload.length << 3, 14); // 13-bit AU-size + 3-bit AU-index
  payload.copy(packet, 16);
  return packet;
}

export function buildFfplayAudioArgs({ extraArgs = [] } = {}) {
  if (!Array.isArray(extraArgs) || extraArgs.some((arg) => typeof arg !== 'string')) {
    throw new Error('ffplay extraArgs must be an array of strings');
  }
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-protocol_whitelist', 'file,crypto,data,udp,rtp,pipe',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-probesize', '32',
    '-analyzeduration', '0',
    ...extraArgs,
    '-f', 'sdp',
    '-i', 'pipe:0',
    '-vn',
    '-nodisp',
  ];
}

/**
 * Audio-only ffplay sink. Decrypted AAC-ELD access units are paced on the
 * receiver's shared media clock, repacketized as RFC 3640 RTP, and sent over
 * loopback to ffplay's native AAC decoder/audio device.
 */
export class FfplayAudioSink extends EventEmitter {
  #options;
  #child = null;
  #socket = null;
  #port = null;
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
    this.#options = {
      executable: options.executable ?? 'ffplay',
      host: options.host ?? '127.0.0.1',
      port: options.port,
      extraArgs: options.extraArgs ?? [],
      maxQueuePackets,
      startupDelayMs,
      lateToleranceMs,
      maxScheduleDelayMs,
      sampleRate: options.sampleRate ?? AAC_ELD_SAMPLE_RATE,
      channels: options.channels ?? AAC_ELD_CHANNELS,
      samplesPerFrame: options.samplesPerFrame ?? AAC_ELD_SAMPLES_PER_FRAME,
      config: options.config ?? AAC_ELD_CONFIG,
      spawnProcess: options.spawnProcess ?? spawn,
      createSocket: options.createSocket ?? (() => dgram.createSocket('udp4')),
      allocatePort: options.allocatePort ?? allocateUdpPort,
      clock: options.clock ?? Date.now,
    };
    if (typeof this.#options.clock !== 'function') throw new Error('clock must be a function');
  }

  get running() {
    return Boolean(this.#child);
  }

  get port() {
    return this.#port;
  }

  start() {
    if (this.#child) return Promise.resolve(this.#child);
    if (this.#startPromise) return this.#startPromise;
    this.#stopping = false;
    this.#startPromise = this.#start().finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  writeAudio(packet) {
    const reason = invalidAudioReason(packet);
    if (reason) {
      this.emit('dropped', { packets: 1, bytes: packet?.payload?.length ?? 0, reason });
      return false;
    }
    const item = {
      payload: Buffer.from(packet.payload),
      sequence: packet.sequence,
      timestamp: packet.timestamp,
      presentationTimeMs: packet.timing?.presentationTimeMs,
    };
    if (this.#queue.length >= this.#options.maxQueuePackets) {
      const dropped = this.#queue.shift();
      this.emit('dropped', { packets: 1, bytes: dropped.payload.length, reason: 'queue-limit' });
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
    closeUdp(this.#socket);
    this.#socket = null;
    const child = this.#child;
    if (!child) return;
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

  async #start() {
    let port;
    try {
      port = this.#options.port ?? await this.#options.allocatePort(this.#options.host);
      if (this.#stopping) return null;
      const socket = this.#options.createSocket();
      const args = buildFfplayAudioArgs(this.#options);
      const child = this.#options.spawnProcess(this.#options.executable, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      });
      this.#port = port;
      this.#socket = socket;
      this.#child = child;
      this.#readyAtMs = this.#options.clock() + this.#options.startupDelayMs;
      child.once('spawn', () => this.emit('started', {
        executable: this.#options.executable,
        args,
        pid: child.pid,
        port,
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
      child.stdin?.end(buildAacEldSdp({
        port,
        host: this.#options.host,
        sampleRate: this.#options.sampleRate,
        channels: this.#options.channels,
        samplesPerFrame: this.#options.samplesPerFrame,
        config: this.#options.config,
      }));
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
    if (!this.#child || !this.#socket || !this.#queue.length) return;
    const now = this.#options.clock();
    const item = this.#queue[0];
    const requested = Number.isFinite(item.presentationTimeMs) ? item.presentationTimeMs : now;
    const target = Math.max(requested, this.#readyAtMs);
    const delay = target - now;
    if (delay > this.#options.maxScheduleDelayMs) {
      this.#queue.shift();
      this.emit('dropped', { packets: 1, bytes: item.payload.length, reason: 'timing-outlier' });
      this.#schedule();
      return;
    }
    if (delay > 1) {
      // Keep the event loop alive while packets are queued: an unref()ed
      // pacing timer lets Node exit before pending audio is forwarded.
      this.#timer = setTimeout(() => this.#schedule(), delay);
      return;
    }
    this.#queue.shift();
    if (now - requested > this.#options.lateToleranceMs && now >= this.#readyAtMs) {
      this.emit('dropped', { packets: 1, bytes: item.payload.length, reason: 'late' });
    } else {
      const message = wrapAacEldRtp(item.payload, item);
      this.#socket.send(message, this.#port, this.#options.host, (error) => {
        if (error) this.emit('process-error', error);
      });
      this.emit('packet', {
        bytes: item.payload.length,
        sequence: item.sequence,
        timestamp: item.timestamp,
        scheduledForMs: requested,
        sentAtMs: now,
      });
    }
    this.#schedule();
  }

  #dropQueue(reason) {
    if (!this.#queue.length) return;
    const packets = this.#queue.length;
    const bytes = this.#queue.reduce((total, item) => total + item.payload.length, 0);
    this.#queue = [];
    this.emit('dropped', { packets, bytes, reason });
  }

  #release(child) {
    if (this.#child !== child) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    closeUdp(this.#socket);
    this.#socket = null;
    this.#child = null;
    this.#port = null;
    this.#dropQueue('process-exit');
  }
}

function invalidAudioReason(packet) {
  if (!packet || packet.encrypted) return 'encrypted';
  if (packet.compressionType !== undefined && packet.compressionType !== 8) return 'unsupported-codec';
  if (!Buffer.isBuffer(packet.payload) || packet.payload.length === 0) return 'empty';
  if (packet.payload.equals(AAC_ELD_NO_DATA_MARKER)) return 'no-data';
  // Raw AAC-ELD access units have no fixed sync word or magic first byte.
  // RFC 3640's 13-bit AU-size field is the only bound we can validate here.
  if (packet.payload.length > 0x1fff) return 'oversized';
  return null;
}

function presentationOf(item) {
  return Number.isFinite(item.presentationTimeMs) ? item.presentationTimeMs : -Infinity;
}

export function allocateUdpPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, host, () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

function closeUdp(socket) {
  if (!socket) return;
  try { socket.close(); } catch { /* already closed */ }
}
