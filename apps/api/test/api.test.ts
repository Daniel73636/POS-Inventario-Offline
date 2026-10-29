import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEMO_OWNER, DEMO_PAIRING_CODE, type SnapshotResponse } from '@pos/contracts';
import { createDatabase, migrate, seedDemo, type Database } from '@pos/db';
import { EventFactory, HybridLogicalClock } from '@pos/sync-engine';
import { buildApp } from '../src/app';

let db: Database;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createDatabase();
  await migrate(db);
  await seedDemo(db);
  app = await buildApp({ db, secret: 'test' });
}, 60000);

afterAll(async () => {
  await app.close();
  await db.close();
});

async function register(name: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/devices/register', payload: { pairingCode: DEMO_PAIRING_CODE, name, platform: 'web' } });
  expect(res.statusCode).toBe(201);
  return res.json() as { deviceId: string; deviceToken: string; tenantId: string; storeId: string };
}

describe('API de sincronización', () => {
  it('health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('rechaza códigos inválidos y peticiones sin credencial', async () => {
    const bad = await app.inject({ method: 'POST', url: '/v1/devices/register', payload: { pairingCode: 'NOPE-0000', name: 'x', platform: 'web' } });
    expect(bad.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/sync/pull?cursor=0' })).statusCode).toBe(401);
  });

  it('registro → snapshot → push idempotente → pull desde otro dispositivo', async () => {
    const a = await register('Caja 1');
    const b = await register('Caja 2');
    const auth = (t: string) => ({ authorization: `Bearer ${t}` });

    const snap = (await app.inject({ method: 'GET', url: '/v1/sync/snapshot', headers: auth(a.deviceToken) })).json() as SnapshotResponse;
    expect(snap.products).toHaveLength(30);
    expect(snap.products.every((p) => p.barcodes.length > 0)).toBe(true);
    const gaseosa = snap.products.find((p) => p.name.startsWith('Gaseosa'))!;
    const before = snap.stock.find((s) => s.productId === gaseosa.id)!.qty;

    const f = new EventFactory({ tenantId: a.tenantId, storeId: a.storeId, deviceId: a.deviceId }, new HybridLogicalClock(a.deviceId));
    const events = [
      f.create('CashSessionOpened', { sessionId: 'cs-1', userId: 'usr_ana', openingCents: 100000 }),
      f.create('SaleCompleted', {
        saleId: 'sale-1', localNumber: 1, cashSessionId: 'cs-1', userId: 'usr_ana', customerId: null,
        subtotalCents: 900000, discountCents: 0, taxCents: 143697, totalCents: 900000, changeCents: 100000,
        items: [{ productId: gaseosa.id, name: gaseosa.name, packId: null, qty: 2, baseQty: 2, unitPriceCents: 450000, unitCostCents: 310000, discountCents: 0, taxRateBp: 1900, taxCents: 143697, lineTotalCents: 900000 }],
        payments: [{ method: 'cash', amountCents: 900000 }],
      }),
    ];
    const push1 = (await app.inject({ method: 'POST', url: '/v1/sync/push', headers: auth(a.deviceToken), payload: { events } })).json();
    expect(push1.accepted).toHaveLength(2);
    const push2 = (await app.inject({ method: 'POST', url: '/v1/sync/push', headers: auth(a.deviceToken), payload: { events } })).json();
    expect(push2.accepted).toHaveLength(0);
    expect(push2.duplicates).toHaveLength(2);

    // B no puede subir eventos firmados como A.
    const forged = (await app.inject({ method: 'POST', url: '/v1/sync/push', headers: auth(b.deviceToken), payload: { events } })).json();
    expect(forged.rejected).toHaveLength(2);

    const pull = (await app.inject({ method: 'GET', url: `/v1/sync/pull?cursor=${snap.cursor}`, headers: auth(b.deviceToken) })).json();
    expect(pull.events.map((e: { type: string }) => e.type)).toEqual(['CashSessionOpened', 'SaleCompleted']);
    expect(pull.cursor).toBeGreaterThan(snap.cursor);

    const snap2 = (await app.inject({ method: 'GET', url: '/v1/sync/snapshot', headers: auth(b.deviceToken) })).json() as SnapshotResponse;
    expect(snap2.stock.find((s) => s.productId === gaseosa.id)!.qty).toBe(before - 2);
  });

  it('panel: login, edición de precio distribuida por pull, reportes y revocación', async () => {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: DEMO_OWNER.email, password: DEMO_OWNER.password } });
    expect(login.statusCode).toBe(200);
    const owner = { authorization: `Bearer ${login.json().token}` };
    const dev = await register('Caja 3');
    const snap = (await app.inject({ method: 'GET', url: '/v1/sync/snapshot', headers: { authorization: `Bearer ${dev.deviceToken}` } })).json() as SnapshotResponse;

    const products = (await app.inject({ method: 'GET', url: '/v1/products', headers: owner })).json();
    const p = products[0];
    const put = await app.inject({ method: 'PUT', url: `/v1/products/${p.id}`, headers: owner, payload: { ...p, priceCents: p.priceCents + 10000 } });
    expect(put.statusCode).toBe(200);
    const pull = (await app.inject({ method: 'GET', url: `/v1/sync/pull?cursor=${snap.cursor}`, headers: { authorization: `Bearer ${dev.deviceToken}` } })).json();
    expect(pull.events.some((e: { type: string; payload: { product?: { priceCents: number } } }) => e.type === 'ProductUpserted' && e.payload.product?.priceCents === p.priceCents + 10000)).toBe(true);

    const sales = (await app.inject({ method: 'GET', url: '/v1/reports/sales', headers: owner })).json();
    expect(sales.totals.count).toBeGreaterThan(0);
    const profit = (await app.inject({ method: 'GET', url: '/v1/reports/profit', headers: owner })).json();
    expect(profit.totals.revenueCents).toBeGreaterThan(0);
    const inv = (await app.inject({ method: 'GET', url: '/v1/reports/inventory', headers: owner })).json();
    expect(inv.items).toHaveLength(30);

    expect((await app.inject({ method: 'POST', url: `/v1/devices/${dev.deviceId}/revoke`, headers: owner })).statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/v1/sync/pull?cursor=0', headers: { authorization: `Bearer ${dev.deviceToken}` } });
    expect(after.statusCode).toBe(403);
  });
});
