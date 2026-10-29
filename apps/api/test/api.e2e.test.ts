import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DEMO_OWNER, DEMO_PAIRING_CODE, type PosEvent, type RegisterDeviceResponse, type SnapshotResponse } from '@pos/contracts';
import { addToCart, emptyCart, finalizeSale } from '@pos/domain-pos';
import { EventFactory, HybridLogicalClock, MemorySyncStore, stateFromSnapshot, SyncClient, uuidv7, type FetchLike } from '@pos/sync-engine';
import { createApp } from '../src/app.factory';
import { loadConfig } from '../src/config';

process.env.NODE_ENV = 'test';
let app: NestFastifyApplication;

beforeAll(async () => {
  const config = { ...loadConfig({ PGLITE_DIR: 'memory', JWT_SECRET: 'test' }), pgliteDir: null };
  ({ app } = await createApp(config));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
});

async function call<T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

/** fetch → app.inject, para probar el SyncClient real contra la API real. */
const injectFetch: FetchLike = async (url, init) => {
  const u = new URL(url);
  const res = await app.inject({
    method: (init?.method ?? 'GET') as 'GET',
    url: u.pathname + u.search,
    payload: init?.body,
    headers: init?.headers,
  });
  return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body), text: async () => res.body };
};

async function register(name: string): Promise<RegisterDeviceResponse> {
  const r = await call<RegisterDeviceResponse>('POST', '/v1/devices/register', { pairingCode: DEMO_PAIRING_CODE, name, platform: 'web' });
  expect(r.status).toBe(201);
  return r.body;
}

