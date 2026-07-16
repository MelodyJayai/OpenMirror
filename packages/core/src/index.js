// OpenMirror protocol core: wires together mDNS discovery, the RTSP control
// server, binary plist payloads and legacy pairing into an AirPlayReceiver.
// Decoder-ready media events are emitted for the separate @openmirror/media
// package and future desktop frontends.

import { EventEmitter } from 'node:events';
import { MdnsResponder } from './discovery/responder.js';
import { encodeTxtRecord } from './discovery/dns.js';
import {
  buildServices, pairingIdentifier, randomDeviceId, DEFAULT_FEATURES,
} from './discovery/airplay.js';
import { RtspServer } from './rtsp/server.js';
import { encodeBplist, decodeBplist } from './plist/bplist.js';
import { DeviceIdentity, PairingSession } from './crypto/pairing.js';
import { MirrorTransport } from './stream/mirror.js';
import { FairPlaySession } from './crypto/fairplay.js';
import { createPlayFairProvider } from './crypto/playfair-provider.js';
import {
  MirrorStreamDecryptor, AudioPacketDecryptor, deriveFairPlaySessionKey,
} from './crypto/stream.js';
import {
  H264StreamProcessor, MIRROR_PAYLOAD, isMirrorVideoSuspended,
} from './stream/h264.js';
import {
  AUDIO_PAYLOAD, RtpSequencer, isAudioNoDataPayload, parseAudioSyncPacket,
} from './stream/rtp.js';
import { AirPlayMediaClock } from './stream/timing.js';
import { MediaActivityMonitor } from './stream/activity.js';

export { MdnsResponder, localIPv4Addresses, isUsableLanIPv4 } from './discovery/responder.js';
export * as dns from './discovery/dns.js';
export {
  buildServices, pairingIdentifier, randomDeviceId,
  DEFAULT_FEATURES, FEATURES, formatFeatures,
} from './discovery/airplay.js';
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
export { createPlayFairProvider, PLAYFAIR_ENCRYPTED_KEY_BYTES } from './crypto/playfair-provider.js';
export {
  MirrorStreamDecryptor, AudioPacketDecryptor, deriveMirrorStreamKey,
  deriveFairPlaySessionKey, unsignedConnectionId,
} from './crypto/stream.js';
export {
  H264StreamProcessor, MIRROR_PAYLOAD, NAL_TYPE, parseAvcC, parseSpsDimensions, avccToAnnexB,
  parameterSetsToAnnexB, hasKeyframe, MIRROR_VIDEO_OPTION, isMirrorVideoSuspended,
} from './stream/h264.js';
export {
  parseRtpPacket, parseAudioSyncPacket, parseAudioRetransmitRequest,
  parseRetransmittedAudioPacket, buildAudioRetransmitRequest,
  isAudioNoDataPayload, RtpSequencer, AUDIO_PAYLOAD, AAC_ELD_NO_DATA_MARKER,
  RTP_HEADER_BYTES, AUDIO_SYNC_PACKET_BYTES, AUDIO_RETRANSMIT_REQUEST_BYTES,
} from './stream/rtp.js';
export {
  ntpNow, ntpToUnixMs, ntpFixedToMs, decodeTimingPacket, encodeTimingPacket,
  buildTimingRequest, buildTimingReply, timingReplySample, signedRtpDelta,
  addRtpTicksToNtp, AirPlayMediaClock, TIMING_REQUEST, TIMING_REPLY,
} from './stream/timing.js';
export { MediaActivityMonitor } from './stream/activity.js';
export { AirPlayDiagnostics, analyzeInteroperabilityRecords } from './diagnostics.js';

export class AirPlayReceiver extends EventEmitter {
  #responder;
  #rtsp;
  #identity;
  #options;
  #fairPlayProvider;
  #mediaClosures = new Set();
  #serviceTxt = null;

