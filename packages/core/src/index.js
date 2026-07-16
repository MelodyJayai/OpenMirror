// OpenMirror protocol core: wires together mDNS discovery, the RTSP control
// server, binary plist payloads and legacy pairing into an AirPlayReceiver.
// Decoder-ready media events are emitted for the separate @openmirror/media
// package and future desktop frontends.

import { EventEmitter } from 'node:events';
import { MdnsResponder } from './discovery/responder.js';
import { buildServices, randomDeviceId, DEFAULT_FEATURES } from './discovery/airplay.js';
import { RtspServer } from './rtsp/server.js';
import { encodeBplist, decodeBplist } from './plist/bplist.js';
import { DeviceIdentity, PairingSession } from './crypto/pairing.js';
import { MirrorTransport } from './stream/mirror.js';
import { FairPlaySession, createStubFairPlayProvider } from './crypto/fairplay.js';
import { MirrorStreamDecryptor, AudioPacketDecryptor } from './crypto/stream.js';
import { H264StreamProcessor, MIRROR_PAYLOAD } from './stream/h264.js';
import { AUDIO_PAYLOAD, RtpSequencer } from './stream/rtp.js';

export { MdnsResponder, localIPv4Addresses } from './discovery/responder.js';
export * as dns from './discovery/dns.js';
export { buildServices, randomDeviceId, DEFAULT_FEATURES, FEATURES, formatFeatures } from './discovery/airplay.js';
export { RtspServer } from './rtsp/server.js';
export { RtspParser, encodeResponse } from './rtsp/parser.js';
export { encodeBplist, decodeBplist } from './plist/bplist.js';
export { DeviceIdentity, PairingSession } from './crypto/pairing.js';
export { MirrorFrameParser, MirrorTransport, MIRROR_HEADER_BYTES } from './stream/mirror.js';
export {
  FairPlaySession, createStubFairPlayProvider, classifyFpSetup, isFairPlayMessage,
  FPLY_HEADER, FP_SETUP1_LENGTH, FP_SETUP2_LENGTH, FP_REPLY1_LENGTH,
  FP_REPLY2_LENGTH, FP_SETUP2_REPLY_HEADER,
} from './crypto/fairplay.js';
export {
  MirrorStreamDecryptor, AudioPacketDecryptor, deriveMirrorStreamKey, unsignedConnectionId,
} from './crypto/stream.js';
export {
  H264StreamProcessor, MIRROR_PAYLOAD, NAL_TYPE, parseAvcC, avccToAnnexB,
  parameterSetsToAnnexB, hasKeyframe,
} from './stream/h264.js';
export { parseRtpPacket, RtpSequencer, AUDIO_PAYLOAD, RTP_HEADER_BYTES } from './stream/rtp.js';
export {
  ntpNow, ntpToUnixMs, decodeTimingPacket, encodeTimingPacket, buildTimingReply,
  TIMING_REQUEST, TIMING_REPLY,
} from './stream/timing.js';

export class AirPlayReceiver extends EventEmitter {
  #responder;
  #rtsp;
  #identity;
  #options;
  #fairPlayProvider;

  constructor(options = {}) {
    super();
    this.#options = {
      name: options.name ?? 'OpenMirror',
      port: options.port ?? 7000,
      deviceId: options.deviceId ?? randomDeviceId(),
      features: options.features ?? DEFAULT_FEATURES,
      hostname: options.hostname,
    };
    // Inject a verified playfair provider for real-device interoperability.
    // The default provider implements only the public wire shape and cannot
    // derive a usable media key.
    this.#fairPlayProvider = options.fairPlayProvider ?? createStubFairPlayProvider();
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

