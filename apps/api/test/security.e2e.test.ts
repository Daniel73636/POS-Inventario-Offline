import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_OWNER, DEMO_PAIRING_CODE, DEMO_TENANT, verifyPinHash, type PosEvent, type RegisterDeviceResponse, type SnapshotResponse } from '@pos/contracts';
import { emitServerEvents, hashPassword, serverDeviceId, verifyAuditChain } from '@pos/db';
import { addToCart, applyDiscount, emptyCart, finalizeSale } from '@pos/domain-pos';
import { EventFactory, HybridLogicalClock, stateFromSnapshot, uuidv7 } from '@pos/sync-engine';
import { ConfigError, loadConfig } from '../src/config';
import { FixedWindowLimiter } from '../src/common/rate-limit';
import { startApi, type TestApi } from './helpers';

const B = { tenant: 'tnt_b', store: 'str_b', owner: { email: 'duena@tienda-b.co', password: 'clave-b-123' }, code: 'TIEN-DABB' };

let api: TestApi;

async function register(code: string, name: string, a: TestApi = api) {
  return a.call<RegisterDeviceResponse>('POST', '/v1/devices/register', { pairingCode: code, name, platform: 'web' });
}

async function ownerToken(email: string, password: string, a: TestApi = api): Promise<string> {
  const r = await a.call('POST', '/v1/auth/login', { email, password });
  expect(r.status).toBe(200);
  return r.body.token as string;
}

function factoryFor(dev: RegisterDeviceResponse, ctx: Partial<{ tenantId: string; storeId: string }> = {}) {
  return new EventFactory({ tenantId: ctx.tenantId ?? dev.tenantId, storeId: ctx.storeId ?? dev.storeId, deviceId: dev.deviceId }, new HybridLogicalClock(dev.deviceId));
}

/** Segunda empresa en la misma base, con un producto que reutiliza el id `prd_001` del tenant demo. */
async function createTenantB(a: TestApi) {
  await a.db.tx(async (q) => {
    await q.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [B.tenant, 'Tienda B']);
    await q.query('INSERT INTO stores (id, tenant_id, name) VALUES ($1, $2, $3)', [B.store, B.tenant, 'Sede B']);
    await q.query('INSERT INTO owners (id, tenant_id, email, name, password_hash) VALUES ($1,$2,$3,$4,$5)', ['own_b', B.tenant, B.owner.email, 'Dueña B', hashPassword(B.owner.password)]);
    await q.query(`INSERT INTO devices (id, tenant_id, store_id, name, platform) VALUES ($1,$2,$3,'Servidor','server')`, [serverDeviceId(B.tenant), B.tenant, B.store]);
    await q.query(`INSERT INTO pairing_codes (code, tenant_id, store_id, uses_left, expires_at) VALUES ($1,$2,$3,5, now() + interval '1 hour')`, [B.code, B.tenant, B.store]);
  });
  await emitServerEvents(a.db, B.tenant, [
    { type: 'ProductUpserted', payload: { product: { id: 'prd_001', name: 'Producto propio de B', sku: null, category: 'B', brand: null, unit: 'unit', taxCode: 'IVA19', taxRateBp: 1900, taxIncluded: true, priceCents: 1000, costAvgCents: 0, minStock: null, active: true, tracksLots: false, barcodes: ['7700000000017'], prices: [], packs: [], color: null, quick: false } } },
  ]);
}

beforeAll(async () => {
  api = await startApi();
  await createTenantB(api);
});

afterAll(async () => {
  await api?.app.close();
});

