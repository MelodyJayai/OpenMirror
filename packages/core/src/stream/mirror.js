import net from 'node:net';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { buildTimingReply } from './timing.js';
import { parseRtpPacket } from './rtp.js';
import { RtspParser, encodeResponse } from '../rtsp/parser.js';

export const MIRROR_HEADER_BYTES = 128;
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

// Incremental parser for the AirPlay mirroring TCP framing. The encrypted or
// clear payload is deliberately left untouched; FairPlay belongs above this
// transport boundary.
export class MirrorFrameParser {
  #buffer = Buffer.alloc(0);
  #onFrame;
  #maxFrameBytes;

  constructor(onFrame, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    this.#onFrame = onFrame;
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk) {
    if (!chunk?.length) return;
    this.#buffer = this.#buffer.length
      ? Buffer.concat([this.#buffer, chunk])
      : Buffer.from(chunk);

    while (this.#buffer.length >= MIRROR_HEADER_BYTES) {
      const payloadLength = this.#buffer.readUInt32LE(0);
      if (payloadLength > this.#maxFrameBytes) {
        throw new Error(`AirPlay mirror frame too large: ${payloadLength} bytes`);
      }
      const total = MIRROR_HEADER_BYTES + payloadLength;
      if (this.#buffer.length < total) return;

      const header = Buffer.from(this.#buffer.subarray(0, MIRROR_HEADER_BYTES));
      const payload = Buffer.from(this.#buffer.subarray(MIRROR_HEADER_BYTES, total));
      this.#buffer = this.#buffer.subarray(total);
      this.#onFrame({
        payloadLength,
        type: header.readUInt16LE(4),
        timestamp: header.readBigUInt64LE(8),
        header,
        payload,
      });
    }
  }
}

export class MirrorTransport extends EventEmitter {
  #videoServer = null;
  #eventServer = null;
  #timingSocket = null;
  #audioSocket = null;
  #audioControlSocket = null;
  #sockets = new Set();
  #maxFrameBytes;

  constructor({ maxFrameBytes } = {}) {
    super();
    this.#maxFrameBytes = maxFrameBytes;
  }

  async start(host) {
    if (this.#videoServer) throw new Error('Mirror transport already started');
    this.#videoServer = net.createServer((socket) => this.#acceptVideo(socket));
    this.#eventServer = net.createServer((socket) => this.#acceptEvent(socket));

    // Timing requests are answered at the transport boundary to keep the
    // sender's clock synchronization independent of the application layer.
    this.#timingSocket = dgram.createSocket('udp4');
    this.#timingSocket.on('message', (message, remote) => {
      const reply = buildTimingReply(message);
      if (reply) this.#timingSocket.send(reply, remote.port, remote.address);
      this.emit('timing-packet', { message, remote, replied: Boolean(reply) });
    });
    this.#timingSocket.on('error', (error) => this.emit('error', error));

    this.#audioSocket = dgram.createSocket('udp4');
    this.#audioSocket.on('message', (message, remote) => {
      try {
        this.emit('audio-packet', { ...parseRtpPacket(message), raw: message, remote });
      } catch (error) {
        this.emit('invalid-audio-packet', { error, message, remote });
      }
    });
    this.#audioSocket.on('error', (error) => this.emit('error', error));

    this.#audioControlSocket = dgram.createSocket('udp4');
    this.#audioControlSocket.on('message', (message, remote) => {
      this.emit('audio-control-packet', { message, remote });
    });
    this.#audioControlSocket.on('error', (error) => this.emit('error', error));

    try {
      const [videoPort, eventPort, timingPort, audioPort, audioControlPort] = await Promise.all([
        listenTcp(this.#videoServer, host),
        listenTcp(this.#eventServer, host),
        bindUdp(this.#timingSocket, host),
        bindUdp(this.#audioSocket, host),
        bindUdp(this.#audioControlSocket, host),
      ]);
      return { videoPort, eventPort, timingPort, audioPort, audioControlPort };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const closers = [
      closeTcp(this.#videoServer),
      closeTcp(this.#eventServer),
      closeUdp(this.#timingSocket),
      closeUdp(this.#audioSocket),
      closeUdp(this.#audioControlSocket),
    ];
    this.#videoServer = null;
    this.#eventServer = null;
    this.#timingSocket = null;
    this.#audioSocket = null;
    this.#audioControlSocket = null;
    await Promise.all(closers);
  }

  #track(socket) {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', (error) => this.emit('socket-error', error));
  }

  #acceptVideo(socket) {
    this.#track(socket);
    const parser = new MirrorFrameParser(
      (frame) => this.emit('video-frame', { ...frame, socket }),
      { maxFrameBytes: this.#maxFrameBytes },
    );
    socket.on('data', (chunk) => {
      try {
        parser.push(chunk);
      } catch (error) {
        this.emit('error', error);
        socket.destroy();
      }
    });
    this.emit('video-connection', socket);
  }

  #acceptEvent(socket) {
    this.#track(socket);
    const parser = new RtspParser((message) => {
      if (message.kind === 'request') {
        this.emit('event-request', { ...message, socket });
        const headers = message.headers['cseq'] === undefined
          ? {}
          : { CSeq: message.headers['cseq'] };
        socket.write(encodeResponse({ status: 200, headers }, 'HTTP/1.1'));
      } else {
        this.emit('event-response', { ...message, socket });
      }
    });
    socket.on('data', (chunk) => {
      try {
        parser.push(chunk);
      } catch (error) {
        this.emit('event-error', { error, socket });
        if (!socket.destroyed) {
          socket.end(encodeResponse({ status: 400 }, 'HTTP/1.1'));
        }
      }
    });
    this.emit('event-connection', socket);
  }
}

function listenTcp(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function bindUdp(socket, host) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, host, () => {
      socket.removeListener('error', reject);
      resolve(socket.address().port);
    });
  });
}

function closeTcp(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function closeUdp(socket) {
  if (!socket) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      socket.close(resolve);
    } catch {
      // A socket whose bind failed is not yet running and cannot be closed.
      resolve();
    }
  });
}
