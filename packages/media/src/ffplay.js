import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024;

/** Arguments for a low-latency raw Annex-B H.264 input over stdin. */
export function buildFfplayArgs({ title = 'OpenMirror', fullscreen = false, extraArgs = [] } = {}) {
  if (!Array.isArray(extraArgs) || extraArgs.some((arg) => typeof arg !== 'string')) {
    throw new Error('ffplay extraArgs must be an array of strings');
  }
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-framedrop',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-f', 'h264',
    '-window_title', String(title),
    ...(fullscreen ? ['-fs'] : []),
    ...extraArgs,
    '-i', 'pipe:0',
    '-an',
  ];
}

/**
 * Lazy ffplay process that consumes decoder-ready Annex-B H.264 chunks.
 * It bounds application-side buffering and drops stale frames when the player
 * cannot keep up, favouring live latency over eventually rendering old data.
 */
export class FfplayVideoSink extends EventEmitter {
  #options;
  #child = null;
  #blocked = false;
  #queue = [];
  #queueBytes = 0;

  constructor(options = {}) {
    super();
    const maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    if (!Number.isSafeInteger(maxQueueBytes) || maxQueueBytes < 1) {
      throw new Error('maxQueueBytes must be a positive safe integer');
    }
    this.#options = {
      executable: options.executable ?? 'ffplay',
      title: options.title ?? 'OpenMirror',
      fullscreen: options.fullscreen ?? false,
      extraArgs: options.extraArgs ?? [],
      maxQueueBytes,
      spawnProcess: options.spawnProcess ?? spawn,
    };
  }

  get running() {
    return Boolean(this.#child);
  }

  writeCodec({ annexB }) {
    return this.#write(annexB, { priority: true, kind: 'codec' });
  }

  writeVideo({ annexB, keyframe = false }) {
    return this.#write(annexB, { priority: keyframe, kind: keyframe ? 'keyframe' : 'video' });
  }

  start() {
    if (this.#child) return this.#child;
    const args = buildFfplayArgs(this.#options);
    let child;
    try {
      child = this.#options.spawnProcess(this.#options.executable, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: false,
      });
    } catch (error) {
      this.emit('process-error', error);
      return null;
    }

    this.#child = child;
    this.#blocked = false;
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
    child.stdin?.on('drain', () => this.#flush());
    child.stdin?.on('error', (error) => this.emit('process-error', error));
    child.stderr?.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();
      if (message) this.emit('diagnostic', message.slice(0, 4096));
    });
    return child;
  }

  async stop({ forceAfterMs = 1000 } = {}) {
    const child = this.#child;
    if (!child) return;
    if (!Number.isFinite(forceAfterMs) || forceAfterMs < 0) {
      throw new Error('forceAfterMs must be a non-negative number');
    }
    this.#dropQueue('stop');

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
        try {
          child.kill();
        } catch {
          // It may have exited between the timeout and kill.
        }
        finish();
      }, forceAfterMs);
      timer.unref?.();
      try {
        child.stdin?.end();
      } catch {
        finish();
      }
    });
    this.#release(child);
  }

  #write(chunk, metadata) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return false;
    const child = this.start();
    if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false;
    if (this.#blocked) return this.#enqueue(chunk, metadata);
    try {
      this.#blocked = !child.stdin.write(chunk);
      return true;
    } catch (error) {
      this.emit('process-error', error);
      return false;
    }
  }

  #enqueue(chunk, metadata) {
    const data = Buffer.from(chunk);
    if (this.#queueBytes + data.length > this.#options.maxQueueBytes) {
      if (!metadata.priority) {
        this.emit('dropped', { bytes: data.length, chunks: 1, reason: 'backpressure' });
        return false;
      }
      this.#dropQueue('resync');
    }
    this.#queue.push({ data, metadata });
    this.#queueBytes += data.length;
    return true;
  }

  #flush() {
    const child = this.#child;
    if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
    this.#blocked = false;
    while (!this.#blocked && this.#queue.length) {
      const { data } = this.#queue.shift();
      this.#queueBytes -= data.length;
      try {
        this.#blocked = !child.stdin.write(data);
      } catch (error) {
        this.emit('process-error', error);
        this.#dropQueue('process-error');
        return;
      }
    }
  }

  #dropQueue(reason) {
    if (!this.#queue.length) return;
    const chunks = this.#queue.length;
    const bytes = this.#queueBytes;
    this.#queue = [];
    this.#queueBytes = 0;
    this.emit('dropped', { bytes, chunks, reason });
  }

  #release(child) {
    if (this.#child !== child) return;
    this.#child = null;
    this.#blocked = false;
    this.#dropQueue('process-exit');
  }
}

/** Check whether an ffplay-compatible executable can be launched. */
export function probeFfplay({ executable = 'ffplay', spawnProcess = spawn, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };
    try {
      child = spawnProcess(executable, ['-version'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
  });
}
