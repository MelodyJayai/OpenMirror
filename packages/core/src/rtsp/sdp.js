// RAOP (AirPlay audio-only) legacy control plane. Older senders and audio-only
// sessions negotiate the stream with an RFC 4566 SDP body in ANNOUNCE plus a
// classic RTSP Transport header in SETUP, instead of the binary-plist SETUP
// used by mirror sessions. Apple SDP attribute extensions carried here:
//
//   a=rtpmap:96 AppleLossless            codec (ALAC / mpeg4-generic / L16)
//   a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100
//                                        ALAC decoder parameters (11 fields)
//   a=fpaeskey:<base64>                  FairPlay-wrapped AES stream key
//   a=rsaaeskey:<base64>                 RSA-wrapped key (unsupported: et=1)
//   a=aesiv:<base64>                     16-byte AES-CBC IV
//   a=min-latency / a=max-latency        sender latency bounds in RTP ticks

/** AirPlay SETUP/ANNOUNCE audio compression-type identifiers. */
export const RAOP_COMPRESSION = {
  PCM: 1,
  ALAC: 2,
  AAC_LC: 4,
  AAC_ELD: 8,
};

const ALAC_FMTP_FIELDS = [
  'frameLength', 'compatibleVersion', 'bitDepth', 'pb', 'mb', 'kb',
  'channels', 'maxRun', 'maxFrameBytes', 'avgBitRate', 'sampleRate',
];

function decodeBase64Attribute(name, value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.replaceAll(/\s/g, ''))) {
    throw new Error(`SDP ${name} attribute is not valid base64`);
  }
  return Buffer.from(value, 'base64');
}

/**
 * Parse a RAOP ANNOUNCE SDP body. Returns the negotiated audio format and any
 * stream-key material; key bytes are returned as Buffers and never logged.
 */
export function parseRaopAnnounce(body) {
  const text = Buffer.isBuffer(body) ? body.toString('latin1') : String(body ?? '');
  const attributes = new Map();
  let media = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!/^[a-z]=/.test(line)) throw new Error(`Invalid SDP line: ${line.slice(0, 40)}`);
    const kind = line[0];
    const value = line.slice(2);
    if (kind === 'm') {
      const match = /^audio\s+\d+\s+RTP\/AVP\s+(\d+)$/.exec(value);
      // Attributes after a non-audio media section do not describe our stream.
      if (!match && media) break;
      if (match) media = { payloadType: Number(match[1]) };
      continue;
    }
    if (kind !== 'a' || !media) continue;
    const colon = value.indexOf(':');
    if (colon === -1) attributes.set(value, '');
    else attributes.set(value.slice(0, colon), value.slice(colon + 1).trim());
  }
  if (!media) throw new Error('SDP has no audio media description');

  const rtpmap = attributes.get('rtpmap');
  let codec = null;
  let sampleRate = 44100;
  let channels = 2;
  if (rtpmap !== undefined) {
    const match = /^(\d+)\s+([^/\s]+)(?:\/(\d+))?(?:\/(\d+))?/.exec(rtpmap);
    if (!match || Number(match[1]) !== media.payloadType) {
      throw new Error('SDP rtpmap does not describe the audio payload type');
    }
    const encoding = match[2].toLowerCase();
    if (encoding === 'applelossless') codec = 'alac';
    else if (encoding === 'mpeg4-generic') codec = 'aac';
    else if (encoding === 'l16') codec = 'pcm';
    else codec = encoding;
    if (match[3]) sampleRate = Number(match[3]);
    if (match[4]) channels = Number(match[4]);
  }

  let alac = null;
  let samplesPerFrame = null;
  const fmtp = attributes.get('fmtp');
  if (fmtp !== undefined) {
    const space = fmtp.indexOf(' ');
    const fmtpPayloadType = Number(fmtp.slice(0, space === -1 ? undefined : space));
    if (fmtpPayloadType !== media.payloadType) {
      throw new Error('SDP fmtp does not describe the audio payload type');
    }
    const params = space === -1 ? '' : fmtp.slice(space + 1).trim();
    if (codec === 'alac') {
      const fields = params.split(/\s+/).map(Number);
      if (fields.length !== ALAC_FMTP_FIELDS.length || fields.some((n) => !Number.isInteger(n) || n < 0)) {
        throw new Error(`ALAC fmtp must contain ${ALAC_FMTP_FIELDS.length} unsigned integers`);
      }
      alac = Object.fromEntries(ALAC_FMTP_FIELDS.map((name, i) => [name, fields[i]]));
      samplesPerFrame = alac.frameLength;
      sampleRate = alac.sampleRate || sampleRate;
      channels = alac.channels || channels;
    } else if (codec === 'aac') {
      for (const pair of params.split(';')) {
        const [key, value] = pair.split('=').map((s) => s.trim());
        if (key?.toLowerCase() === 'constantduration' && Number.isInteger(Number(value))) {
          samplesPerFrame = Number(value);
        }
      }
      samplesPerFrame ??= 1024;
    }
  }

  const fpaeskey = attributes.get('fpaeskey');
  const rsaaeskey = attributes.get('rsaaeskey');
  const aesiv = attributes.get('aesiv');
  const encryption = fpaeskey !== undefined ? 'fairplay' : rsaaeskey !== undefined ? 'rsa' : 'none';
  const eiv = aesiv === undefined ? null : decodeBase64Attribute('aesiv', aesiv);
  if (eiv && eiv.length !== 16) throw new Error('SDP aesiv must decode to 16 bytes');
  if (encryption !== 'none' && !eiv) throw new Error('Encrypted RAOP stream is missing aesiv');

  const latency = (name) => {
    const value = attributes.get(name);
    return value !== undefined && Number.isInteger(Number(value)) ? Number(value) : null;
  };

  const compressionType = {
    alac: RAOP_COMPRESSION.ALAC,
    aac: RAOP_COMPRESSION.AAC_LC,
    pcm: RAOP_COMPRESSION.PCM,
  }[codec] ?? null;

  return {
    payloadType: media.payloadType,
    codec,
    compressionType,
    sampleRate,
    channels,
    samplesPerFrame,
    alac,
    encryption,
    ekey: fpaeskey === undefined ? null : decodeBase64Attribute('fpaeskey', fpaeskey),
    eiv,
    minLatency: latency('min-latency'),
    maxLatency: latency('max-latency'),
  };
}

