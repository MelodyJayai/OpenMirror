// OpenMirror protocol core: wires together mDNS discovery, the RTSP control
// server, binary plist payloads and legacy pairing into an AirPlayReceiver.
// Media stream handling (video/audio/FairPlay) lands in later milestones.

import { EventEmitter } from 'node:events';
import { MdnsResponder } from './discovery/responder.js';
import { buildServices, randomDeviceId, DEFAULT_FEATURES } from './discovery/airplay.js';
import { RtspServer } from './rtsp/server.js';
import { encodeBplist, decodeBplist } from './plist/bplist.js';
import { DeviceIdentity, PairingSession } from './crypto/pairing.js';
import { MirrorTransport } from './stream/mirror.js';

export { MdnsResponder, localIPv4Addresses } from './discovery/responder.js';
export * as dns from './discovery/dns.js';
export { buildServices, randomDeviceId, DEFAULT_FEATURES, FEATURES, formatFeatures } from './discovery/airplay.js';
export { RtspServer } from './rtsp/server.js';
export { RtspParser, encodeResponse } from './rtsp/parser.js';
export { encodeBplist, decodeBplist } from './plist/bplist.js';
export { DeviceIdentity, PairingSession } from './crypto/pairing.js';
export { MirrorFrameParser, MirrorTransport, MIRROR_HEADER_BYTES } from './stream/mirror.js';

export class AirPlayReceiver extends EventEmitter {
  #responder;
  #rtsp;
  #identity;
  #options;

