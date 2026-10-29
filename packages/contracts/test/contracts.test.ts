import { describe, expect, it } from 'vitest';
import { demoCatalog, ean13, isValidEan13, parseEvent, ProductSchema } from '../src';

describe('catálogo demo', () => {
  it('tiene 30 productos válidos con EAN-13 únicos', () => {
    const rows = demoCatalog(new Date('2026-10-29'));
    expect(rows).toHaveLength(30);
    const codes = rows.flatMap((r) => [...r.product.barcodes, ...r.product.packs.map((p) => p.barcode!)]);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(isValidEan13(c)).toBe(true);
    for (const r of rows) expect(() => ProductSchema.parse(r.product)).not.toThrow();
  });

  it('calcula el dígito de control', () => {
    expect(ean13('770123400001')).toHaveLength(13);
    expect(isValidEan13('7702004003508')).toBe(true);
  });
});

describe('eventos', () => {
  const base = {
    id: '0192f3a4-0000-7000-8000-000000000001',
    tenantId: 't',
    storeId: 's',
    deviceId: 'd',
    seq: 1,
    hlc: '001761720000000:00000:d',
    occurredAt: '2026-10-29T00:00:00.000Z',
  };
  it('valida por tipo', () => {
    expect(parseEvent({ ...base, type: 'CashSessionOpened', payload: { sessionId: 'x', userId: 'u', openingCents: 100 } }).ok).toBe(true);
    expect(parseEvent({ ...base, type: 'CashSessionOpened', payload: { sessionId: 'x', userId: 'u', openingCents: 1.5 } }).ok).toBe(false);
    expect(parseEvent({ ...base, type: 'Nope', payload: {} }).ok).toBe(false);
  });
});