  constructor(options = {}) {
    super();
    const deviceId = options.deviceId ?? randomDeviceId();
    this.#options = {
      name: options.name ?? 'OpenMirror',
      port: options.port ?? 7000,
      deviceId,
      pairingId: options.pairingId ?? pairingIdentifier(deviceId),
      features: options.features ?? DEFAULT_FEATURES,
      hostname: options.hostname,
      addresses: options.addresses,
      mediaLatencyMs: options.mediaLatencyMs ?? options.audioLatencyMs ?? 120,
      videoIdleMs: options.videoIdleMs ?? 5000,
      mediaIdleMs: options.mediaIdleMs ?? 7000,
    };
    // Tests and alternate implementations can inject a compatible provider;
    // production defaults to the vendored, sandboxed PlayFair implementation.
    this.#fairPlayProvider = options.fairPlayProvider ?? createPlayFairProvider();
    this.#identity = new DeviceIdentity({ privateKeySeed: options.privateKeySeed });
    this.#responder = new MdnsResponder({
      hostname: this.#options.hostname,
      addresses: this.#options.addresses,
    });
    this.#rtsp = new RtspServer();
    this.#responder.on('error', (error) => this.emit('error', error));
    this.#responder.on('warning', (error) => this.emit('warning', error));
    this.#responder.on('query', (info) => this.emit('discovery-query', info));
    this.#rtsp.on('error', (error) => this.emit('error', error));
    this.#rtsp.on('request', (info) => this.emit('request', info));
    this.#rtsp.on('session-opened', (session) => this.emit('session-opened', session));
    this.#rtsp.on('session-closed', (session) => {
      const closing = this.#closeMedia(session)
        .catch((error) => this.emit('error', error))
        .finally(() => {
          this.#mediaClosures.delete(closing);
          this.emit('session-closed', session);
        });
      this.#mediaClosures.add(closing);
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

    const services = buildServices({
      name: this.#options.name,
      deviceId: this.#options.deviceId,
      pairingId: this.#options.pairingId,
      publicKeyHex: this.#identity.publicKeyHex,
      airplayPort: port,
      features: this.#options.features,
    });
    this.#serviceTxt = {
      txtAirPlay: encodeTxtRecord(services[0].txt),
      txtRAOP: encodeTxtRecord(services[1].txt),
    };
    for (const service of services) {
      this.#responder.addService(service);
    }
    await this.#responder.start();

    this.emit('started', { port, name: this.#options.name });
    return { port };
  }

  async stop() {
    await this.#responder.stop();
    await this.#rtsp.close();
    await Promise.allSettled([...this.#mediaClosures]);
    this.emit('stopped');
  }

  #pairing(ctx) {
    ctx.session.state.pairing ??= new PairingSession(this.#identity);
    return ctx.session.state.pairing;
  }

  #installHandlers() {
    const rtsp = this.#rtsp;

    rtsp.handle('GET', '/info', (request, ctx) => {
      const info = this.#deviceInfo(request);
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

    rtsp.handle('POST', '/feedback', (request, ctx) => {
      const receivedAt = Date.now();
      ctx.session.state.lastFeedbackAt = receivedAt;
      this.emit('feedback', { session: ctx.session, receivedAt });
      return { status: 200 };
    });

    rtsp.handle('OPTIONS', (request) => ({
      status: 200,
      headers: {
        Public: 'SETUP, RECORD, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER',
      },
    }));

    rtsp.handle('SETUP', async (request, ctx) => {
      let payload = null;
      try {
        payload = decodeBplist(request.body);
      } catch {
        // Legacy SDP-style SETUP; handled in the media milestone.
      }
      const state = ctx.session.state;
      if (Buffer.isBuffer(payload?.ekey)) state.ekey = Buffer.from(payload.ekey);
      if (Buffer.isBuffer(payload?.eiv)) state.eiv = Buffer.from(payload.eiv);
      this.#resolveSessionKey(state, ctx.session);

      const requestedStreams = Array.isArray(payload?.streams) ? payload.streams : [];
      const audioStream = requestedStreams.find((stream) => stream.type === 96);
      const media = await this.#media(ctx, { sampleRate: audioStream?.sr ?? 44100 });
      if (Number.isInteger(payload?.timingPort) && payload.timingPort > 0) {
        media.transport.configureTiming({
          address: ctx.session.remoteAddress.replace(/^::ffff:/, ''),
          port: payload.timingPort,
        });
      }
      if (Number.isInteger(audioStream?.controlPort) && audioStream.controlPort > 0) {
        media.transport.configureAudio({
          address: ctx.session.remoteAddress.replace(/^::ffff:/, ''),
          controlPort: audioStream.controlPort,
        });
      }
      const streams = requestedStreams.map((stream) => this.#setupStream(stream, media, state));
      state.setup = payload;
      this.emit('setup', {
        payload,
        ports: media.ports,
        crypto: {
          sessionKeyReady: Boolean(state.sessionKey),
          audioDecryptorReady: Boolean(state.audio?.decryptor),
          videoDecryptorReady: Boolean(state.videoDecryptor),
        },
        session: ctx.session,
      });
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
      return {
        status: 200,
        headers: {
          'Audio-Latency': '11025',
          'Audio-Jack-Status': 'connected; type=analog',
        },
      };
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
      const media = ctx.session.state.media;
      if (media) {
        media.audioSequencer.reset();
        for (const packet of media.pendingAudio.splice(0)) {
          this.emit('audio-dropped', {
            sequence: packet.sequence,
            bytes: packet.payload.length,
            reason: 'flush',
            session: ctx.session,
          });
        }
        media.clock.resetAudio();
        media.activity.reset('flush');
      }
      this.emit('flush', { session: ctx.session });
      return { status: 200 };
    });
    rtsp.handle('TEARDOWN', async (request, ctx) => {
      await this.#closeMedia(ctx.session, 'teardown');
      this.emit('teardown', { session: ctx.session });
      return {
        status: 200,
        headers: { Connection: 'close' },
        close: true,
      };
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
        state.sessionKey = deriveFairPlaySessionKey(key, state.pairing?.sharedSecret);
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
        compressionType: stream.ct,
        samplesPerFrame: stream.spf,
        sampleRate: stream.sr ?? 44100,
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

  async #media(ctx, { sampleRate = 44100 } = {}) {
    if (ctx.session.state.media) return ctx.session.state.media;
    const transport = new MirrorTransport();
    const bindHost = ctx.session.localAddress?.startsWith('::ffff:')
      ? ctx.session.localAddress.slice(7)
      : ctx.session.localAddress;
    const ports = await transport.start(bindHost);
    const media = { transport, ports };
    const session = ctx.session;
    session.state.media = media;

    const mediaClock = new AirPlayMediaClock({
      sampleRate,
      targetLatencyMs: this.#options.mediaLatencyMs,
    });
    media.clock = mediaClock;
    const activity = new MediaActivityMonitor({
      videoIdleMs: this.#options.videoIdleMs,
      mediaIdleMs: this.#options.mediaIdleMs,
    });
    activity.on('state', (state) => this.emit('media-state', { ...state, session }));
    media.activity = activity;

    const h264 = new H264StreamProcessor({
      onCodec: (codec) => {
        activity.signal('heartbeat');
        this.emit('video-codec', { ...codec, session });
      },
      onVideo: (unit) => {
        activity.signal('video');
        this.emit('video-data', {
          ...unit,
          timing: mediaClock.mapVideo(unit.timestamp),
          session,
        });
      },
    });
    media.h264 = h264;
    const pendingAudio = [];
    media.pendingAudio = pendingAudio;
    const emitAudio = (packet, timing) => {
      try {
        const decryptor = session.state.audio?.decryptor;
        const payload = decryptor ? decryptor.decrypt(packet.payload) : packet.payload;
        const audio = session.state.audio;
        this.emit('audio-data', {
          ...packet,
          payload,
          encrypted: !decryptor,
          compressionType: audio?.compressionType,
          samplesPerFrame: audio?.samplesPerFrame,
          sampleRate: audio?.sampleRate ?? 44100,
          timing,
          session,
        });
      } catch (error) {
        this.emit('stream-error', { error, type: 'audio-decrypt', session });
      }
    };
    const audioSequencer = new RtpSequencer(
      (packet) => {
        if (isAudioNoDataPayload(
          packet.payload,
          session.state.audio?.compressionType,
        )) {
          this.emit('audio-no-data', {
            sequence: packet.sequence,
            timestamp: packet.timestamp,
            bytes: packet.payload.length,
            session,
          });
          return;
        }
        const timing = mediaClock.mapAudio(packet.timestamp);
        if (!timing) {
          pendingAudio.push(packet);
          if (pendingAudio.length > 256) {
            const dropped = pendingAudio.shift();
            this.emit('audio-dropped', {
              sequence: dropped.sequence,
              bytes: dropped.payload.length,
              reason: 'awaiting-sync',
              session,
            });
          }
          return;
        }
        emitAudio(packet, timing);
      },
      {
        onEvent: (event) => {
          let sent = null;
          if (event.type === 'retransmit-request') {
            sent = transport.requestAudioRetransmit({
              sequence: event.sequence,
              count: event.count,
            });
            this.emit('audio-retransmit-request', {
              sequence: event.sequence,
              count: event.count,
              attempt: event.attempt,
              sent,
              session,
            });
          }
          this.emit('audio-rtp-event', { ...event, sent, session });
        },
      },
    );
    media.audioSequencer = audioSequencer;

    transport.on('video-frame', (frame) => {
      try {
        if (frame.type !== MIRROR_PAYLOAD.VIDEO) activity.signal('heartbeat');
        const decryptor = frame.type === MIRROR_PAYLOAD.VIDEO
          ? session.state.videoDecryptor
          : null;
        const payload = decryptor
          ? decryptor.decrypt(frame.payload)
          : frame.payload;
        const processedFrame = {
          ...frame,
          payload,
          encrypted: frame.type === MIRROR_PAYLOAD.VIDEO && !decryptor,
          timing: mediaClock.mapVideo(frame.timestamp),
        };
        this.emit('video-frame', { ...processedFrame, session });
        try {
          h264.push(processedFrame);
        } finally {
          if (
            frame.type === MIRROR_PAYLOAD.CODEC
            && isMirrorVideoSuspended(frame.payloadOption)
          ) {
            activity.idle('video', 'sender-suspended');
          }
        }
      } catch (error) {
        this.emit('stream-error', { error, type: frame.type, session });
      }
    });
    transport.on('audio-packet', (packet) => {
      if (packet.payloadType !== AUDIO_PAYLOAD.DATA) {
        this.emit('audio-packet', { ...packet, session });
        return;
      }
      activity.signal('audio');
      audioSequencer.push(packet);
      this.emit('audio-rtp-stats', { stats: audioSequencer.stats, session });
    });
    transport.on('invalid-audio-packet', (packet) => {
      this.emit('stream-error', { ...packet, type: 'audio-rtp', session });
    });
    transport.on('audio-control-packet', (packet) => {
      try {
        const sync = parseAudioSyncPacket(packet.message);
        const timing = mediaClock.updateAudioSync({ ...sync, receivedAtMs: packet.receivedAtMs });
        this.emit('audio-sync', { ...sync, timing, session });
        while (pendingAudio.length) {
          const pending = pendingAudio.shift();
          emitAudio(pending, mediaClock.mapAudio(pending.timestamp));
        }
      } catch {
        // Retransmit requests and other control packets share this UDP port.
      }
      this.emit('audio-control-packet', { ...packet, session });
    });
    transport.on('audio-retransmitted-packet', (packet) => {
      this.emit('audio-retransmitted-packet', { ...packet, session });
    });
    transport.on('audio-retransmit-error', ({ error, ...event }) => {
      this.emit('stream-error', {
        error,
        type: 'audio-retransmit',
        session,
      });
      this.emit('audio-retransmit-error', { ...event, error, session });
    });
    transport.on('timing-sync', (sample) => {
      const clock = mediaClock.updateTimingReply(sample);
      this.emit('clock-sync', { ...sample, clock, session });
    });
    transport.on('video-connection', (event) => this.emit('video-connection', { ...event, session }));
    transport.on('video-disconnection', (event) => {
      if (event.activeConnections === 0) activity.idle('video', 'connection-closed');
      this.emit('video-disconnection', { ...event, session });
    });
    transport.on('event-connection', (event) => this.emit('event-connection', { ...event, session }));
    transport.on('event-disconnection', (event) => {
      this.emit('event-disconnection', { ...event, session });
    });
    transport.on('event-request', (request) => {
      let payload = null;
      if (request.body.length) {
        try {
          payload = decodeBplist(request.body);
        } catch (error) {
          this.emit('stream-error', { error, type: 'event-plist', session });
        }
      }
      this.emit('event', {
        method: request.method,
        uri: request.uri,
        headers: request.headers,
        body: request.body,
        payload,
        session,
      });
    });
    transport.on('event-error', ({ error }) => {
      this.emit('stream-error', { error, type: 'event-http', session });
    });
    transport.on('timing-packet', (packet) => this.emit('timing-packet', { ...packet, session }));
    transport.on('error', (error) => this.emit('error', error));
    return media;
  }

  async #closeMedia(session, reason = 'session-closed') {
    const media = session.state.media;
    if (!media) return;
    delete session.state.media;
    session.state.recording = false;
    this.emit('audio-rtp-stats', { stats: media.audioSequencer.stats, session });
    media.activity.close(reason);
    await media.transport.close();
  }

  #requestedInfoTxt(request) {
    const requested = new Set();
    const contentType = request.headers['content-type'] ?? '';
    if (contentType.toLowerCase().includes('application/x-apple-binary-plist')) {
      try {
        const payload = decodeBplist(request.body);
        for (const qualifier of payload?.qualifier ?? []) {
          if (qualifier === 'txtAirPlay' || qualifier === 'txtRAOP') requested.add(qualifier);
        }
      } catch {
        // A malformed qualified request receives an empty plist rather than
        // accidentally exposing the unrelated full /info response.
      }
    }
    const query = request.uri.includes('?') ? request.uri.slice(request.uri.indexOf('?') + 1) : '';
    if (query.includes('txtAirPlay')) requested.add('txtAirPlay');
    if (query.includes('txtRAOP')) requested.add('txtRAOP');
    return {
      qualified: Boolean(contentType) || requested.size > 0,
      requested,
    };
  }

  #deviceInfo(request) {
    const { qualified, requested } = this.#requestedInfoTxt(request);
    if (qualified) {
      const info = {};
      for (const key of requested) {
        if (this.#serviceTxt?.[key]) info[key] = this.#serviceTxt[key];
      }
      return info;
    }
    return {
      deviceID: this.#options.deviceId,
      features: Number(this.#options.features & 0xffffffffn) +
        Number(this.#options.features >> 32n) * 2 ** 32,
      model: 'AppleTV3,2',
      name: this.#options.name,
      sourceVersion: '220.68',
      pi: this.#options.pairingId,
      pk: this.#identity.publicKeyRaw,
      vv: 2,
      statusFlags: 68,
      keepAliveLowPower: 1,
      keepAliveSendStatsAsBody: 1,
      macAddress: this.#options.deviceId,
      initialVolume: 0,
      displays: [{
        primaryInputDevice: 1,
        rotation: false,
        widthPhysical: 0,
        heightPhysical: 0,
        width: 1920,
        height: 1080,
        widthPixels: 1920,
        heightPixels: 1080,
        refreshRate: 1 / 60,
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
