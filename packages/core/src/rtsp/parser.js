// Incremental RTSP/HTTP message parser. AirPlay's control channel speaks
// RTSP/1.0 with HTTP-style requests mixed in (GET /info, POST /pair-setup),
// so the parser accepts both and emits complete messages as bytes stream in.

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export class RtspParser {
  #buffer = Buffer.alloc(0);
  #onMessage;

  constructor(onMessage) {
    this.#onMessage = onMessage;
  }

  /** Feed incoming bytes; invokes onMessage for each complete message. */
  push(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.#buffer.length > MAX_HEADER_BYTES) {
          throw new Error('RTSP header section too large');
        }
        return;
      }
      const head = this.#buffer.toString('latin1', 0, headerEnd);
      const lines = head.split('\r\n');
      const requestLine = lines[0];

      const headers = {};
      for (let i = 1; i < lines.length; i++) {
        const colon = lines[i].indexOf(':');
        if (colon === -1) continue;
        headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
      }

      const contentLength = parseInt(headers['content-length'] ?? '0', 10) || 0;
      if (contentLength > MAX_BODY_BYTES) throw new Error('RTSP body too large');
      const total = headerEnd + 4 + contentLength;
      if (this.#buffer.length < total) return;

      const body = this.#buffer.subarray(headerEnd + 4, total);
      this.#buffer = Buffer.from(this.#buffer.subarray(total));

      const message = parseRequestLine(requestLine);
      message.headers = headers;
      message.body = Buffer.from(body);
      this.#onMessage(message);
    }
  }
}

function parseRequestLine(line) {
  const parts = line.split(' ');
  if (parts[0].startsWith('RTSP/') || parts[0].startsWith('HTTP/')) {
    // Response: "RTSP/1.0 200 OK"
    return {
      kind: 'response',
      version: parts[0],
      status: parseInt(parts[1], 10),
      reason: parts.slice(2).join(' '),
    };
  }
  if (parts.length < 3) throw new Error(`Bad RTSP request line: ${line}`);
  return {
    kind: 'request',
    method: parts[0],
    uri: parts[1],
    version: parts[2],
  };
}

/** Serialize a response: { status, reason?, headers?, body? } */
export function encodeResponse(response, protocol = 'RTSP/1.0') {
  const status = response.status ?? 200;
  const reason = response.reason ?? statusText(status);
  const body = response.body ?? Buffer.alloc(0);
  const headers = { ...(response.headers ?? {}) };
  headers['Content-Length'] = String(body.length);
  headers['Server'] = headers['Server'] ?? 'AirTunes/220.68';

  let head = `${protocol} ${status} ${reason}\r\n`;
  for (const [key, value] of Object.entries(headers)) {
    head += `${key}: ${value}\r\n`;
  }
  head += '\r\n';
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}

function statusText(status) {
  return {
    200: 'OK',
    400: 'Bad Request',
    401: 'Unauthorized',
    404: 'Not Found',
    453: 'Not Enough Bandwidth',
    500: 'Internal Server Error',
  }[status] ?? 'Unknown';
}
