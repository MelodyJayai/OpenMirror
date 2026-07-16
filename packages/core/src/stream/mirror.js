import net from 'node:net';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

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
    this.#timingSocket = dgram.createSocket('udp4');
    this.#timingSocket.on('message', (message, remote) => this.emit('timing-packet', { message, remote }));
    this.#timingSocket.on('error', (error) => this.emit('error', error));

    try {
      const [videoPort, eventPort, timingPort] = await Promise.all([
        listenTcp(this.#videoServer, host),
        listenTcp(this.#eventServer, host),
        bindUdp(this.#timingSocket, host),
      ]);
      return { videoPort, eventPort, timingPort };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const closers = [closeTcp(this.#videoServer), closeTcp(this.#eventServer), closeUdp(this.#timingSocket)];
    this.#videoServer = null;
    this.#eventServer = null;
    this.#timingSocket = null;
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
  try {
    return new Promise((resolve) => socket.close(resolve));
  } catch {
    return Promise.resolve();
  }
}