function parsePort(name, value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Transport ${name} must be a valid port number`);
  }
  return port;
}

/** Parse a classic RTSP Transport header ("RTP/AVP/UDP;unicast;control_port=…"). */
export function parseTransportHeader(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Transport header is required');
  }
  const [protocol, ...rest] = value.split(';').map((part) => part.trim());
  if (!/^RTP\/AVP(\/(UDP|TCP))?$/i.test(protocol)) {
    throw new Error(`Unsupported Transport protocol: ${protocol}`);
  }
  const params = {};
  let unicast = false;
  for (const part of rest) {
    if (!part) continue;
    const equals = part.indexOf('=');
    if (equals === -1) {
      if (part.toLowerCase() === 'unicast') unicast = true;
      else params[part.toLowerCase()] = true;
      continue;
    }
    params[part.slice(0, equals).toLowerCase()] = part.slice(equals + 1);
  }
  return {
    protocol: protocol.toUpperCase(),
    udp: !/TCP$/i.test(protocol),
    unicast,
    mode: typeof params.mode === 'string' ? params.mode : null,
    controlPort: params.control_port === undefined ? null : parsePort('control_port', params.control_port),
    timingPort: params.timing_port === undefined ? null : parsePort('timing_port', params.timing_port),
    params,
  };
}

/** Build the receiver's SETUP Transport response advertising its UDP ports. */
export function buildTransportHeader({ serverPort, controlPort, timingPort }) {
  for (const [name, value] of Object.entries({ serverPort, controlPort, timingPort })) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${name} must be a valid port number`);
    }
  }
  return 'RTP/AVP/UDP;unicast;mode=record'
    + `;server_port=${serverPort};control_port=${controlPort};timing_port=${timingPort}`;
}

/**
 * Parse an RTSP text/parameters body ("volume: -11.5\r\n…") into a map.
 * Used by RAOP SET_PARAMETER (volume, progress) and GET_PARAMETER requests.
 */
export function parseTextParameters(body) {
  const text = Buffer.isBuffer(body) ? body.toString('latin1') : String(body ?? '');
  const parameters = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    parameters[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return parameters;
}

/** Parse the RECORD/FLUSH RTP-Info header ("seq=44;rtptime=2789220"). */
export function parseRtpInfoHeader(value) {
  const info = {};
  if (typeof value !== 'string') return info;
  for (const part of value.split(';')) {
    const [key, raw] = part.split('=').map((s) => s.trim());
    if (!key || raw === undefined) continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) info[key.toLowerCase()] = parsed;
  }
  return info;
}
