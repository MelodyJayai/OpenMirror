// Minimal mDNS responder (RFC 6762): advertises services on 224.0.0.251:5353,
// answers PTR/SRV/TXT/A queries for the services it owns, sends unsolicited
// announcements on start and goodbye packets on stop.

import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import {
  TYPE, CLASS_IN, FLAG_RESPONSE, FLAG_AUTHORITATIVE,
  encodeMessage, decodeMessage,
} from './dns.js';

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const DEFAULT_TTL = 4500; // seconds, per RFC 6762 §10 for shared records
const HOST_TTL = 120;

/** Exclude IPv4 ranges that cannot represent a reachable LAN receiver. */
export function isUsableLanIPv4(address) {
  const octets = String(address).split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 0 || a === 127 || a >= 224) return false;
  // RFC 2544 benchmarking space is commonly assigned to VPN/agent adapters.
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

/** Enumerate non-internal IPv4 addresses, one per interface. */
export function localIPv4Addresses() {
  const result = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && isUsableLanIPv4(addr.address)) {
        result.push({ iface, address: addr.address });
      }
    }
  }
  return result;
}

/**
 * A service registration:
 * { name: 'OpenMirror', type: '_airplay._tcp.local', port: 7000, txt: {k:v}, host?: 'hostname.local' }
 */
export class MdnsResponder extends EventEmitter {
  #socket = null;
  #services = [];
  #hostname;
  #addresses;
  #started = false;

  constructor({ hostname, addresses } = {}) {
    super();
    const base = hostname ?? os.hostname().split('.')[0];
    this.#hostname = base.endsWith('.local') ? base : `${base}.local`;
    this.#addresses = addresses ?? null; // null = auto-detect at answer time
  }

  get hostname() {
    return this.#hostname;
  }