describe('aislamiento entre empresas (tenant) y dispositivos', () => {
  it('un dispositivo de B no puede modificar ventas, turnos, productos, clientes ni stock de A', async () => {
    // Tenant A: venta y turno abierto desde una caja demo.
    const devA = (await register(DEMO_PAIRING_CODE, 'Caja A')).body;
    const snapA = (await api.call<SnapshotResponse>('GET', '/v1/sync/snapshot', undefined, devA.deviceToken)).body;
    const gaseosa = snapA.products.find((p) => p.id === 'prd_001')!;
    const fin = finalizeSale(addToCart(emptyCart(), stateFromSnapshot(snapA).products[gaseosa.id], 1), [{ method: 'cash', amountCents: gaseosa.priceCents }]);
    if (!fin.ok) throw new Error(fin.errors.join());
    const fa = factoryFor(devA);
    const saleId = uuidv7();
    const sessionId = `cs-a-${uuidv7()}`;
    const pushA = await api.call('POST', '/v1/sync/push', {
      events: [
        fa.create('CashSessionOpened', { sessionId, userId: 'usr_ana', openingCents: 0 }),
        fa.create('SaleCompleted', { saleId, localNumber: 1, cashSessionId: sessionId, userId: 'usr_ana', ...fin.sale }),
      ],
    }, devA.deviceToken);
    expect(pushA.body.accepted).toHaveLength(2);
    const [stockBefore] = await api.db.query<{ qty: number }>('SELECT COALESCE(SUM(qty),0) AS qty FROM stock_movements WHERE tenant_id = $1 AND product_id = $2', [DEMO_TENANT.id, 'prd_001']);

    // Tenant B intenta tocar los ids de A con eventos válidos para su propia credencial.
    const devB = (await register(B.code, 'Caja B')).body;
    expect(devB.tenantId).toBe(B.tenant);
    const fb = factoryFor(devB);
    const hostile: PosEvent[] = [
      fb.create('SaleVoided', { saleId, reason: 'ataque', userId: 'x', authorizedBy: 'x' }),
      fb.create('CashSessionClosed', { sessionId, userId: 'x', countedCents: 0, expectedCents: 999, differenceCents: -999 }),
      fb.create('ProductUpserted', { product: { ...gaseosa, name: 'HACKEADO', priceCents: 1 } }),
      fb.create('CustomerUpserted', { customer: { id: 'cus_rosa', name: 'HACKEADO', docId: null, phone: null, priceListId: null, creditLimitCents: null, active: true } }),
      fb.create('StockAdjusted', { productId: 'prd_001', qty: -500, reason: 'damage', userId: 'x' }),
    ];
    const pushB = await api.call('POST', '/v1/sync/push', { events: hostile }, devB.deviceToken);
    expect(pushB.status).toBe(200);
    expect(pushB.body.rejected).toEqual([]);

    const [saleA] = await api.db.query<{ status: string }>('SELECT status FROM sales WHERE tenant_id = $1 AND id = $2', [DEMO_TENANT.id, saleId]);
    expect(saleA.status).toBe('completed');
    const [sessA] = await api.db.query<{ closed_at: string | null }>('SELECT closed_at FROM cash_sessions WHERE tenant_id = $1 AND id = $2', [DEMO_TENANT.id, sessionId]);
    expect(sessA.closed_at).toBeNull();
    const [prodA] = await api.db.query<{ name: string; price_cents: number }>('SELECT name, price_cents FROM products WHERE tenant_id = $1 AND id = $2', [DEMO_TENANT.id, 'prd_001']);
    expect(prodA.name).toBe(gaseosa.name);
    expect(Number(prodA.price_cents)).toBe(gaseosa.priceCents);
    const [cusA] = await api.db.query<{ name: string }>('SELECT name FROM customers WHERE tenant_id = $1 AND id = $2', [DEMO_TENANT.id, 'cus_rosa']);
    expect(cusA.name).toBe('Tienda Doña Rosa');
    const [stockAfter] = await api.db.query<{ qty: number }>('SELECT COALESCE(SUM(qty),0) AS qty FROM stock_movements WHERE tenant_id = $1 AND product_id = $2', [DEMO_TENANT.id, 'prd_001']);
    expect(Number(stockAfter.qty)).toBe(Number(stockBefore.qty));

    // Los cambios sí quedan, pero sólo dentro de B.
    const [prodB] = await api.db.query<{ name: string }>('SELECT name FROM products WHERE tenant_id = $1 AND id = $2', [B.tenant, 'prd_001']);
    expect(prodB.name).toBe('HACKEADO');

    // Panel de A no ve nada de B.
    const ownerA = await ownerToken(DEMO_OWNER.email, DEMO_OWNER.password);
    const detail = await api.call('GET', '/v1/products/prd_001', undefined, ownerA);
    expect(detail.body.name).toBe(gaseosa.name);
    expect(detail.body.stock).toBe(Number(stockAfter.qty));
    const alertsA = await api.call<Array<{ message: string }>>('GET', '/v1/alerts?all=true', undefined, ownerA);
    expect(alertsA.body.some((a) => a.message.includes('ataque'))).toBe(false);
  });

  it('rechaza eventos firmados con el tenant o la tienda de otra empresa', async () => {
    const devB = (await register(B.code, 'Caja B2')).body;
    const spoofTenant = factoryFor(devB, { tenantId: DEMO_TENANT.id }).create('CashSessionOpened', { sessionId: 'z', userId: 'u', openingCents: 0 });
    const spoofStore = factoryFor(devB, { storeId: 'str_principal' }).create('CashSessionOpened', { sessionId: 'z2', userId: 'u', openingCents: 0 });
    const r = await api.call('POST', '/v1/sync/push', { events: [spoofTenant, spoofStore] }, devB.deviceToken);
    expect(r.body.accepted).toEqual([]);
    expect(r.body.rejected).toHaveLength(2);
  });

  it('pull y snapshot sólo devuelven datos del tenant de la credencial', async () => {
    const devB = (await register(B.code, 'Caja B3')).body;
    const pull = await api.call<{ events: PosEvent[] }>('GET', '/v1/sync/pull?cursor=0&limit=500', undefined, devB.deviceToken);
    expect(pull.body.events.length).toBeGreaterThan(0);
    expect(pull.body.events.every((e) => e.tenantId === B.tenant)).toBe(true);
    const snap = (await api.call<SnapshotResponse>('GET', '/v1/sync/snapshot', undefined, devB.deviceToken)).body;
    expect(snap.tenant.id).toBe(B.tenant);
    expect(snap.products.map((p) => p.id)).toEqual(['prd_001']);
    expect(snap.users).toEqual([]);
  });

  it('el dueño de B no lista ni revoca dispositivos de A', async () => {
    const devA = (await register(DEMO_PAIRING_CODE, 'Caja A víctima')).body;
    const ownerB = await ownerToken(B.owner.email, B.owner.password);
    const list = await api.call<Array<{ id: string }>>('GET', '/v1/devices', undefined, ownerB);
    expect(list.body.some((d) => d.id === devA.deviceId)).toBe(false);
    expect((await api.call('POST', `/v1/devices/${devA.deviceId}/revoke`, {}, ownerB)).status).toBe(404);
    expect((await api.call('GET', '/v1/sync/snapshot', undefined, devA.deviceToken)).status).toBe(200);
    expect((await api.call('GET', '/v1/products/prd_002', undefined, ownerB)).status).toBe(404);
    expect((await api.call('POST', `/v1/devices/${serverDeviceId(B.tenant)}/revoke`, {}, ownerB)).status).toBe(404);
  });

  it('revocación remota: el token revocado no puede subir, bajar ni pedir snapshot', async () => {
    const dev = (await register(DEMO_PAIRING_CODE, 'Caja a revocar')).body;
    const owner = await ownerToken(DEMO_OWNER.email, DEMO_OWNER.password);
    expect((await api.call('POST', `/v1/devices/${dev.deviceId}/revoke`, {}, owner)).status).toBe(200);
    const ev = factoryFor(dev).create('CashSessionOpened', { sessionId: 'rv', userId: 'usr_ana', openingCents: 0 });
    for (const [method, url, body] of [
      ['POST', '/v1/sync/push', { events: [ev] }],
      ['GET', '/v1/sync/pull?cursor=0', undefined],
      ['GET', '/v1/sync/snapshot', undefined],
    ] as const) {
      const r = await api.call(method, url, body, dev.deviceToken);
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('no_autenticado');
    }
    const [row] = await api.db.query<{ revoked_at: string | null; token_hash: string | null }>('SELECT revoked_at, token_hash FROM devices WHERE id = $1', [dev.deviceId]);
    expect(row.revoked_at).not.toBeNull();
    expect(row.token_hash).toBeNull();
  });
});

