import { EventEmitter } from 'node:events';

/**
 * Tracks whether the sender is actively delivering video and any media.
 * Heartbeats are tracked separately from actual media payloads. This matters
 * when an iOS sender keeps the mirror TCP channel alive while the screen is
 * locked: the video decoder should still be recycled after content goes idle.
 */
export class MediaActivityMonitor extends EventEmitter {
  #clock;
  #videoIdleMs;
  #mediaIdleMs;
  #timer = null;
  #closed = false;
  #lastVideoAt = null;
  #lastMediaAt = null;
  #lastHeartbeatAt = null;
  #videoState = 'waiting';
  #mediaState = 'starting';

  constructor({
    clock = Date.now,
    videoIdleMs = 5000,
    mediaIdleMs = 7000,
    autoCheck = true,
  } = {}) {
    super();
    if (typeof clock !== 'function') throw new Error('activity clock must be a function');
    if (!Number.isFinite(videoIdleMs) || videoIdleMs < 100) {
      throw new Error('videoIdleMs must be at least 100');
    }
    if (!Number.isFinite(mediaIdleMs) || mediaIdleMs < videoIdleMs) {
      throw new Error('mediaIdleMs must be at least videoIdleMs');
    }
    this.#clock = clock;
    this.#videoIdleMs = videoIdleMs;
    this.#mediaIdleMs = mediaIdleMs;
    if (autoCheck) {
      const intervalMs = Math.max(100, Math.min(1000, Math.floor(videoIdleMs / 2)));
      this.#timer = setInterval(() => this.check(), intervalMs);
      this.#timer.unref?.();
    }
  }

  get snapshot() {
    return {
      videoState: this.#videoState,
      mediaState: this.#mediaState,
      lastVideoAt: this.#lastVideoAt,
      lastMediaAt: this.#lastMediaAt,
      lastHeartbeatAt: this.#lastHeartbeatAt,
    };
  }

  signal(kind, atMs = this.#clock()) {
    if (this.#closed) return;
    if (!Number.isFinite(atMs)) throw new Error('activity timestamp must be finite');
    if (!['video', 'heartbeat', 'audio'].includes(kind)) {
      throw new Error(`unsupported media activity kind ${kind}`);
    }

    if (kind === 'heartbeat') {
      this.#lastHeartbeatAt = atMs;
      return;
    }
    if (kind === 'video') {
      this.#lastVideoAt = atMs;
      this.#transition('video', 'streaming', this.#videoState === 'idle' ? 'resumed' : 'activity', atMs);
    }
    if (kind === 'video' || kind === 'audio') {
      this.#lastMediaAt = atMs;
      this.#transition('media', 'streaming', this.#mediaState === 'idle' ? 'resumed' : 'activity', atMs);
    }
  }

  reset(reason = 'flush', atMs = this.#clock()) {
    if (this.#closed) return;
    this.#lastVideoAt = null;
    this.#lastMediaAt = null;
    this.#lastHeartbeatAt = null;
    this.#transition('video', 'waiting', reason, atMs);
    this.#transition('media', 'starting', reason, atMs);
  }

  idle(component, reason = 'connection-closed', atMs = this.#clock()) {
    if (this.#closed) return;
    if (component !== 'video' && component !== 'media') {
      throw new Error(`unsupported media component ${component}`);
    }
    const lastAt = component === 'video' ? this.#lastVideoAt : this.#lastMediaAt;
    this.#transition(component, 'idle', reason, atMs, lastAt === null ? null : atMs - lastAt);
  }

  check(atMs = this.#clock()) {
    if (this.#closed) return;
    if (this.#lastVideoAt !== null && atMs - this.#lastVideoAt >= this.#videoIdleMs) {
      this.#transition('video', 'idle', 'timeout', atMs, atMs - this.#lastVideoAt);
    }
    if (this.#lastMediaAt !== null && atMs - this.#lastMediaAt >= this.#mediaIdleMs) {
      this.#transition('media', 'idle', 'timeout', atMs, atMs - this.#lastMediaAt);
    }
  }

  close(reason = 'session-closed', atMs = this.#clock()) {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#transition('video', 'closed', reason, atMs);
    this.#transition('media', 'closed', reason, atMs);
  }

  #transition(component, state, reason, atMs, idleForMs = null) {
    const key = component === 'video' ? '#videoState' : '#mediaState';
    const previous = component === 'video' ? this.#videoState : this.#mediaState;
    if (previous === state) return;
    if (key === '#videoState') this.#videoState = state;
    else this.#mediaState = state;
    this.emit('state', {
      component,
      state,
      previous,
      reason,
      atMs,
      idleForMs,
    });
  }
}
