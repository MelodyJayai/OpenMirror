import net from 'node:net';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import {
  buildTimingReply, buildTimingRequest, decodeTimingPacket, ntpNow,
  timingReplySample, TIMING_REPLY,
} from './timing.js';
import {
  AUDIO_PAYLOAD,
  buildAudioRetransmitRequest,
  parseRetransmittedAudioPacket,
  parseRtpPacket,
} from './rtp.js';
import { RtspParser, encodeResponse } from '../rtsp/parser.js';

export const MIRROR_HEADER_BYTES = 128;
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

function dimensionPair(header, widthOffset, heightOffset) {
  const width = header.readFloatLE(widthOffset);
  const height = header.readFloatLE(heightOffset);
  if (
    !Number.isFinite(width) || !Number.isFinite(height)
    || width <= 0 || height <= 0
    || width > 32768 || height > 32768
  ) {
    return null;
  }
  return {
    width: Math.round(width),
    height: Math.round(height),
    orientation: width === height ? 'square' : width > height ? 'landscape' : 'portrait',
  };
}

function mirrorDisplayDimensions(header) {
  const source = dimensionPair(header, 40, 44) ?? dimensionPair(header, 16, 20);
  const encoded = dimensionPair(header, 56, 60);
  return source || encoded ? { source, encoded } : null;
}

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
        // AirPlay uses byte 4 for the payload type and byte 5 for flags.
        // In particular, an IDR video packet is commonly encoded as 00 10.
        type: header[4],
        payloadFlags: header[5],
        payloadOption: header.readUInt16LE(6),
        rawTypeAndFlags: header.readUInt16LE(4),
        timestamp: header.readBigUInt64LE(8),
        displayDimensions: mirrorDisplayDimensions(header),
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
  #audioRemote = null;
  #audioRetransmitSequence = 0;
  #timingRemote = null;
  #timingTimer = null;
  #timingSequence = 0;
  #timingOrigins = new Set();
  #sockets = new Set();
  #videoSockets = new Set();
  #eventSockets = new Set();
  #maxFrameBytes;
  #clock;
  #timingIntervalMs;

  constructor({ maxFrameBytes, clock = ntpNow, timingIntervalMs = 3000 } = {}) {
    super();
    this.#maxFrameBytes = maxFrameBytes;
    if (typeof clock !== 'function') throw new Error('clock must be a function');
    if (!Number.isFinite(timingIntervalMs) || timingIntervalMs < 10) {
      throw new Error('timingIntervalMs must be at least 10');
    }
    this.#clock = clock;
    this.#timingIntervalMs = timingIntervalMs;
  }

  async start(host) {
    if (this.#videoServer) throw new Error('Mirror transport already started');
    this.#videoServer = net.createServer((socket) => this.#acceptVideo(socket));
    this.#eventServer = net.createServer((socket) => this.#acceptEvent(socket));

    // The same local port sends receiver-originated NTP probes and still
    // answers legacy inbound timing requests for compatibility.
    this.#timingSocket = dgram.createSocket('udp4');
    this.#timingSocket.on('message', (message, remote) => {
      const receivedAtNtp = this.#clock();
      let decoded = null;
      let sample = null;
      let reply = null;
      try {
        decoded = decodeTimingPacket(message);
        const expectedReply = decoded.version === 2
          && decoded.type === TIMING_REPLY
          && remote.port === this.#timingRemote?.port
          && remote.address === this.#timingRemote?.address
          && this.#timingOrigins.delete(decoded.origin.toString());
        if (expectedReply) {
          sample = timingReplySample(decoded, receivedAtNtp);
          this.emit('timing-sync', sample);
        } else {
          reply = buildTimingReply(message, this.#clock);
        }
      } catch {
        // Stray datagrams can share the UDP port; expose them without failing.
      }
      if (reply) this.#timingSocket.send(reply, remote.port, remote.address);
      this.emit('timing-packet', {
        message, remote, receivedAtNtp, decoded, sample, replied: Boolean(reply),
      });
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
      const receivedAtMs = Date.now();
      const payloadType = message.length >= 2 ? message[1] & 0x7f : null;
      if (payloadType === AUDIO_PAYLOAD.RETRANSMITTED) {
        try {
          if (this.#audioRemote && remote.address !== this.#audioRemote.address) {
            throw new Error('retransmitted audio packet came from an unexpected address');
          }
          const packet = {
            ...parseRetransmittedAudioPacket(message),
            raw: message,
            remote,
            receivedAtMs,
          };
          this.emit('audio-retransmitted-packet', packet);
          this.emit('audio-packet', packet);
        } catch (error) {
          this.emit('invalid-audio-packet', {
            error,
            message,
            remote,
            channel: 'control',
          });
        }
      }
      this.emit('audio-control-packet', {
        message,
        remote,
        receivedAtMs,
        payloadType,
      });
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

  /** Start probing the sender timing service advertised in its SETUP plist. */
  configureTiming({ address, port }) {
    if (!this.#timingSocket) throw new Error('Mirror transport is not started');
    if (typeof address !== 'string' || !address) throw new Error('timing address is required');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid timing port');
    this.#timingRemote = { address, port };
    this.#timingOrigins.clear();
    clearInterval(this.#timingTimer);
    this.#sendTimingRequest();
    this.#timingTimer = setInterval(() => this.#sendTimingRequest(), this.#timingIntervalMs);
    this.#timingTimer.unref?.();
  }

  /** Configure the sender UDP control endpoint used for 0x55 retransmit requests. */
  configureAudio({ address, controlPort }) {
    if (!this.#audioControlSocket) throw new Error('Mirror transport is not started');
    if (typeof address !== 'string' || !address) throw new Error('audio address is required');
    if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) {
      throw new Error('invalid audio control port');
    }
    this.#audioRemote = { address, port: controlPort };
    this.#audioRetransmitSequence = 0;
  }

  /**
   * Request a bounded contiguous RTP range from the sender.
   * Returns false when SETUP did not advertise a remote controlPort.
   */
  requestAudioRetransmit({ sequence, count = 1 }) {
    const remote = this.#audioRemote;
    if (!remote || !this.#audioControlSocket) return false;
    const requestSequence = this.#audioRetransmitSequence++ & 0xffff;
    const message = buildAudioRetransmitRequest({
      requestSequence,
      sequence,
      count,
    });
    this.#audioControlSocket.send(message, remote.port, remote.address, (error) => {
      if (error) {
        this.emit('audio-retransmit-error', {
          error,
          requestSequence,
          sequence,
          count,
          remote,
        });
      }
    });
    this.emit('audio-retransmit-request', {
      requestSequence,
      sequence,
      count,
      remote,
    });
    return true;
  }

  async close() {
    clearInterval(this.#timingTimer);
    this.#timingTimer = null;
    this.#timingRemote = null;
    this.#timingOrigins.clear();
    this.#audioRemote = null;
    this.#audioRetransmitSequence = 0;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#videoSockets.clear();
    this.#eventSockets.clear();
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

  #sendTimingRequest() {
    const remote = this.#timingRemote;
    if (!remote || !this.#timingSocket) return;
    const packet = buildTimingRequest(this.#timingSequence++, this.#clock);
    const origin = packet.readBigUInt64BE(24).toString();
    this.#timingOrigins.add(origin);
    while (this.#timingOrigins.size > 8) this.#timingOrigins.delete(this.#timingOrigins.values().next().value);
    this.#timingSocket.send(packet, remote.port, remote.address, (error) => {
      if (error) this.emit('error', error);
    });
    this.emit('timing-request', { message: packet, remote });
  }

  #track(socket) {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', (error) => this.emit('socket-error', error));
  }

  #acceptVideo(socket) {
    this.#track(socket);
    this.#videoSockets.add(socket);
    socket.once('close', () => {
      this.#videoSockets.delete(socket);
      this.emit('video-disconnection', {
        socket,
        activeConnections: this.#videoSockets.size,
      });
    });
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
    this.emit('video-connection', {
      socket,
      activeConnections: this.#videoSockets.size,
    });
  }

  #acceptEvent(socket) {
    this.#track(socket);
    this.#eventSockets.add(socket);
    socket.once('close', () => {
      this.#eventSockets.delete(socket);
      this.emit('event-disconnection', {
        socket,
        activeConnections: this.#eventSockets.size,
      });
    });
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
    this.emit('event-connection', {
      socket,
      activeConnections: this.#eventSockets.size,
    });
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