    rtsp.handle('POST', '/fp-setup', (request, ctx) => {
      ctx.session.state.fairplay ??= new FairPlaySession(this.#fairPlayProvider);
      const fairplay = ctx.session.state.fairplay;
      const body = fairplay.handle(request.body);
      this.emit('fp-setup', {
        phase: fairplay.phase,
        bytes: request.body.length,
        session: ctx.session,
      });
      return {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      };
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
      const state = ctx.session.state;
      if (Buffer.isBuffer(payload?.ekey)) state.ekey = Buffer.from(payload.ekey);
      if (Buffer.isBuffer(payload?.eiv)) state.eiv = Buffer.from(payload.eiv);
      this.#resolveSessionKey(state, ctx.session);

      const requestedStreams = Array.isArray(payload?.streams) ? payload.streams : [];
      const streams = requestedStreams.map((stream) => this.#setupStream(stream, media, state));
      state.setup = payload;
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

  #resolveSessionKey(state, session) {
    if (state.sessionKey || !state.ekey) return;
    try {
      const unwrapped = this.#fairPlayProvider.decryptKey?.(state.ekey, state.fairplay);
      const key = unwrapped ?? state.fairplay?.sharedKey ?? null;
      if (key) {
        if (!Buffer.isBuffer(key) || key.length < 16) {
          throw new Error('FairPlay provider returned an invalid media key');
        }
        state.sessionKey = Buffer.from(key.subarray(0, 16));
      }
    } catch (error) {
      this.emit('stream-error', { error, type: 'fairplay-key', session });
    }
  }

  #setupStream(stream, media, state) {
    // AirPlay stream type 96 is audio; type 110 is screen mirroring video.
    if (stream.type === 96) {
      state.audio = {
        format: stream.audioFormat,
        decryptor: state.sessionKey && state.eiv?.length >= 16
          ? new AudioPacketDecryptor(state.sessionKey, state.eiv.subarray(0, 16))
          : null,
      };
      return {
        type: 96,
        dataPort: media.ports.audioPort,
        controlPort: media.ports.audioControlPort,
      };
    }

    if (stream.streamConnectionID !== undefined && state.sessionKey) {
      state.videoDecryptor = new MirrorStreamDecryptor(state.sessionKey, stream.streamConnectionID);
    }
    return {
      type: stream.type,
      dataPort: media.ports.videoPort,
      ...(stream.streamConnectionID === undefined ? {} : { streamConnectionID: stream.streamConnectionID }),
    };
  }

  async #media(ctx) {
    if (ctx.session.state.media) return ctx.session.state.media;
    const transport = new MirrorTransport();
    const bindHost = ctx.session.localAddress?.startsWith('::ffff:')
      ? ctx.session.localAddress.slice(7)
      : ctx.session.localAddress;
    const ports = await transport.start(bindHost);
    const media = { transport, ports };
    const session = ctx.session;
    session.state.media = media;

    const h264 = new H264StreamProcessor({
      onCodec: (codec) => this.emit('video-codec', { ...codec, session }),
      onVideo: (unit) => this.emit('video-data', { ...unit, session }),
    });
    const audioSequencer = new RtpSequencer((packet) => {
      const decryptor = session.state.audio?.decryptor;
      const payload = decryptor ? decryptor.decrypt(packet.payload) : packet.payload;
      this.emit('audio-data', {
        ...packet,
        payload,
        encrypted: !decryptor,
        session,
      });
    });

    transport.on('video-frame', (frame) => {
      const payload = frame.type === MIRROR_PAYLOAD.VIDEO && session.state.videoDecryptor
        ? session.state.videoDecryptor.decrypt(frame.payload)
        : frame.payload;
      const processedFrame = { ...frame, payload };
      this.emit('video-frame', { ...processedFrame, session });
      try {
        h264.push(processedFrame);
      } catch (error) {
        this.emit('stream-error', { error, type: frame.type, session });
      }
    });
    transport.on('audio-packet', (packet) => {
      if (packet.payloadType !== AUDIO_PAYLOAD.DATA) {
        this.emit('audio-packet', { ...packet, session });
        return;
      }
      audioSequencer.push(packet);
    });
    transport.on('invalid-audio-packet', (packet) => {
      this.emit('stream-error', { ...packet, type: 'audio-rtp', session });
    });
    transport.on('audio-control-packet', (packet) => {
      this.emit('audio-control-packet', { ...packet, session });
    });
    transport.on('video-connection', (socket) => this.emit('video-connection', { socket, session }));
    transport.on('event-connection', (socket) => this.emit('event-connection', { socket, session }));
    transport.on('timing-packet', (packet) => this.emit('timing-packet', { ...packet, session }));
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
