import { describe, expect, it } from 'vitest';
import type { PosEvent, Product } from '@pos/contracts';
import {
  compareHlc,
  EventFactory,
  HybridLogicalClock,
  InMemorySyncServer,
  MemorySyncStore,
  parseHlc,
  setRandomSource,
  SyncClient,
  uuidv7,
} from '../src';

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

const CTX = { tenantId: 't1', storeId: 's1' };

function product(id: string, priceCents: number): Product {
  return {
    id,
    name: `Producto ${id}`,
    sku: null,
    category: 'General',
    brand: null,
    unit: 'unit',
    taxCode: 'IVA19',
    taxRateBp: 1900,
    taxIncluded: true,
    priceCents,
    costAvgCents: 1000,
    minStock: null,
    active: true,
    tracksLots: false,
    barcodes: [`770${id}`],
    prices: [],
    packs: [],
    color: null,
    quick: false,
  };
}

interface Device {
  id: string;
  store: MemorySyncStore;
  factory: EventFactory;
  clock: HybridLogicalClock;
  client: SyncClient;
  saleNo: number;
}

function makeDevice(id: string, server: InMemorySyncServer, rnd: () => number, net: { failRate: number }, time: () => number): Device {
  const clock = new HybridLogicalClock(id, time);
  const store = new MemorySyncStore();
  const factory = new EventFactory({ ...CTX, deviceId: id }, clock);
  const fetchImpl = server.fetchFor({ random: rnd, duplicateRate: 0.2, failRate: 0 });
  const client = new SyncClient({
    baseUrl: 'http://local',
    deviceId: id,
    getToken: () => id,
    store,
    clock,
    pullBatch: 7,
    fetch: async (url, init) => {
      if (rnd() < net.failRate) throw new TypeError('Network request failed');
      const res = await fetchImpl(url, init);
      if (rnd() < net.failRate / 3) throw new TypeError('Respuesta perdida');
      return res;
    },
  });
  return { id, store, factory, clock, client, saleNo: 0 };
}

function sale(d: Device, productId: string, qty: number): PosEvent {
  d.saleNo += 1;
  return d.factory.create('SaleCompleted', {
    saleId: uuidv7(),
    localNumber: d.saleNo,
    cashSessionId: `cs-${d.id}`,
    userId: 'u',
    customerId: null,
    subtotalCents: 1000 * qty,
    discountCents: 0,
    taxCents: 0,
    totalCents: 1000 * qty,
    changeCents: 0,
    items: [
      {
        productId,
        name: productId,
        packId: null,
        qty,
        baseQty: qty,
        unitPriceCents: 1000,
        unitCostCents: 500,
        discountCents: 0,
        taxRateBp: 0,
        taxCents: 0,
        lineTotalCents: 1000 * qty,
      },
    ],
    payments: [{ method: 'cash', amountCents: 1000 * qty }],
  });
}

describe('HLC y UUIDv7', () => {
  it('HLC es monótono aunque el reloj retroceda', () => {
    let t = 1000;
    const c = new HybridLogicalClock('a', () => t);
    const a = c.now();
    t = 500; // reloj del equipo atrasado
    const b = c.now();
    expect(compareHlc(b, a)).toBe(1);
    const r = c.receive('000000000005000:00003:z');
    expect(parseHlc(r)).toMatchObject({ millis: 5000, counter: 4 });
    expect(compareHlc(c.now(), r)).toBe(1);
  });

  it('UUIDv7 tiene versión 7 y es ordenable por tiempo', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a[14]).toBe('7');
    expect(a < b).toBe(true);
  });
});