describe('API de sincronización', () => {
  it('health', async () => {
    const r = await call('GET', '/health');
    expect(r.body).toMatchObject({ ok: true, db: 'pglite' });
  });

  it('rechaza códigos inválidos y peticiones sin credencial', async () => {
    expect((await call('POST', '/v1/devices/register', { pairingCode: 'XXXX-0000', name: 'x', platform: 'web' })).status).toBe(401);
    expect((await call('GET', '/v1/sync/snapshot')).status).toBe(401);
    expect((await call('GET', '/v1/reports/dashboard')).status).toBe(401);
  });

  it('flujo completo: registro, snapshot, venta offline, push idempotente, pull, panel y revocación', async () => {
    const dev = await register('Caja 1');
    const snap = (await call<SnapshotResponse>('GET', '/v1/sync/snapshot', undefined, dev.deviceToken)).body;
    expect(snap.products).toHaveLength(30);
    expect(snap.users.length).toBeGreaterThanOrEqual(3);
    expect(snap.cursor).toBeGreaterThan(0);

    // Venta construida con domain-pos, como en la caja.
    const state = stateFromSnapshot(snap);
    const gaseosa = Object.values(state.products).find((p) => p.name.startsWith('Gaseosa'))!;
    const stockBefore = state.stock[gaseosa.id];
    let cart = addToCart(emptyCart(), gaseosa, 2);
    cart = addToCart(cart, gaseosa, 1, { packId: 'six' });
    const fin = finalizeSale(cart, [{ method: 'cash', amountCents: 5000000 }]);
    if (!fin.ok) throw new Error(fin.errors.join());
    const factory = new EventFactory({ tenantId: dev.tenantId, storeId: dev.storeId, deviceId: dev.deviceId }, new HybridLogicalClock(dev.deviceId));
    const open = factory.create('CashSessionOpened', { sessionId: 'cs-e2e', userId: 'usr_ana', openingCents: 10000000 });
    const sale = factory.create('SaleCompleted', { saleId: uuidv7(), localNumber: 1, cashSessionId: 'cs-e2e', userId: 'usr_ana', ...fin.sale });

    const push = await call('POST', '/v1/sync/push', { events: [open, sale] }, dev.deviceToken);
    expect(push.status).toBe(200);
    expect(push.body.accepted).toEqual([open.id, sale.id]);
    const again = await call('POST', '/v1/sync/push', { events: [open, sale] }, dev.deviceToken);
    expect(again.body.accepted).toEqual([]);
    expect(again.body.duplicates).toEqual([open.id, sale.id]);

    // Otro dispositivo recibe la venta por pull y su stock baja 2 + 6 unidades.
    const dev2 = await register('Celular bodega');
    const store2 = new MemorySyncStore(stateFromSnapshot(snap));
    store2.cursor = snap.cursor;
    const client2 = new SyncClient({ baseUrl: 'http://api', deviceId: dev2.deviceId, getToken: () => dev2.deviceToken, store: store2, fetch: injectFetch });
    const st = await client2.syncNow();
    expect(st.state).toBe('synced');
    expect(store2.state.stock[gaseosa.id]).toBe(stockBefore - 8);

    // Panel: login del dueño, cambio de precio → llega a las cajas.
    const login = await call('POST', '/v1/auth/login', { email: DEMO_OWNER.email, password: DEMO_OWNER.password });
    expect(login.status).toBe(200);
    const owner = login.body.token as string;
    const dash = await call('GET', '/v1/reports/dashboard', undefined, owner);
    expect(dash.body.sales).toBeGreaterThanOrEqual(1);
    expect(dash.body.totalCents).toBeGreaterThanOrEqual(fin.sale.totalCents);

    const upd = await call('PUT', `/v1/products/${gaseosa.id}`, { priceCents: 480000 }, owner);
    expect(upd.status).toBe(200);
    await client2.syncNow();
    expect(store2.state.products[gaseosa.id].priceCents).toBe(480000);

    const created = await call('POST', '/v1/products', { name: 'Producto nuevo', priceCents: 100000, taxCode: 'IVA19', barcodes: ['7709999999995'] }, owner);
    expect(created.status).toBe(201);
    const dupCode = await call('POST', '/v1/products', { name: 'Duplicado', priceCents: 100, taxCode: 'IVA19', barcodes: ['7709999999995'] }, owner);
    expect(dupCode.status).toBe(409);

    const inv = await call('GET', '/v1/reports/inventory', undefined, owner);
    expect(inv.body.items.length).toBe(31);
    const profit = await call('GET', '/v1/reports/profit', undefined, owner);
    expect(profit.body.profitCents).toBeGreaterThan(0);

    // Rango fiscal: no se solapan entre dispositivos.
    const r1 = await call('POST', '/v1/fiscal/ranges', { size: 100 }, dev.deviceToken);
    const r2 = await call('POST', '/v1/fiscal/ranges', { size: 100 }, dev2.deviceToken);
    expect(r2.body.from).toBe(r1.body.to + 1);

    // Revocación remota: el dispositivo deja de sincronizar.
    expect((await call('POST', `/v1/devices/${dev2.deviceId}/revoke`, {}, owner)).status).toBe(200);
    expect((await client2.syncNow()).state).toBe('revoked');
  });

  it('rechaza eventos de otro dispositivo o mal formados sin romper el lote', async () => {
    const dev = await register('Caja 3');
    const other = new EventFactory({ tenantId: dev.tenantId, storeId: dev.storeId, deviceId: 'dev_ajeno' }, new HybridLogicalClock('x'));
    const mine = new EventFactory({ tenantId: dev.tenantId, storeId: dev.storeId, deviceId: dev.deviceId }, new HybridLogicalClock('y'));
    const good: PosEvent = mine.create('CashSessionOpened', { sessionId: 'cs-3', userId: 'usr_ana', openingCents: 0 });
    const r = await call('POST', '/v1/sync/push', { events: [other.create('CashSessionOpened', { sessionId: 'z', userId: 'u', openingCents: 0 }), { id: 'basura' }, good] }, dev.deviceToken);
    expect(r.body.accepted).toEqual([good.id]);
    expect(r.body.rejected).toHaveLength(2);
  });
});
