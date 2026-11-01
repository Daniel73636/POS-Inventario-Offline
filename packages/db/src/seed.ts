import {
  DEMO_CUSTOMERS,
  DEMO_OWNER,
  DEMO_PAIRING_CODE,
  DEMO_PRICE_LISTS,
  DEMO_STORE,
  DEMO_TENANT,
  DEMO_USERS,
  demoCatalog,
  type EventPayload,
  type EventType,
} from '@pos/contracts';
import { addToCart, computeCartTotals, emptyCart, finalizeSale, type CartProduct } from '@pos/domain-pos';
import { EventFactory, HybridLogicalClock, uuidv7 } from '@pos/sync-engine';
import type { Database } from './adapter';
import { emitServerEvents, ingestEvents, serverDeviceId } from './ingest';
import { hashPassword, hashPin } from './security';

export interface SeedResult {
  created: boolean;
  products: number;
  historicalSales: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Crea la tienda "MiniMarket Demo" (idempotente: no hace nada si ya existe). */
export async function seedDemo(db: Database, opts: { historicalSales?: boolean } = {}): Promise<SeedResult> {
  const [exists] = await db.query('SELECT 1 FROM tenants WHERE id = $1', [DEMO_TENANT.id]);
  if (exists) return { created: false, products: 0, historicalSales: 0 };

  const t = DEMO_TENANT.id;
  await db.tx(async (q) => {
    await q.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [t, DEMO_TENANT.name]);
    await q.query('INSERT INTO stores (id, tenant_id, name) VALUES ($1, $2, $3)', [DEMO_STORE.id, t, DEMO_STORE.name]);
    await q.query('INSERT INTO owners (id, tenant_id, email, name, password_hash) VALUES ($1,$2,$3,$4,$5)', [
      'own_demo',
      t,
      DEMO_OWNER.email,
      DEMO_OWNER.name,
      hashPassword(DEMO_OWNER.password),
    ]);
    for (const u of DEMO_USERS) {
      await q.query('INSERT INTO users (id, tenant_id, name, role, pin_hash) VALUES ($1,$2,$3,$4,$5)', [u.id, t, u.name, u.role, await hashPin(t, u.pin)]);
    }
    for (const pl of DEMO_PRICE_LISTS) {
      await q.query('INSERT INTO price_lists (tenant_id, id, name) VALUES ($1,$2,$3)', [t, pl.id, pl.name]);
    }
    await q.query(
      `INSERT INTO devices (id, tenant_id, store_id, name, platform) VALUES ($1,$2,$3,'Servidor (panel web)','server')`,
      [serverDeviceId(t), t, DEMO_STORE.id],
    );
    await q.query('INSERT INTO pairing_codes (code, tenant_id, store_id, uses_left) VALUES ($1,$2,$3,$4)', [DEMO_PAIRING_CODE, t, DEMO_STORE.id, 100]);
  });

  const catalog = demoCatalog();
  const items: Array<{ type: EventType; payload: EventPayload<EventType> }> = [];
  for (const row of catalog) items.push({ type: 'ProductUpserted', payload: { product: row.product } });
  for (const c of DEMO_CUSTOMERS) items.push({ type: 'CustomerUpserted', payload: { customer: c } });
  for (const row of catalog) {
    items.push({
      type: 'StockReceived',
      payload: {
        productId: row.product.id,
        qty: row.initialStock,
        unitCostCents: row.product.costAvgCents,
        lotCode: row.expiresOn ? `L-${row.product.sku}` : null,
        expiresOn: row.expiresOn,
        supplier: 'Inventario inicial',
        userId: 'usr_owner',
      },
    });
  }
  await emitServerEvents(db, t, items);

  let historical = 0;
  if (opts.historicalSales !== false) historical = await seedHistory(db, catalog.map((r) => r.product));
  return { created: true, products: catalog.length, historicalSales: historical };
}

/** Ventas de los últimos 7 días desde una caja "histórica" para que el panel tenga datos. */
async function seedHistory(db: Database, products: CartProduct[]): Promise<number> {
  const t = DEMO_TENANT.id;
  const deviceId = 'dev_historico';
  await db.query(
    `INSERT INTO devices (id, tenant_id, store_id, name, platform, revoked_at) VALUES ($1,$2,$3,'Caja histórica (demo)','web', now())`,
    [deviceId, t, DEMO_STORE.id],
  );
  const rnd = mulberry32(2026);
  const now = Date.now();
  const startDay = new Date(now - 6 * 86400000);
  startDay.setHours(8, 0, 0, 0);
  const fakeNow = { t: startDay.getTime() };
  const clock = new HybridLogicalClock(deviceId, () => fakeNow.t);
  const factory = new EventFactory({ tenantId: t, storeId: DEMO_STORE.id, deviceId }, clock);
  const events = [];
  let saleNo = 0;
  const unitProducts = products.filter((p) => p.unit !== 'kg' || rnd() < 0.5);

  for (let day = 0; day < 7; day++) {
    const dayStart = startDay.getTime() + day * 86400000;
    if (dayStart > now) break;
    const sessionId = uuidv7(dayStart);
    fakeNow.t = dayStart;
    events.push(factory.create('CashSessionOpened', { sessionId, userId: 'usr_ana', openingCents: 10000000 }, new Date(dayStart)));
    const salesToday = 6 + Math.floor(rnd() * 6);
    let cashSales = 0;
    for (let s = 0; s < salesToday; s++) {
      const at = dayStart + Math.floor(((s + rnd()) / salesToday) * 11 * 3600000);
      if (at > now) break;
      fakeNow.t = at;
      let cart = emptyCart();
      const lines = 1 + Math.floor(rnd() * 4);
      for (let l = 0; l < lines; l++) {
        const p = unitProducts[Math.floor(rnd() * unitProducts.length)];
        const qty = p.unit === 'kg' ? Math.round((0.5 + rnd() * 1.5) * 1000) / 1000 : 1 + Math.floor(rnd() * 3);
        cart = addToCart(cart, p, qty);
      }
      const method = rnd() < 0.7 ? 'cash' : rnd() < 0.5 ? 'card' : 'transfer';
      const total = computeCartTotals(cart).totalCents;
      const fin = finalizeSale(cart, [{ method, amountCents: total }]);
      if (!fin.ok) continue;
      saleNo += 1;
      if (method === 'cash') cashSales += total;
      events.push(
        factory.create(
          'SaleCompleted',
          { saleId: uuidv7(at), localNumber: saleNo, cashSessionId: sessionId, userId: 'usr_ana', ...fin.sale, items: fin.sale.items, payments: fin.sale.payments },
          new Date(at),
        ),
      );
    }
    const closeAt = dayStart + 12 * 3600000;
    if (closeAt < now) {
      fakeNow.t = closeAt;
      const expected = 10000000 + cashSales;
      const diff = rnd() < 0.2 ? -50000 : 0;
      events.push(
        factory.create('CashSessionClosed', { sessionId, userId: 'usr_ana', countedCents: expected + diff, expectedCents: expected, differenceCents: diff }, new Date(closeAt)),
      );
    }
  }
  for (let i = 0; i < events.length; i += 200) {
    await ingestEvents(db, { id: deviceId, tenantId: t, storeId: DEMO_STORE.id }, events.slice(i, i + 200));
  }
  return saleNo;
}