// DNS wire-format encoding/decoding (RFC 1035) — the subset needed for mDNS (RFC 6762).
// Supports A, AAAA, PTR, TXT, SRV, NSEC records and name compression on decode.

export const TYPE = {
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  NSEC: 47,
  ANY: 255,
};

export const CLASS_IN = 1;
// mDNS: top bit of class is cache-flush (records) / unicast-response (questions).
export const CACHE_FLUSH = 0x8000;
export const UNICAST_RESPONSE = 0x8000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode a dotted name into DNS label wire format (no compression). */
export function encodeName(name) {
  const parts = name.split('.').filter((p) => p.length > 0);
  const chunks = [];
  for (const part of parts) {
    const bytes = encoder.encode(part);
    if (bytes.length > 63) throw new Error(`DNS label too long: ${part}`);
    chunks.push(Buffer.from([bytes.length]), Buffer.from(bytes));
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/** Decode a (possibly compressed) name at `offset`. Returns { name, next }. */
export function decodeName(buf, offset) {
  const labels = [];
  let next = -1; // caller-visible offset after the name at the original position
  let pos = offset;
  let jumps = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('DNS name overruns buffer');
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('Truncated compression pointer');
      if (++jumps > 128) throw new Error('Compression pointer loop');
      const target = ((len & 0x3f) << 8) | buf[pos + 1];
      if (next === -1) next = pos + 2;
      if (target >= pos) throw new Error('Forward compression pointer');
      pos = target;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error(`Bad label length byte 0x${len.toString(16)}`);
    if (pos + 1 + len > buf.length) throw new Error('DNS label overruns buffer');
    labels.push(decoder.decode(buf.subarray(pos + 1, pos + 1 + len)));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: next === -1 ? pos : next };
}

/** Encode a DNS-SD TXT map as the length-prefixed RDATA used by mDNS and /info. */
export function encodeTxtRecord(data) {
  const chunks = [];
  for (const [key, value] of Object.entries(data)) {
    const entry = value === true
      ? Buffer.from(encoder.encode(key))
      : Buffer.concat([
          Buffer.from(encoder.encode(`${key}=`)),
          Buffer.isBuffer(value) ? value : Buffer.from(encoder.encode(String(value))),
        ]);
    if (entry.length > 255) throw new Error(`TXT entry too long: ${key}`);
    chunks.push(Buffer.from([entry.length]), entry);
  }
  if (chunks.length === 0) chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function encodeRdata(record) {
  switch (record.type) {
    case TYPE.A: {
      const octets = record.data.split('.').map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        throw new Error(`Bad IPv4 address: ${record.data}`);
      }
      return Buffer.from(octets);
    }
    case TYPE.AAAA: {
      const groups = expandIPv6(record.data);
      const out = Buffer.alloc(16);
      groups.forEach((g, i) => out.writeUInt16BE(g, i * 2));
      return out;
    }
    case TYPE.PTR:
      return encodeName(record.data);
    case TYPE.SRV: {
      const { priority = 0, weight = 0, port, target } = record.data;
      return Buffer.concat([
        u16(priority), u16(weight), u16(port),
        encodeName(target),
      ]);
    }
    case TYPE.TXT: {
      // record.data: object of key -> string|Buffer|true
      return encodeTxtRecord(record.data);
    }
    default:
      if (Buffer.isBuffer(record.data)) return record.data;
      throw new Error(`Cannot encode rdata for type ${record.type}`);
  }
}

function decodeRdata(type, buf, offset, length) {
  const end = offset + length;
  switch (type) {
    case TYPE.A:
      return Array.from(buf.subarray(offset, end)).join('.');
    case TYPE.AAAA: {
      const groups = [];
      for (let i = offset; i + 1 < end; i += 2) groups.push(buf.readUInt16BE(i).toString(16));
      return groups.join(':');
    }
    case TYPE.PTR:
      return decodeName(buf, offset).name;
    case TYPE.SRV: {
      const { name: target } = decodeName(buf, offset + 6);
      return {
        priority: buf.readUInt16BE(offset),
        weight: buf.readUInt16BE(offset + 2),
        port: buf.readUInt16BE(offset + 4),
        target,
      };
    }
    case TYPE.TXT: {
      const map = {};
      let pos = offset;
      while (pos < end) {
        const len = buf[pos];
        const entry = decoder.decode(buf.subarray(pos + 1, pos + 1 + len));
        pos += 1 + len;
        if (!entry) continue;
        const eq = entry.indexOf('=');
        if (eq === -1) map[entry] = true;
        else map[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      return map;
    }
    default:
      return Buffer.from(buf.subarray(offset, end));
  }
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function expandIPv6(addr) {
  // Strip zone index (fe80::1%eth0).
  const clean = addr.split('%')[0];
  const halves = clean.split('::');
  if (halves.length > 2) throw new Error(`Bad IPv6 address: ${addr}`);
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && head.length !== 8)) {
    throw new Error(`Bad IPv6 address: ${addr}`);
  }
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  return groups.map((g) => parseInt(g || '0', 16));
}

/**
 * Encode a DNS message.
 * message = { id?, flags?, questions?: [{name,type,class?,unicastResponse?}],
 *             answers?, authorities?, additionals?: [{name,type,class?,ttl?,cacheFlush?,data}] }
 */
export function encodeMessage(message) {
  const questions = message.questions ?? [];
  const answers = message.answers ?? [];
  const authorities = message.authorities ?? [];
  const additionals = message.additionals ?? [];

  const header = Buffer.alloc(12);
  header.writeUInt16BE(message.id ?? 0, 0);
  header.writeUInt16BE(message.flags ?? 0, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authorities.length, 8);
  header.writeUInt16BE(additionals.length, 10);

  const chunks = [header];
  for (const q of questions) {
    chunks.push(
      encodeName(q.name),
      u16(q.type),
      u16((q.class ?? CLASS_IN) | (q.unicastResponse ? UNICAST_RESPONSE : 0)),
    );
  }
  for (const record of [...answers, ...authorities, ...additionals]) {
    const rdata = encodeRdata(record);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(record.type, 0);
    fixed.writeUInt16BE((record.class ?? CLASS_IN) | (record.cacheFlush ? CACHE_FLUSH : 0), 2);
    fixed.writeUInt32BE(record.ttl ?? 120, 4);
    fixed.writeUInt16BE(rdata.length, 8);
    chunks.push(encodeName(record.name), fixed, rdata);
  }
  return Buffer.concat(chunks);
}

/** Decode a DNS message buffer into the same shape encodeMessage accepts. */
export function decodeMessage(buf) {
  if (buf.length < 12) throw new Error('DNS message too short');
  const message = {
    id: buf.readUInt16BE(0),
    flags: buf.readUInt16BE(2),
    questions: [],
    answers: [],
    authorities: [],
    additionals: [],
  };
  const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];
  let pos = 12;

  for (let i = 0; i < counts[0]; i++) {
    const { name, next } = decodeName(buf, pos);
    const type = buf.readUInt16BE(next);
    const klass = buf.readUInt16BE(next + 2);
    message.questions.push({
      name,
      type,
      class: klass & 0x7fff,
      unicastResponse: (klass & UNICAST_RESPONSE) !== 0,
    });
    pos = next + 4;
  }

  const sections = ['answers', 'authorities', 'additionals'];
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < counts[s + 1]; i++) {
      const { name, next } = decodeName(buf, pos);
      const type = buf.readUInt16BE(next);
      const klass = buf.readUInt16BE(next + 2);
      const ttl = buf.readUInt32BE(next + 4);
      const rdlength = buf.readUInt16BE(next + 8);
      const rdataStart = next + 10;
      if (rdataStart + rdlength > buf.length) throw new Error('DNS rdata overruns buffer');
      message[sections[s]].push({
        name,
        type,
        class: klass & 0x7fff,
        cacheFlush: (klass & CACHE_FLUSH) !== 0,
        ttl,
        data: decodeRdata(type, buf, rdataStart, rdlength),
      });
      pos = rdataStart + rdlength;
    }
  }
  return message;
}

export const FLAG_RESPONSE = 0x8000;
export const FLAG_AUTHORITATIVE = 0x0400;
