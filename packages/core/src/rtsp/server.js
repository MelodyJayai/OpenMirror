// AirPlay RTSP control server: accepts TCP connections on the advertised
// port, parses RTSP/HTTP messages, and dispatches them to method handlers.
// Each connection carries per-session state (pairing, ciphers) in ctx.session.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { RtspParser, encodeResponse } from './parser.js';

export class RtspServer extends EventEmitter {
  #server = null;
  #handlers = new Map();
  #sessions = new Set();
  #nextSessionId = 1;

  /**
   * Register a handler. handle(method, handler) matches any URI for that
   * method; handle(method, path, handler) matches an exact path. Handlers
   * receive (request, ctx) and return { status?, headers?, body? } (or a
   * Promise of it).
   */
  handle(method, path, handler) {
    if (handler === undefined) {
      this.#handlers.set(method.toUpperCase(), path);
    } else {
      this.#handlers.set(`${method.toUpperCase()} ${path}`, handler);
    }
    return this;
  }

  listen(port, host) {
    this.#server = net.createServer((socket) => this.#onConnection(socket));
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        this.#server.removeListener('error', reject);
        resolve(this.#server.address().port);
      });
    });
  }

  async close() {
    for (const socket of this.#sessions) socket.destroy();
    this.#sessions.clear();
    if (!this.#server) return;
    await new Promise((resolve) => this.#server.close(resolve));
    this.#server = null;
  }

  #onConnection(socket) {
    this.#sessions.add(socket);
    const session = {
      id: this.#nextSessionId++,
      remoteAddress: socket.remoteAddress,
      localAddress: socket.localAddress,
      openedAt: Date.now(),
      state: {},
    };
    const ctx = {
      session,
      socket,
      server: this,
      queue: Promise.resolve(),
    };

    const parser = new RtspParser((message) => {
      if (message.kind !== 'request') return; // We never expect responses inbound.
      // RTSP requires in-order responses: serialize dispatch per connection.
      ctx.queue = ctx.queue
        .then(() => this.#dispatch(message, ctx))
        .catch((err) => this.emit('error', err));
    });

    socket.on('data', (chunk) => {
      try {
        parser.push(chunk);
      } catch (err) {
        this.emit('error', err);
        socket.destroy();
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.#sessions.delete(socket);
      this.emit('session-closed', session);
    });
    this.emit('session-opened', session);
  }

  async #dispatch(request, ctx) {
    const path = request.uri.startsWith('rtsp://') || request.uri.startsWith('http://')
      ? new URL(request.uri).pathname
      : request.uri.split('?')[0];
    const key = `${request.method.toUpperCase()} ${path}`;
    const handler = this.#handlers.get(key) ?? this.#handlers.get(request.method.toUpperCase());

    this.emit('request', {
      method: request.method,
      uri: request.uri,
      bodyBytes: request.body?.length ?? 0,
      contentType: request.headers['content-type'] ?? null,
      cseq: request.headers['cseq'] ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      session: ctx.session,
    });

    let response;
    if (!handler) {
      response = { status: 404 };
    } else {
      try {
        response = (await handler(request, ctx)) ?? { status: 200 };
      } catch (err) {
        this.emit('error', err);
        response = { status: 500 };
      }
    }

    const headers = { ...(response.headers ?? {}) };
    if (request.headers['cseq'] !== undefined) headers['CSeq'] = request.headers['cseq'];

    const protocol = request.version?.startsWith('HTTP/') ? 'HTTP/1.1' : 'RTSP/1.0';
    ctx.socket.write(encodeResponse({ ...response, headers }, protocol));
  }
}
