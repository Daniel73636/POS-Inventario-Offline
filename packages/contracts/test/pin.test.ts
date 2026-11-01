import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromBase64Url, hashPinPbkdf2, isLegacyPinHash, isValidPinFormat, toBase64Url, verifyPinHash } from '../src';

describe('hash de PIN (PBKDF2)', () => {
  it('verifica el PIN correcto y rechaza otros', async () => {
    const h = await hashPinPbkdf2('tnt_a', '1234', 1000);
    expect(h).toMatch(/^pbkdf2\$1000\$[\w-]+\$[\w-]+$/);
    expect(await verifyPinHash(h, 'tnt_a', '1234')).toBe(true);
    expect(await verifyPinHash(h, 'tnt_a', '1235')).toBe(false);
    expect(await verifyPinHash(h, 'tnt_b', '1234')).toBe(false);
  });

  it('usa sal aleatoria: dos hashes del mismo PIN difieren', async () => {
    const [a, b] = await Promise.all([hashPinPbkdf2('t', '0000', 1000), hashPinPbkdf2('t', '0000', 1000)]);
    expect(a).not.toBe(b);
  });

  it('acepta hashes antiguos sha256 para no bloquear cajas existentes', async () => {
    const legacy = createHash('sha256').update('tnt_a:9999').digest('hex');
    expect(isLegacyPinHash(legacy)).toBe(true);
    expect(await verifyPinHash(legacy, 'tnt_a', '9999')).toBe(true);
    expect(await verifyPinHash(legacy, 'tnt_a', '9998')).toBe(false);
  });

  it('rechaza formatos corruptos sin lanzar', async () => {
    expect(await verifyPinHash('pbkdf2$x$y$z', 't', '1')).toBe(false);
    expect(await verifyPinHash('pbkdf2$10$***$abc', 't', '1')).toBe(false);
    expect(await verifyPinHash('', 't', '1')).toBe(false);
  });

  it('base64url ida y vuelta', () => {
    for (const n of [0, 1, 2, 3, 16, 31, 32]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });

  it('valida formato de PIN', () => {
    expect(isValidPinFormat('1234')).toBe(true);
    expect(isValidPinFormat('123')).toBe(false);
    expect(isValidPinFormat('12a4')).toBe(false);
  });
});
