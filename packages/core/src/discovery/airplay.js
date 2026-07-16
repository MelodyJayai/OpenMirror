// AirPlay/RAOP service definitions: TXT records and feature flags advertised over mDNS.
// Feature bit values follow the community-documented AirPlay feature bitmask
// (see openairplay/airplay2-receiver and UxPlay), selecting the legacy
// (non-HomeKit-transient) pairing path with FairPlay v2.5 key exchange.

import crypto from 'node:crypto';

export const AIRPLAY_SERVICE_TYPE = '_airplay._tcp.local';
export const RAOP_SERVICE_TYPE = '_raop._tcp.local';

export const FEATURES = {
  VIDEO: 1n << 0n,
  PHOTO: 1n << 1n,
  VIDEO_FAIRPLAY: 1n << 2n,
  VIDEO_VOLUME_CONTROL: 1n << 3n,
  VIDEO_HTTP_LIVE_STREAMS: 1n << 4n,
  SLIDESHOW: 1n << 5n,
  SCREEN: 1n << 7n,          // mirroring
  SCREEN_ROTATE: 1n << 8n,
  AUDIO: 1n << 9n,
  AUDIO_REDUNDANT: 1n << 11n,
  FPS_APV2P5_AES_GCM: 1n << 12n, // FairPlay video decryption
  PHOTO_CACHING: 1n << 13n,
  AUTHENTICATION_4: 1n << 14n,   // FairPlay auth
  METADATA_TEXT: 1n << 15n,
  METADATA_ARTWORK: 1n << 16n,
  METADATA_PROGRESS: 1n << 17n,
  AUDIO_FORMAT_1: 1n << 18n,
  AUDIO_FORMAT_2: 1n << 19n,     // AAC-LC
  AUDIO_FORMAT_3: 1n << 20n,     // AAC-ELD
  AUDIO_FORMAT_4: 1n << 21n,
  AUTHENTICATION_1: 1n << 23n,   // RSA auth (legacy RAOP)
  HAS_UNIFIED_ADVERTISER_INFO: 1n << 26n,
  SUPPORTS_LEGACY_PAIRING: 1n << 27n,
  RAOP: 1n << 30n,
  IS_CARPLAY: 1n << 32n,
  SUPPORTS_VOLUME: 1n << 33n,
  SUPPORTS_AIRPLAY_VIDEO_QUEUE: 1n << 34n,
  SUPPORTS_AIRPLAY_FROM_CLOUD: 1n << 35n,
  SUPPORTS_UNIFIED_MEDIA_CONTROL: 1n << 38n,
  SUPPORTS_BUFFERED_AUDIO: 1n << 40n,
  SUPPORTS_PTP: 1n << 41n,
  SUPPORTS_SCREEN_MULTI_CODEC: 1n << 42n,
  SUPPORTS_SYSTEM_PAIRING: 1n << 43n,
  IS_AP_VALERIA_SCREEN_SENDER: 1n << 44n,
  SUPPORTS_HK_PAIRING_AND_ACCESS_CONTROL: 1n << 46n,
  SUPPORTS_TRANSIENT_PAIRING: 1n << 48n,
  METADATA_FEATURES_4: 1n << 50n,
  SUPPORTS_UNIFIED_PAIR_SETUP_AND_MFI: 1n << 51n,
  SUPPORTS_SET_PEERS_EXTENDED_MESSAGE: 1n << 52n,
};

/**
 * Exact legacy-mirroring capability mask used by current UxPlay receivers.
 *
 * Do not derive this from only the named/public feature bits above: several
 * undocumented compatibility bits (6, 10, 22, 25 and 28) are required by
 * current iOS senders, while advertising unsupported Video/HLS or ScreenRotate
 * changes the sender's negotiation path. Bit 27 selects legacy pair-verify and
 * bit 30 advertises RAOP on the same control port.
 */
export const DEFAULT_FEATURES = 0x5A7FFEE6n;

/** Format the 64-bit feature mask as AirPlay's "0xLOW,0xHIGH" TXT syntax. */
export function formatFeatures(features) {
  const low = features & 0xffffffffn;
  const high = features >> 32n;
  const hex = (v) => `0x${v.toString(16).toUpperCase()}`;
  return high > 0n ? `${hex(low)},${hex(high)}` : hex(low);
}

/** Generate a stable-looking random MAC-style device id: "AA:BB:CC:DD:EE:FF". */
export function randomDeviceId() {
  const bytes = crypto.randomBytes(6);
  bytes[0] = (bytes[0] | 0x02) & 0xfe; // locally administered, unicast
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/** Stable UUID-format pairing identifier derived from the receiver device id. */
export function pairingIdentifier(deviceId) {
  if (typeof deviceId !== 'string' || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(deviceId)) {
    throw new Error('deviceId must be a colon-separated 6-byte identifier');
  }
  const bytes = crypto.createHash('sha256')
    .update('OpenMirror AirPlay Pairing Identifier\0')
    .update(deviceId.toUpperCase())
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/**
 * Build the two mDNS service registrations (AirPlay + RAOP) for a receiver.
 * identity: { name, deviceId, publicKeyHex, airplayPort, features?, pairingId? }
 */
export function buildServices(identity) {
  const {
    name,
    deviceId,
    publicKeyHex,
    airplayPort = 7000,
    features = DEFAULT_FEATURES,
    model = 'AppleTV3,2',
    pairingId = pairingIdentifier(deviceId),
  } = identity;

  const featuresTxt = formatFeatures(features);

  const airplayTxt = {
    deviceid: deviceId,
    features: featuresTxt,
    flags: '0x4',
    model,
    pk: publicKeyHex,
    pi: pairingId,
    pw: 'false',
    srcvers: '220.68',
    vv: '2',
  };

  // RAOP instance name is "<deviceid-without-colons>@<name>".
  const raopName = `${deviceId.replaceAll(':', '')}@${name}`;
  const raopTxt = {
    ch: '2',            // audio channels
    cn: '0,1,2,3',      // codecs: PCM, ALAC, AAC-LC, AAC-ELD
    da: 'true',
    et: '0,3,5',        // encryption types: none, FairPlay, FairPlay SAPv2.5
    ft: featuresTxt,
    am: model,
    md: '0,1,2',        // metadata: text, artwork, progress
    pk: publicKeyHex,
    pw: 'false',
    rhd: '5.6.0.0',
    sf: '0x4',
    sr: '44100',
    ss: '16',
    sv: 'false',
    tp: 'UDP',
    txtvers: '1',
    vn: '65537',
    vs: '220.68',
    vv: '2',
  };

  return [
    { name, type: AIRPLAY_SERVICE_TYPE, port: airplayPort, txt: airplayTxt },
    { name: raopName, type: RAOP_SERVICE_TYPE, port: airplayPort, txt: raopTxt },
  ];
}
