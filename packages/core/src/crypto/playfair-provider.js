import { readFileSync } from 'node:fs';
import {
  FP_REPLY1_LENGTH,
  FP_REPLY2_LENGTH,
  FP_SETUP2_LENGTH,
  FP_SETUP2_REPLY_HEADER,
} from './fairplay.js';

const KEY_MESSAGE_BYTES = FP_SETUP2_LENGTH;
const ENCRYPTED_KEY_BYTES = 72;
const CLEAR_KEY_BYTES = 16;
const IO_BYTES = KEY_MESSAGE_BYTES + ENCRYPTED_KEY_BYTES + CLEAR_KEY_BYTES;

// Four 142-byte SAPv2.5 setup replies from the GPL PlayFair implementation
// vendored under packages/core/vendor/playfair. Kept compact here so the
// runtime provider needs only this module and the platform-neutral WASM asset.
const PHASE1_REPLIES = Buffer.from(
  'RlBMWQMBAgAAAACCAgAPnz+eCiUh298xKrK/sp6NIytjdqjIGHAdIq6T2Cc3/q+dtP30HC26nR9Jyqq/ZZGsH3vG9+BmPSGv4BVllT6rgfQYzu0JWtt8PQ4lSQmnmDHUnDmClzQ0+stCxjoc2RGm/pQaim1KdDtGw6dknkTHiVXknYFVAJVJxOL3o/bVukZQTFkDAQIAAAAAggIBzzKiVxSyUk+KoK168WTje89EJOIABH78CtZ6/Nld7RwnMLtZG5Yu1jqcTe2Iuo/HjeZNkcz9XHtW2ojjH1zOr8dDGZWgFmWlThk50luU22S55F2NBj4eavB+llYWKw76QEJ16lpE2Vkccla5++ZROJi4AidyGYhXFlCUKtlGaIpGUExZAwECAAAAAIICAsFpo1Lu7TWxjN2cWNZPFsFRmonrUxe9DUM2zWj2OP+dAWpbUrf6khaytlSCx4REEYEhosf+2D23EZ6RgqrX0YxwY+KkV1VZEK+eDvx2NH0WQEOAf1ge5PvkLKne3BtesqOqPS7NWefu5ws2KfIq/RYdh3NT3bma3I4HAG5W+FDORlBMWQMBAgAAAACCAgOQAeFyfg9X+fWIDbEEpiV6I/XP/xq74ekwRSUa+5frn8ABHr4POoHfW2kddqyy96XHCOPTKPVrs5295fKcihf0gUh+OuhjxngyVCLm944WbRiqf9Y2JYvOKHJvZh9ziJPORDEeS+bAU1GT5e9y6GhiM3KcIn2CDJmURdiSRsjDWQ==',
  'base64',
);

let compiledModule;

function playFairModule() {
  compiledModule ??= new WebAssembly.Module(
    readFileSync(new URL('./playfair.wasm', import.meta.url)),
  );
  return compiledModule;
}

/**
 * Real SAPv2.5 PlayFair provider backed by a sandboxed, import-free WebAssembly
 * build of the established GPL implementation used by UxPlay/RPiPlay.
 */
export function createPlayFairProvider() {
  const instance = new WebAssembly.Instance(playFairModule());
  const { memory, playfair_io_ptr: ioPtr, playfair_decrypt_io: decryptIo } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof ioPtr !== 'function' || typeof decryptIo !== 'function') {
    throw new Error('PlayFair WebAssembly module has an invalid export surface');
  }
  const offset = ioPtr();
  if (!Number.isInteger(offset) || offset < 0 || offset + IO_BYTES > memory.buffer.byteLength) {
    throw new Error('PlayFair WebAssembly scratch buffer is outside linear memory');
  }

  return {
    phase1(mode) {
      if (!Number.isInteger(mode) || mode < 0 || mode > 3) {
        throw new Error(`PlayFair mode must be 0..3, got ${mode}`);
      }
      const start = mode * FP_REPLY1_LENGTH;
      return Buffer.from(PHASE1_REPLIES.subarray(start, start + FP_REPLY1_LENGTH));
    },

    phase2(request) {
      if (!Buffer.isBuffer(request) || request.length !== KEY_MESSAGE_BYTES) {
        throw new Error(`PlayFair key message must be ${KEY_MESSAGE_BYTES} bytes`);
      }
      const reply = Buffer.alloc(FP_REPLY2_LENGTH);
      FP_SETUP2_REPLY_HEADER.copy(reply);
      request.subarray(request.length - 20).copy(reply, FP_SETUP2_REPLY_HEADER.length);
      return { reply };
    },

    decryptKey(encryptedKey, fairPlaySession) {
      if (!Buffer.isBuffer(encryptedKey) || encryptedKey.length !== ENCRYPTED_KEY_BYTES) {
        throw new Error(`PlayFair encrypted media key must be ${ENCRYPTED_KEY_BYTES} bytes`);
      }
      const keyMessage = fairPlaySession?.keyMessage;
      if (!Buffer.isBuffer(keyMessage) || keyMessage.length !== KEY_MESSAGE_BYTES) {
        throw new Error('PlayFair phase 2 must complete before media-key decryption');
      }

      const view = new Uint8Array(memory.buffer, offset, IO_BYTES);
      view.fill(0);
      view.set(keyMessage, 0);
      view.set(encryptedKey, KEY_MESSAGE_BYTES);
      decryptIo();
      return Buffer.from(view.subarray(KEY_MESSAGE_BYTES + ENCRYPTED_KEY_BYTES, IO_BYTES));
    },
  };
}

export const PLAYFAIR_ENCRYPTED_KEY_BYTES = ENCRYPTED_KEY_BYTES;
