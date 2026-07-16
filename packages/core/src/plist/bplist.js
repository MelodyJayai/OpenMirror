// Binary property list (bplist00) encoder/decoder — the payload format used
// throughout AirPlay's RTSP control channel. Supports the object types AirPlay
// actually uses: null/bool, int, real, date, data, ascii/unicode string,
// array, dict. Reference: Apple CFBinaryPList.c (public source drop).

const MAGIC = 'bplist00';

// ---------------------------------------------------------------- decoding

export function decodeBplist(buf) {
  if (buf.length < 40 || buf.toString('latin1', 0, 8) !== MAGIC) {
    throw new Error('Not a bplist00 buffer');
  }
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer[6];
  const objectRefSize = trailer[7];
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableStart = Number(trailer.readBigUInt64BE(24));

  const readUIntAt = (pos, size) => {
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + buf[pos + i];
    return value;
  };

  const offsets = [];
  for (let i = 0; i < numObjects; i++) {
    offsets.push(readUIntAt(offsetTableStart + i * offsetSize, offsetSize));
  }

  const parseAt = (index, depth = 0) => {
    if (depth > 64) throw new Error('bplist nesting too deep');
    if (index >= offsets.length) throw new Error('bplist object ref out of range');
    let pos = offsets[index];
    const marker = buf[pos];
    const upper = marker >> 4;
    let lower = marker & 0x0f;
    pos += 1;

    const readLength = () => {
      if (lower !== 0x0f) return lower;
      // Length follows as an int object.
      const intMarker = buf[pos];
      if (intMarker >> 4 !== 1) throw new Error('bplist bad length int');
      const size = 1 << (intMarker & 0x0f);
      pos += 1;
      const len = readUIntAt(pos, size);
      pos += size;
      return len;
    };

    switch (upper) {
      case 0x0: // null / bool / fill
        if (marker === 0x00) return null;
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        throw new Error(`bplist unknown simple 0x${marker.toString(16)}`);
      case 0x1: { // int, 2^lower bytes big-endian
        const size = 1 << lower;
        if (size === 8) {
          const big = buf.readBigInt64BE(pos);
          const num = Number(big);
          return BigInt(num) === big ? num : big;
        }
        if (size === 16) {
          const hi = buf.readBigUInt64BE(pos);
          const lo = buf.readBigUInt64BE(pos + 8);
          const big = (hi << 64n) | lo;
          const num = Number(big);
          return BigInt(num) === big ? num : big;
        }
        return readUIntAt(pos, size);
      }
      case 0x2: // real
        if (lower === 2) return buf.readFloatBE(pos);
        if (lower === 3) return buf.readDoubleBE(pos);
        throw new Error('bplist unsupported real size');
      case 0x3: { // date: seconds since 2001-01-01 as float64
        const seconds = buf.readDoubleBE(pos);
        return new Date(978307200000 + seconds * 1000);
      }
      case 0x4: { // data
        const len = readLength();
        return Buffer.from(buf.subarray(pos, pos + len));
      }
      case 0x5: { // ascii string
        const len = readLength();
        return buf.toString('latin1', pos, pos + len);
      }
      case 0x6: { // utf16-be string
        const len = readLength();
        const bytes = Buffer.from(buf.subarray(pos, pos + len * 2));
        bytes.swap16();
        return bytes.toString('utf16le');
      }
      case 0x8: { // uid (used in keyed archives; surface as number)
        const size = lower + 1;
        return readUIntAt(pos, size);
      }
      case 0xa: { // array
        const count = readLength();
        const arr = [];
        for (let i = 0; i < count; i++) {
          arr.push(parseAt(readUIntAt(pos + i * objectRefSize, objectRefSize), depth + 1));
        }
        return arr;
      }
      case 0xd: { // dict
        const count = readLength();
        const obj = {};
        for (let i = 0; i < count; i++) {
          const keyRef = readUIntAt(pos + i * objectRefSize, objectRefSize);
          const valRef = readUIntAt(pos + (count + i) * objectRefSize, objectRefSize);
          const key = parseAt(keyRef, depth + 1);
          obj[String(key)] = parseAt(valRef, depth + 1);
        }
        return obj;
      }
      default:
        throw new Error(`bplist unsupported marker 0x${marker.toString(16)}`);
    }
  };

  return parseAt(topObject);
}