describe('PIN y auditoría', () => {
  it('el snapshot entrega hashes PBKDF2 con sal, verificables sin conexión', async () => {
    const dev = (await register(DEMO_PAIRING_CODE, 'Caja PIN')).body;
    const snap = (await api.call<SnapshotResponse>('GET', '/v1/sync/snapshot', undefined, dev.deviceToken)).body;
    const ana = snap.users.find((u) => u.id === 'usr_ana')!;
    expect(ana.pinHash).toMatch(/^pbkdf2\$\d+\$/);
    expect(await verifyPinHash(ana.pinHash, dev.tenantId, '1234')).toBe(true);
    expect(await verifyPinHash(ana.pinHash, dev.tenantId, '0000')).toBe(false);
  });

  it('registra anulaciones, descuentos autorizados y ajustes en audit_log inmutable y encadenado', async () => {
    const dev = (await register(DEMO_PAIRING_CODE, 'Caja auditoría')).body;
    const snap = (await api.call<SnapshotResponse>('GET', '/v1/sync/snapshot', undefined, dev.deviceToken)).body;
    const state = stateFromSnapshot(snap);
    const disc = applyDiscount(addToCart(emptyCart(), state.products.prd_005, 2), { type: 'percent', bp: 2500, scope: 'cart' }, 'supervisor');
    if (!disc.ok) throw new Error('descuento');
    const fin = finalizeSale(disc.cart, [{ method: 'cash', amountCents: 10_000_000 }]);
    if (!fin.ok) throw new Error(fin.errors.join());
    const f = factoryFor(dev);
    const saleId = uuidv7();
    const r = await api.call('POST', '/v1/sync/push', {
      events: [
        f.create('CashSessionOpened', { sessionId: 'cs-aud', userId: 'usr_ana', openingCents: 0 }),
        f.create('SaleCompleted', { saleId, localNumber: 1, cashSessionId: 'cs-aud', userId: 'usr_ana', discountAuthorizedBy: 'usr_luis', ...fin.sale }),
        f.create('SaleVoided', { saleId, reason: 'Cliente desistió', userId: 'usr_ana', authorizedBy: 'usr_luis' }),
        f.create('StockAdjusted', { productId: 'prd_005', qty: -1, reason: 'damage', userId: 'usr_luis', note: 'Empaque roto' }),
      ],
    }, dev.deviceToken);
    expect(r.body.accepted).toHaveLength(4);

    const owner = await ownerToken(DEMO_OWNER.email, DEMO_OWNER.password);
    const log = await api.call<Array<{ action: string; authorized_by: string | null; authorized_by_name: string | null; ref_id: string }>>('GET', '/v1/audit', undefined, owner);
    const mine = log.body.filter((x) => x.ref_id === saleId || x.ref_id === 'prd_005');
    expect(mine.map((x) => x.action).sort()).toEqual(['ajuste_inventario', 'descuento_autorizado', 'venta_anulada']);
    expect(mine.find((x) => x.action === 'venta_anulada')?.authorized_by_name).toBe('Luis (supervisor)');
    expect((await api.call('GET', '/v1/audit/verify', undefined, owner)).body).toMatchObject({ ok: true, brokenAtSeq: null });

    await expect(api.db.query(`UPDATE audit_log SET data = '{}'::jsonb WHERE tenant_id = $1`, [DEMO_TENANT.id])).rejects.toThrow(/solo insercion/);
    await expect(api.db.query('DELETE FROM audit_log WHERE tenant_id = $1', [DEMO_TENANT.id])).rejects.toThrow(/solo insercion/);

    // Manipulación directa (desactivando el trigger) se detecta al recalcular la cadena.
    await api.db.tx(async (q) => {
      await q.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios');
      await q.query(`UPDATE audit_log SET data = jsonb_set(data, '{delta}', '0') WHERE tenant_id = $1 AND action = 'ajuste_inventario' AND ref_id = 'prd_005'`, [DEMO_TENANT.id]);
      await q.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios');
    });
    const broken = await verifyAuditChain(api.db, DEMO_TENANT.id);
    expect(broken.ok).toBe(false);
    expect(broken.brokenAtSeq).not.toBeNull();
  });

  it('el proveedor de facturación simulado nunca declara validez legal', async () => {
    const dev = (await register(DEMO_PAIRING_CODE, 'Caja fiscal')).body;
    const snap = (await api.call<SnapshotResponse>('GET', '/v1/sync/snapshot', undefined, dev.deviceToken)).body;
    const fin = finalizeSale(addToCart(emptyCart(), stateFromSnapshot(snap).products.prd_002, 3), [{ method: 'card', amountCents: 600_000 }]);
    if (!fin.ok) throw new Error(fin.errors.join());
    const f = factoryFor(dev);
    const saleId = uuidv7();
    await api.call('POST', '/v1/sync/push', { events: [f.create('SaleCompleted', { saleId, localNumber: 7, cashSessionId: 'cs-f', userId: 'usr_ana', ...fin.sale })] }, dev.deviceToken);
    const doc = await api.call('POST', '/v1/fiscal/documents', { saleId }, dev.deviceToken);
    expect(doc.status).toBe(200);
    expect(doc.body).toMatchObject({ estado: 'aceptada', validezLegal: false, numero: 'PRUE7' });
    expect(doc.body.cufe).toMatch(/^MOCK-/);
    expect(doc.body.mensajes.join(' ')).toMatch(/no tiene validez/i);
    const range = await api.call('POST', '/v1/fiscal/ranges', { size: 10 }, dev.deviceToken);
    expect(range.body.validezLegal).toBe(false);
    expect((await api.call('POST', '/v1/fiscal/documents', { saleId: 'no-existe' }, dev.deviceToken)).status).toBe(404);
  });
});

