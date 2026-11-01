import { pinHashInput } from './catalog';

/**
 * Hash de PIN verificable sin conexión en la caja y en el servidor.
 * Formato: `pbkdf2$<iteraciones>$<sal-b64url>$<hash-b64url>` (PBKDF2-SHA256, 32 bytes).
 * Los hashes antiguos (sha256 hex de `${tenantId}:${pin}`) se siguen aceptando.
 */
export const PIN_PBKDF2_ITERATIONS = 120_000;
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

interface SubtleLike {
  importKey(format: 'raw', key: Uint8Array, alg: string, extractable: boolean, usages: string[]): Promise<unknown>;
  deriveBits(alg: { name: string; hash: string; salt: Uint8Array; iterations: number }, key: unknown, length: number): Promise<ArrayBuffer>;
  digest(alg: string, data: Uint8Array): Promise<ArrayBuffer>;
}
interface CryptoLike {
  subtle?: SubtleLike;
  getRandomValues(bytes: Uint8Array): Uint8Array;
}

function webCrypto(): CryptoLike & { subtle: SubtleLike } {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c?.subtle) throw new Error('WebCrypto no disponible: no se puede validar el PIN');
  return c as CryptoLike & { subtle: SubtleLike };
}

declare const TextEncoder: { new (): { encode(text: string): Uint8Array } };

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('base64url inválido');
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function derive(input: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const { subtle } = webCrypto();
  const key = await subtle.importKey('raw', utf8(input), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

export async function hashPinPbkdf2(tenantId: string, pin: string, iterations = PIN_PBKDF2_ITERATIONS): Promise<string> {
  const salt = webCrypto().getRandomValues(new Uint8Array(16));
  const hash = await derive(pinHashInput(tenantId, pin), salt, iterations);
  return `pbkdf2$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export function isLegacyPinHash(stored: string): boolean {
  return /^[0-9a-f]{64}$/.test(stored);
}

export async function verifyPinHash(stored: string, tenantId: string, pin: string): Promise<boolean> {
  if (isLegacyPinHash(stored)) {
    const digest = await webCrypto().subtle.digest('SHA-256', utf8(pinHashInput(tenantId, pin)));
    return constantTimeEqual(utf8(hex(digest)), utf8(stored));
  }
  const [algo, iter, salt, hash] = stored.split('$');
  const iterations = Number(iter);
  if (algo !== 'pbkdf2' || !Number.isInteger(iterations) || iterations < 1 || !salt || !hash) return false;
  try {
    const candidate = await derive(pinHashInput(tenantId, pin), fromBase64Url(salt), iterations);
    return constantTimeEqual(candidate, fromBase64Url(hash));
  } catch {
    return false;
  }
}