  addService(service) {
    const type = service.type.endsWith('.local') ? service.type : `${service.type}.local`;
    this.#services.push({
      ...service,
      type,
      fqdn: `${service.name}.${type}`,
      host: service.host ?? this.#hostname,
      txt: service.txt ?? {},
    });
    if (this.#started) this.#announce();
  }

  async start() {
    if (this.#started) return;
    this.#socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    await new Promise((resolve, reject) => {
      this.#socket.once('error', reject);
      this.#socket.bind(MDNS_PORT, () => {
        this.#socket.removeListener('error', reject);
        const addresses = this.#addressList();
        try {
          this.#socket.addMembership(MDNS_ADDRESS);
        } catch {
          // Membership on the default interface may fail on multi-homed hosts;
          // join per-interface below instead.
        }
        for (const address of addresses) {
          try {
            this.#socket.addMembership(MDNS_ADDRESS, address);
          } catch {
            // Interface may already be joined or not support multicast.
          }
        }
        this.#socket.setMulticastTTL(255);
        this.#socket.setMulticastLoopback(true);
        if (addresses.length) this.#socket.setMulticastInterface(addresses[0]);
        resolve();
      });
    });

    this.#socket.on('message', (msg, rinfo) => this.#onMessage(msg, rinfo));
    this.#socket.on('error', (err) => this.emit('error', err));
    this.#started = true;

    // RFC 6762 §8.3: announce at least twice, one second apart.
    this.#announce();
    this.#announceTimer = setTimeout(() => this.#announce(), 1000);
  }

  #announceTimer = null;

  async stop() {
    if (!this.#started) return;
    clearTimeout(this.#announceTimer);
    // Goodbye: re-announce all records with TTL 0 (RFC 6762 §10.1).
    this.#sendRecords(this.#allRecords(0));
    this.#started = false;
    await new Promise((resolve) => this.#socket.close(resolve));
    this.#socket = null;
  }

  #recordsForService(service, ttl = DEFAULT_TTL) {
    const records = [
      { name: service.type, type: TYPE.PTR, ttl, data: service.fqdn },
      {
        name: service.fqdn, type: TYPE.SRV, ttl, cacheFlush: true,
        data: { priority: 0, weight: 0, port: service.port, target: service.host },
      },
      { name: service.fqdn, type: TYPE.TXT, ttl, cacheFlush: true, data: service.txt },
      // Service type enumeration support (RFC 6763 §9).
      { name: '_services._dns-sd._udp.local', type: TYPE.PTR, ttl, data: service.type },
    ];
    return records;
  }

  #hostRecords(ttl = HOST_TTL) {
    const addrs = this.#addressList();
    return addrs.map((address) => ({
      name: this.#hostname, type: TYPE.A, ttl, cacheFlush: true, data: address,
    }));
  }

  #addressList() {
    const addresses = this.#addresses ?? localIPv4Addresses().map((item) => item.address);
    return [...new Set(addresses.filter(isUsableLanIPv4))];
  }

  #allRecords(ttl) {
    return [
      ...this.#services.flatMap((s) => this.#recordsForService(s, ttl === 0 ? 0 : DEFAULT_TTL)),
      ...this.#hostRecords(ttl === 0 ? 0 : HOST_TTL),
    ];
  }

  #announce() {
    if (this.#services.length === 0) return;
    this.#sendRecords(this.#allRecords());
  }

  #sendRecords(answers, destination = null) {
    if (answers.length === 0 || !this.#socket) return;
    const msg = encodeMessage({
      flags: FLAG_RESPONSE | FLAG_AUTHORITATIVE,
      answers,
    });
    const port = destination?.port ?? MDNS_PORT;
    const addr = destination?.address ?? MDNS_ADDRESS;
    this.#socket.send(msg, port, addr, (err) => {
      // Send failures (no multicast route, interface down) are non-fatal:
      // the responder keeps answering on whatever interfaces do work.
      if (err) this.emit('warning', err);
    });
  }

  #onMessage(msg, rinfo) {
    let message;
    try {
      message = decodeMessage(msg);
    } catch {
      return; // Ignore malformed packets — multicast networks are noisy.
    }
    if (message.flags & FLAG_RESPONSE) return; // Only handle queries.

    const answers = [];
    const additionals = [];
    let unicast = false;

    for (const q of message.questions) {
      if (q.class !== CLASS_IN && q.class !== 255) continue;
      if (q.unicastResponse) unicast = true;
      const qname = q.name.toLowerCase();

      for (const service of this.#services) {
        const wantsPtr = q.type === TYPE.PTR || q.type === TYPE.ANY;
        const wantsSrv = q.type === TYPE.SRV || q.type === TYPE.ANY;
        const wantsTxt = q.type === TYPE.TXT || q.type === TYPE.ANY;

        if (wantsPtr && qname === service.type.toLowerCase()) {
          answers.push(...this.#recordsForService(service).slice(0, 3));
          additionals.push(...this.#hostRecords());
        } else if (qname === service.fqdn.toLowerCase()) {
          if (wantsSrv) {
            answers.push(this.#recordsForService(service)[1]);
            additionals.push(...this.#hostRecords());
          }
          if (wantsTxt) answers.push(this.#recordsForService(service)[2]);
        } else if (wantsPtr && qname === '_services._dns-sd._udp.local') {
          answers.push(this.#recordsForService(service)[3]);
        }
      }

      if ((q.type === TYPE.A || q.type === TYPE.ANY) && qname === this.#hostname.toLowerCase()) {
        answers.push(...this.#hostRecords());
      }
    }

    if (answers.length === 0) return;
    // Deduplicate (a query can match through several paths).
    const seen = new Set();
    const dedupe = (records) => records.filter((r) => {
      const key = `${r.name}/${r.type}/${JSON.stringify(r.data)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const message2 = {
      // RFC 6762 §6: mDNS responses use ID 0 for multicast; echo ID for legacy unicast.
      id: unicast ? message.id : 0,
      flags: FLAG_RESPONSE | FLAG_AUTHORITATIVE,
      answers: dedupe(answers),
      additionals: dedupe(additionals),
    };
    const buf = encodeMessage(message2);
    const dest = unicast ? rinfo : null;
    this.#socket.send(buf, dest?.port ?? MDNS_PORT, dest?.address ?? MDNS_ADDRESS, (err) => {
      if (err) this.emit('warning', err);
    });
    this.emit('query', { questions: message.questions, from: rinfo, unicast });
  }
}