// ---------------------------------------------------------------- encoding

export function encodeBplist(root) {
  const objects = [];
  // Child refs are kept in a side-table keyed by object index.
  const meta = new Map();
  const flatten = (value) => {
    const index = objects.length;
    objects.push(value);
    if (Array.isArray(value)) {
      meta.set(index, value.map(flatten));
    } else if (isPlainDict(value)) {
      const keys = Object.keys(value);
      const refs = keys.map((k) => flatten(k));
      refs.push(...keys.map((k) => flatten(value[k])));
      meta.set(index, refs);
    }
    return index;
  };
  flatten(root);

  const objectRefSize = byteSizeFor(objects.length - 1);
  const chunks = [Buffer.from(MAGIC, 'latin1')];
  const offsets = [];
  let position = 8;

  const push = (b) => {
    chunks.push(b);
    position += b.length;
  };

  const marker = (upper, lengthOrLower) => {
    if (lengthOrLower < 15) return Buffer.from([(upper << 4) | lengthOrLower]);
    return Buffer.concat([Buffer.from([(upper << 4) | 0x0f]), encodeIntObject(lengthOrLower)]);
  };

  const writeRefs = (refs) => {
    const b = Buffer.alloc(refs.length * objectRefSize);
    refs.forEach((ref, i) => b.writeUIntBE(ref, i * objectRefSize, objectRefSize));
    push(b);
  };

  objects.forEach((value, index) => {
    offsets.push(position);
    if (value === null || value === undefined) {
      push(Buffer.from([0x00]));
    } else if (typeof value === 'boolean') {
      push(Buffer.from([value ? 0x09 : 0x08]));
    } else if (typeof value === 'number' && Number.isInteger(value)) {
      push(encodeIntObject(value));
    } else if (typeof value === 'bigint') {
      const b = Buffer.alloc(9);
      b[0] = 0x13;
      b.writeBigInt64BE(value, 1);
      push(b);
    } else if (typeof value === 'number') {
      const b = Buffer.alloc(9);
      b[0] = 0x23;
      b.writeDoubleBE(value, 1);
      push(b);
    } else if (value instanceof Date) {
      const b = Buffer.alloc(9);
      b[0] = 0x33;
      b.writeDoubleBE((value.getTime() - 978307200000) / 1000, 1);
      push(b);
    } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
      push(marker(0x4, data.length));
      push(data);
    } else if (typeof value === 'string') {
      if (/^[\x00-\x7f]*$/.test(value)) {
        const data = Buffer.from(value, 'latin1');
        push(marker(0x5, value.length));
        push(data);
      } else {
        const data = Buffer.from(value, 'utf16le').swap16();
        push(marker(0x6, value.length));
        push(data);
      }
    } else if (Array.isArray(value)) {
      const refs = meta.get(index);
      push(marker(0xa, refs.length));
      writeRefs(refs);
    } else if (isPlainDict(value)) {
      const refs = meta.get(index);
      push(marker(0xd, refs.length / 2));
      writeRefs(refs);
    } else {
      throw new Error(`bplist cannot encode value of type ${typeof value}`);
    }
  });

  const offsetSize = byteSizeFor(position);
  const offsetTable = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((off, i) => offsetTable.writeUIntBE(off, i * offsetSize, offsetSize));

  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = objectRefSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16); // top object index
  trailer.writeBigUInt64BE(BigInt(position), 24);

  return Buffer.concat([...chunks, offsetTable, trailer]);
}

function isPlainDict(v) {
  return typeof v === 'object' && v !== null &&
    !Array.isArray(v) && !Buffer.isBuffer(v) &&
    !(v instanceof Uint8Array) && !(v instanceof Date);
}

function byteSizeFor(maxValue) {
  if (maxValue < 0x100) return 1;
  if (maxValue < 0x10000) return 2;
  if (maxValue < 0x100000000) return 4;
  return 8;
}

function encodeIntObject(n) {
  if (n < 0) {
    const b = Buffer.alloc(9);
    b[0] = 0x13;
    b.writeBigInt64BE(BigInt(n), 1);
    return b;
  }
  if (n < 0x100) return Buffer.from([0x10, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = 0x11;
    b.writeUInt16BE(n, 1);
    return b;
  }
  if (n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = 0x12;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0x13;
  b.writeBigInt64BE(BigInt(n), 1);
  return b;
}