  constructor(options = {}) {
    super();
    this.#options = {
      name: options.name ?? 'OpenMirror',
      port: options.port ?? 7000,
      deviceId: options.deviceId ?? randomDeviceId(),
      features: options.features ?? DEFAULT_FEATURES,
      hostname: options.hostname,
    };
    this.#identity = new DeviceIdentity({ privateKeySeed: options.privateKeySeed });
    this.#responder = new MdnsResponder({ hostname: this.#options.hostname });
    this.#rtsp = new RtspServer();
    this.#rtsp.on('session-closed', (session) => {
      this.#closeMedia(session).catch((error) => this.emit('error', error));
    });
    this.#installHandlers();
  }

  get identity() {
    return this.#identity;
  }

  get options() {
    return { ...this.#options };
  }

  async start() {
    const port = await this.#rtsp.listen(this.#options.port);
    this.#options.port = port;

    for (const service of buildServices({
      name: this.#options.name,
      deviceId: this.#options.deviceId,
      publicKeyHex: this.#identity.publicKeyHex,
      airplayPort: port,
      features: this.#options.features,
    })) {
      this.#responder.addService(service);
    }
    await this.#responder.start();

    this.#responder.on('error', (err) => this.emit('error', err));
    this.#rtsp.on('error', (err) => this.emit('error', err));
    this.#rtsp.on('request', (info) => this.emit('request', info));

    this.emit('started', { port, name: this.#options.name });
    return { port };
  }

  async stop() {
    await this.#responder.stop();
    await this.#rtsp.close();
    this.emit('stopped');
  }

  #pairing(ctx) {
    ctx.session.state.pairing ??= new PairingSession(this.#identity);
    return ctx.session.state.pairing;
  }

  #installHandlers() {
    const rtsp = this.#rtsp;

    rtsp.handle('GET', '/info', (request, ctx) => {
      const info = this.#deviceInfo();
      return {
        status: 200,
        headers: { 'Content-Type': 'application/x-apple-binary-plist' },
        body: encodeBplist(info),
      };
    });

    rtsp.handle('POST', '/pair-setup', (request, ctx) => {
      const body = this.#pairing(ctx).pairSetup(request.body);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      };
    });

    rtsp.handle('POST', '/pair-verify', (request, ctx) => {
      const { body, done } = this.#pairing(ctx).pairVerify(request.body);
      if (done) this.emit('paired', { session: ctx.session });
      return {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      };
    });

    // FairPlay key exchange — M3 follow-up. Acknowledged so the sender keeps
    // talking during protocol bring-up; real fp-setup replies land next.
    rtsp.handle('POST', '/fp-setup', (request) => {
      this.emit('fp-setup', { bytes: request.body.length });
      return { status: 200, headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(0) };
    });

    rtsp.handle('POST', '/feedback', () => ({ status: 200 }));

    rtsp.handle('OPTIONS', (request) => ({
      status: 200,
      headers: {
        Public: 'ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER, POST, GET',
      },
    }));

    rtsp.handle('SETUP', async (request, ctx) => {
      let payload = null;
      try {
        payload = decodeBplist(request.body);
      } catch {
        // Legacy SDP-style SETUP; handled in the media milestone.
      }
      const media = await this.#media(ctx);
      const requestedStreams = Array.isArray(payload?.streams) ? payload.streams : [];
      const streams = requestedStreams.map((stream) => ({
        type: stream.type,
        dataPort: media.ports.videoPort,
        ...(stream.streamConnectionID === undefined ? {} : { streamConnectionID: stream.streamConnectionID }),
      }));
      ctx.session.state.setup = payload;
      this.emit('setup', { payload, ports: media.ports, session: ctx.session });
      return {
        status: 200,
        headers: { 'Content-Type': 'application/x-apple-binary-plist' },
        body: encodeBplist({
          eventPort: media.ports.eventPort,
          timingPort: media.ports.timingPort,
          ...(streams.length ? { streams } : {}),
        }),
      };
    });

    rtsp.handle('RECORD', (request, ctx) => {
      ctx.session.state.recording = true;
      this.emit('record', { session: ctx.session });
      return { status: 200, headers: { 'Audio-Latency': '11025' } };
    });
    rtsp.handle('SET_PARAMETER', () => ({ status: 200 }));
    rtsp.handle('GET_PARAMETER', (request) => {
      const text = request.body.toString('latin1').trim();
      if (text === 'volume') {
        return {
          status: 200,
          headers: { 'Content-Type': 'text/parameters' },
          body: Buffer.from('volume: 0.0\r\n', 'latin1'),
        };
      }
      return { status: 200 };
    });
    rtsp.handle('FLUSH', (request, ctx) => {
      this.emit('flush', { session: ctx.session });
      return { status: 200 };
    });
    rtsp.handle('TEARDOWN', async (request, ctx) => {
      await this.#closeMedia(ctx.session);
      this.emit('teardown', { session: ctx.session });
      return { status: 200 };
    });
  }

  async #media(ctx) {
    if (ctx.session.state.media) return ctx.session.state.media;
    const transport = new MirrorTransport();
    const bindHost = ctx.session.localAddress?.startsWith('::ffff:')
      ? ctx.session.localAddress.slice(7)
      : ctx.session.localAddress;
    const ports = await transport.start(bindHost);
    const media = { transport, ports };
    ctx.session.state.media = media;
    transport.on('video-frame', (frame) => this.emit('video-frame', { ...frame, session: ctx.session }));
    transport.on('video-connection', (socket) => this.emit('video-connection', { socket, session: ctx.session }));
    transport.on('event-connection', (socket) => this.emit('event-connection', { socket, session: ctx.session }));
    transport.on('timing-packet', (packet) => this.emit('timing-packet', { ...packet, session: ctx.session }));
    transport.on('error', (error) => this.emit('error', error));
    return media;
  }

  async #closeMedia(session) {
    const media = session.state.media;
    if (!media) return;
    delete session.state.media;
    session.state.recording = false;
    await media.transport.close();
  }

  #deviceInfo() {
    return {
      deviceid: this.#options.deviceId,
      features: Number(this.#options.features & 0xffffffffn) +
        Number(this.#options.features >> 32n) * 2 ** 32,
      model: 'AppleTV3,2',
      name: this.#options.name,
      srcvers: '220.68',
      pi: this.#options.deviceId.toLowerCase(),
      pk: this.#identity.publicKeyRaw,
      vv: 2,
      statusFlags: 4,
      keepAliveLowPower: 1,
      keepAliveSendStatsAsBody: 1,
      macAddress: this.#options.deviceId,
      displays: [{
        primaryInputDevice: 1,
        rotation: false,
        widthPhysical: 0,
        heightPhysical: 0,
        widthPixels: 1920,
        heightPixels: 1080,
        refreshRate: 60,
        maxFPS: 60,
        overscanned: false,
        features: 14,
        uuid: 'e5f7a68d-7b0f-4305-984b-974f677a150b',
      }],
      audioFormats: [
        { type: 100, audioInputFormats: 0x3fffffc, audioOutputFormats: 0x3fffffc },
        { type: 101, audioInputFormats: 0x3fffffc, audioOutputFormats: 0x3fffffc },
      ],
      audioLatencies: [
        { type: 100, audioType: 'default', inputLatencyMicros: 0, outputLatencyMicros: 400000 },
        { type: 101, audioType: 'default', inputLatencyMicros: 0, outputLatencyMicros: 400000 },
      ],
    };
  }
}