describe('convergencia de sincronización', () => {
  it('reenviar un lote no duplica eventos (idempotencia)', () => {
    const server = new InMemorySyncServer();
    const clock = new HybridLogicalClock('d1');
    const f = new EventFactory({ ...CTX, deviceId: 'd1' }, clock);
    const e = f.create('CashSessionOpened', { sessionId: 's', userId: 'u', openingCents: 100 });
    expect(server.push('d1', [e]).accepted).toHaveLength(1);
    const again = server.push('d1', [e]);
    expect(again.accepted).toHaveLength(0);
    expect(again.duplicates).toEqual([e.id]);
    expect(server.log).toHaveLength(1);
    expect(server.push('d2', [e]).rejected).toHaveLength(1);
  });

  it('dos cajas venden la última unidad offline → stock −1 y alerta', async () => {
    const server = new InMemorySyncServer();
    const rnd = mulberry32(1);
    const net = { failRate: 0 };
    let t = 1_761_700_000_000;
    const time = () => (t += 7);
    const admin = makeDevice('server', server, rnd, net, time);
    admin.store.record(admin.factory.create('ProductUpserted', { product: product('p1', 1000) }));
    admin.store.record(admin.factory.create('StockReceived', { productId: 'p1', qty: 1, unitCostCents: 500, userId: 'u' }));
    await admin.client.syncNow();

    const a = makeDevice('caja-1', server, rnd, net, time);
    const b = makeDevice('caja-2', server, rnd, net, time);
    await a.client.syncNow();
    await b.client.syncNow();
    expect(a.store.state.stock.p1).toBe(1);

    a.store.record(sale(a, 'p1', 1));
    b.store.record(sale(b, 'p1', 1));
    expect(a.store.state.stock.p1).toBe(0);
    for (const d of [a, b, a, b]) await d.client.syncNow();

    expect(a.store.state.stock.p1).toBe(-1);
    expect(b.store.state.stock.p1).toBe(-1);
    expect(server.state().stock.p1).toBe(-1);
    expect(server.state().alerts.length).toBeGreaterThan(0);
    expect(Object.keys(server.state().sales)).toHaveLength(2);
  });

  it('catálogo: última escritura gana por HLC en todos los dispositivos', async () => {
    const server = new InMemorySyncServer();
    const rnd = mulberry32(2);
    const net = { failRate: 0 };
    let t = 1_761_700_000_000;
    const time = () => (t += 3);
    const a = makeDevice('a', server, rnd, net, time);
    const b = makeDevice('b', server, rnd, net, time);
    a.store.record(a.factory.create('ProductUpserted', { product: product('p1', 1000) }));
    b.store.record(b.factory.create('ProductUpserted', { product: product('p1', 2000) })); // más reciente
    await b.client.syncNow();
    await a.client.syncNow();
    await b.client.syncNow();
    expect(a.store.state.products.p1.priceCents).toBe(2000);
    expect(b.store.state.products.p1.priceCents).toBe(2000);
  });

  it.each(Array.from({ length: 40 }, (_, i) => i + 1))(
    'simulación determinista semilla %i: 5 dispositivos, cortes y duplicados convergen',
    async (seed) => {
      const rnd = mulberry32(seed);
      setRandomSource((bytes) => {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rnd() * 256);
        return bytes;
      });
      const server = new InMemorySyncServer();
      const net = { failRate: 0.35 };
      let t = 1_761_700_000_000;
      const time = () => (t += Math.floor(rnd() * 50));

      const admin = makeDevice('server', server, rnd, { failRate: 0 }, time);
      const products = ['p1', 'p2', 'p3', 'p4'];
      for (const id of products) {
        admin.store.record(admin.factory.create('ProductUpserted', { product: product(id, 1000) }));
        admin.store.record(admin.factory.create('StockReceived', { productId: id, qty: 10, unitCostCents: 500, userId: 'u' }));
      }
      await admin.client.syncNow();

      const devices = Array.from({ length: 5 }, (_, i) => makeDevice(`caja-${i + 1}`, server, rnd, net, time));
      for (const d of devices) {
        net.failRate = 0;
        await d.client.syncNow();
      }
      net.failRate = 0.35;

      let expectedDelta: Record<string, number> = {};
      for (let step = 0; step < 120; step++) {
        const d = devices[Math.floor(rnd() * devices.length)];
        const pid = products[Math.floor(rnd() * products.length)];
        const op = rnd();
        if (op < 0.6) {
          const qty = 1 + Math.floor(rnd() * 3);
          d.store.record(sale(d, pid, qty));
          expectedDelta[pid] = (expectedDelta[pid] ?? 0) - qty;
        } else if (op < 0.75) {
          const qty = 1 + Math.floor(rnd() * 5);
          d.store.record(d.factory.create('StockReceived', { productId: pid, qty, unitCostCents: 600, userId: 'u' }));
          expectedDelta[pid] = (expectedDelta[pid] ?? 0) + qty;
        } else if (op < 0.8) {
          d.store.record(d.factory.create('ProductUpserted', { product: product(pid, 1000 + Math.floor(rnd() * 500)) }));
        } else {
          await d.client.syncNow();
        }
      }

      // Se restablece la red: todos sincronizan hasta converger.
      net.failRate = 0;
      for (let round = 0; round < 3; round++) for (const d of devices) await d.client.syncNow();

      const consolidated = server.state();
      for (const pid of products) {
        expect(consolidated.stock[pid]).toBe(10 + (expectedDelta[pid] ?? 0));
      }
      for (const d of devices) {
        expect(await d.store.countPending()).toBe(0);
        expect(d.store.state.stock).toEqual(consolidated.stock);
        expect(Object.keys(d.store.state.sales).sort()).toEqual(Object.keys(consolidated.sales).sort());
        for (const pid of products) {
          expect(d.store.state.products[pid].priceCents).toBe(consolidated.products[pid].priceCents);
        }
      }
      // Ningún evento duplicado en el servidor.
      const keys = server.log.map((e) => `${e.deviceId}#${e.seq}`);
      expect(new Set(keys).size).toBe(keys.length);
      expectedDelta = {};
    },
  );
});
