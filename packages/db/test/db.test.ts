import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_STORE, DEMO_TENANT } from '@pos/contracts';
import { EventFactory, HybridLogicalClock, applyEvents, stateFromSnapshot } from '@pos/sync-engine';
import { buildSnapshot, createDatabase, ingestEvents, migrate, pullEvents, seedDemo, type Database } from '../src';

let db: Database;
const device = { id: 'dev_test', tenantId: DEMO_TENANT.id, storeId: DEMO_STORE.id };

beforeAll(async () => {
  db = await createDatabase();
  await migrate(db);
  const r = await seedDemo(db);
  expect(r.created).toBe(true);
  expect(r.products).toBe(30);
  await db.query(`INSERT INTO devices (id, tenant_id, store_id, name, platform) VALUES ($1,$2,$3,'Test','web')`, [device.id, device.tenantId, device.storeId]);
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe('base central', () => {
  it('seed es idempotente', async () => {
    expect((await seedDemo(db)).created).toBe(false);
    const [{ n }] = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM products');
    expect(n).toBe(30);
  });

  it('push idempotente, pull por cursor y stock negativo con alerta', async () => {
    const snap = await buildSnapshot(db, device.tenantId, device.storeId);
    const shampoo = snap.products.find((p) => p.name.startsWith('Shampoo'))!;
    const stock = snap.stock.find((s) => s.productId === shampoo.id)!.qty;
    expect(stock).toBeLessThanOrEqual(9);
    const qty = stock + 1;

    const f = new EventFactory({ ...device, deviceId: device.id }, new HybridLogicalClock(device.id));
    const sale = f.create('SaleCompleted', {
      saleId: 'sale-test-1',
      localNumber: 1,
      cashSessionId: 'cs-1',
      userId: 'usr_ana',
      customerId: null,
      subtotalCents: shampoo.priceCents * qty,
      discountCents: 0,
      taxCents: 0,
      totalCents: shampoo.priceCents * qty,
      changeCents: 0,
      items: [{ productId: shampoo.id, name: shampoo.name, packId: null, qty, baseQty: qty, unitPriceCents: shampoo.priceCents, unitCostCents: 1000, discountCents: 0, taxRateBp: 1900, taxCents: 0, lineTotalCents: shampoo.priceCents * qty }],
      payments: [{ method: 'cash', amountCents: shampoo.priceCents * qty }],
    });
    const first = await ingestEvents(db, device, [sale]);
    expect(first.rejected).toEqual([]);
    expect(first.accepted).toEqual([sale.id]);
    const again = await ingestEvents(db, device, [sale, { garbage: true }]);
    expect(again.accepted).toEqual([]);
    expect(again.duplicates).toEqual([sale.id]);
    expect(again.rejected).toHaveLength(1);

    const pulled = await pullEvents(db, device.tenantId, snap.cursor);    expect(pulled.events.map((e) => e.id)).toEqual([sale.id]);
    expect(pulled.cursor).toBeGreaterThan(snap.cursor);

    const [lvl] = await db.query<{ qty: number }>('SELECT qty FROM stock_levels WHERE product_id = $1', [shampoo.id]);
    expect(Number(lvl.qty)).toBe(-1);
    const alerts = await db.query<{ kind: string }>(`SELECT kind FROM alerts WHERE product_id = $1`, [shampoo.id]);
    expect(alerts.map((a) => a.kind)).toContain('negative_stock');
  });

  it('snapshot + pull desde el cursor equivale a reproducir todo el log', async () => {
    const snap = await buildSnapshot(db, device.tenantId, device.storeId);
    const fromSnapshot = stateFromSnapshot(snap);
    const all = await pullEvents(db, device.tenantId, 0, 500);
    let events = all.events;
    let cursor = all.cursor;
    let more = all.hasMore;
    while (more) {
      const next = await pullEvents(db, device.tenantId, cursor, 500);
      events = events.concat(next.events);
      cursor = next.cursor;
      more = next.hasMore;
    }
    const replay = stateFromSnapshot({ products: [], customers: [], stock: [] });
    applyEvents(replay, events);
    for (const [pid, qty] of Object.entries(replay.stock)) {
      expect(fromSnapshot.stock[pid] ?? 0).toBeCloseTo(qty, 6);
    }
  });
});