describe('errores estructurados en español', () => {
  it('404, 400 y JSON mal formado', async () => {
    const nf = await api.call('GET', '/v1/no-existe');
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ statusCode: 404, code: 'no_encontrado', message: 'Recurso no encontrado' });
    const bad = await api.call('POST', '/v1/auth/login', { email: 'no-es-correo' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'datos_invalidos', message: 'Datos inválidos' });
    expect(bad.body.details.issues.length).toBeGreaterThan(0);
    const malformed = await api.call('POST', '/v1/auth/login', '{"email":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.message).not.toMatch(/[A-Z][a-z]+ [a-z]+ JSON/);
    const unauth = await api.call('GET', '/v1/reports/dashboard');
    expect(unauth.body).toMatchObject({ statusCode: 401, code: 'no_autenticado', message: 'Inicia sesión como dueño' });
  });
});

describe('modo producción (DEMO_MODE=false)', () => {
  let prod: TestApi;
  beforeAll(async () => {
    prod = await startApi({ DEMO_MODE: 'false' });
    await prod.db.tx(async (q) => {
      await q.query(`INSERT INTO tenants (id, name) VALUES ('tnt_p', 'Prod')`);
      await q.query(`INSERT INTO stores (id, tenant_id, name) VALUES ('str_p', 'tnt_p', 'Sede')`);
      await q.query(`INSERT INTO owners (id, tenant_id, email, name, password_hash) VALUES ('own_p', 'tnt_p', 'p@p.co', 'P', $1)`, [hashPassword('clave-prod-1')]);
      await q.query(`INSERT INTO pairing_codes (code, tenant_id, store_id, uses_left, expires_at) VALUES
        ($1, 'tnt_p', 'str_p', 100, NULL),
        ('SINV-ENCE', 'tnt_p', 'str_p', 100, NULL),
        ('UNSO-LOUS', 'tnt_p', 'str_p', 1, now() + interval '1 hour'),
        ('VENC-IDOO', 'tnt_p', 'str_p', 1, now() - interval '1 minute')`, [DEMO_PAIRING_CODE]);
    });
  });
  afterAll(async () => {
    await prod?.app.close();
  });

  it('no siembra la tienda demo y /ready lo informa', async () => {
    const [{ n }] = await prod.db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM tenants WHERE id = $1', [DEMO_TENANT.id]);
    expect(n).toBe(0);
    expect((await prod.call('GET', '/ready')).body.demoMode).toBe(false);
    expect((await prod.call('POST', '/v1/auth/login', DEMO_OWNER)).status).toBe(401);
  });

  it('rechaza DEMO-2026, códigos sin caducidad y vencidos; los de un solo uso funcionan una vez', async () => {
    expect((await register(DEMO_PAIRING_CODE, 'x', prod)).status).toBe(401);
    expect((await register('SINV-ENCE', 'x', prod)).status).toBe(401);
    expect((await register('VENC-IDOO', 'x', prod)).status).toBe(401);
    const ok = await register('unso-lous', 'Caja prod', prod);
    expect(ok.status).toBe(201);
    expect((await register('UNSO-LOUS', 'Caja 2', prod)).body).toMatchObject({ statusCode: 401, message: 'Código de emparejamiento inválido o vencido' });
  });

  it('el dueño sólo puede crear códigos de un solo uso con vencimiento', async () => {
    const owner = await ownerToken('p@p.co', 'clave-prod-1', prod);
    const created = await prod.call('POST', '/v1/devices/pairing-codes', { uses: 50 }, owner);
    expect(created.body).toMatchObject({ uses: 1, expiresInHours: 24 });
    expect(created.body.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect((await register(created.body.code, 'Caja nueva', prod)).status).toBe(201);
    expect((await register(created.body.code, 'Caja repetida', prod)).status).toBe(401);
  });
});

describe('límite de intentos', () => {
  it('login y registro devuelven 429 con mensaje en español al exceder el límite', async () => {
    const limited = await startApi({ RATE_LIMIT_MAX: '3' }, api.db);
    try {
      for (let i = 0; i < 3; i++) expect((await limited.call('POST', '/v1/auth/login', { email: DEMO_OWNER.email, password: 'mala-clave' })).status).toBe(401);
      const blocked = await limited.call('POST', '/v1/auth/login', { email: DEMO_OWNER.email, password: DEMO_OWNER.password });
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('demasiados_intentos');
      expect(blocked.body.message).toMatch(/Demasiados intentos/);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      for (let i = 0; i < 3; i++) await limited.call('POST', '/v1/devices/register', { pairingCode: 'XXXX-0000', name: 'x', platform: 'web' });
      expect((await limited.call('POST', '/v1/devices/register', { pairingCode: DEMO_PAIRING_CODE, name: 'x', platform: 'web' })).status).toBe(429);
    } finally {
      await limited.app.close();
    }
  });

  it('ventana fija: se reinicia al vencer', () => {
    let now = 0;
    const l = new FixedWindowLimiter(2, 1000, () => now);
    expect([l.take('a'), l.take('a')]).toEqual([0, 0]);
    expect(l.take('a')).toBe(1000);
    expect(l.take('b')).toBe(0);
    now = 1000;
    expect(l.take('a')).toBe(0);
  });
});

describe('validación de entorno', () => {
  it('en producción exige JWT_SECRET fuerte, DATABASE_URL y CORS explícito', () => {
    try {
      loadConfig({ NODE_ENV: 'production' });
      throw new Error('debió fallar');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toMatch(/JWT_SECRET/);
      expect(msg).toMatch(/DATABASE_URL/);
      expect(msg).toMatch(/CORS_ORIGINS/);
    }
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ BUSINESS_TZ: 'Marte/Olympus' })).toThrow(/zona horaria/);
    expect(() => loadConfig({ DEMO_MODE: 'quizas' })).toThrow(/DEMO_MODE/);
  });

  it('producción válida desactiva el modo demo por defecto', () => {
    const c = loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://u:p@db:5432/pos', CORS_ORIGINS: 'https://caja.tienda.co' });
    expect(c).toMatchObject({ production: true, demoMode: false, seedDemo: false, corsOrigins: ['https://caja.tienda.co'] });
    expect(loadConfig({}).demoMode).toBe(true);
  });
});
