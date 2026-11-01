import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { hashPinPbkdf2 } from '@pos/contracts';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** PBKDF2 con sal por usuario (ver `@pos/contracts` pin.ts). Las cajas lo validan sin conexión. */
export function hashPin(tenantId: string, pin: string): Promise<string> {
  return hashPinPbkdf2(tenantId, pin);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && timingSafeEqual(candidate, expected);
}

/** Token de dispositivo de larga vida; en la base sólo se guarda su hash. */
export function newDeviceToken(): string {
  return `pos_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

/** Código de emparejamiento legible (sin 0/O/1/I), ~40 bits: `XXXX-XXXX`. */
export function newPairingCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}
