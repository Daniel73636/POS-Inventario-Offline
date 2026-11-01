import { DEMO_STORE, DEMO_TENANT, demoCatalog } from '@pos/contracts';
import { EventFactory, HybridLogicalClock, InMemorySyncServer, stateFromSnapshot, SyncClient } from '@pos/sync-engine';
import { describe, expect, it } from 'vitest';
import { BACKUP_FORMAT, LocalDb, parseBackup, type DeviceConfig, type StoredEvent } from '@/lib/local-db';

let n = 0;
const dbName = () => `pos-test-${++n}-${Date.now()}`;

const config: DeviceConfig = {
  mode: 'server',
  apiUrl: 'http://api',
  deviceId: 'dev_web_1',
  deviceToken: 'dev_web_1',
  deviceName: 'Caja 1',
  tenantId: DEMO_TENANT.id,
  tenantName: DEMO_TENANT.name,
  storeId: DEMO_STORE.id,
  storeName: DEMO_STORE.name,
};

function initialState() {
  const rows = demoCatalog(new Date('2026-11-01'));
  return { rows, state: stateFromSnapshot({ products: rows.map((r) => r.product), customers: [], stock: rows.map((r) => ({ productId: r.product.id, qty: r.initialStock })) }) };
}

function factory(seq = 0) {
  return new EventFactory({ tenantId: config.tenantId, storeId: config.storeId, deviceId: config.deviceId }, new HybridLogicalClock(config.deviceId), seq);
}

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

describe('LocalDb sobre IndexedDB', () => {
  it('persiste eventos, meta y proyección entre aperturas', async () => {
    const name = dbName();
    const { rows, state } = initialState();
    const db = await LocalDb.open({ name, legacy: null });
    await db.bootstrap(config, state, 7, [], [{ id: 'general', name: 'General' }]);
    const f = factory();
    const p = rows[0].product;
    db.record(f.create('StockAdjusted', { productId: p.id, qty: -3, reason: 'damage', userId: 'usr_ana' }));
    db.record(f.create('CashSessionOpened', { sessionId: 's1', userId: 'usr_ana', openingCents: 0 }), { sessionId: 's1' });
    await db.flush();
    db.close();

    const again = await LocalDb.open({ name, legacy: null });
    expect(again.getConfig()?.deviceId).toBe(config.deviceId);
    expect(again.allEvents()).toHaveLength(2);
    expect(again.meta).toMatchObject({ lastSeq: 2, sessionId: 's1' });
    expect(again.state.stock[p.id]).toBe(rows[0].initialStock - 3);
    expect(await again.getCursor()).toBe(7);
    expect(await again.countPending()).toBe(2);
    again.close();
  });

  it('migra la base antigua de localStorage y la borra', async () => {
    const { rows, state } = initialState();
    const f = factory();
    const ev = f.create('StockAdjusted', { productId: rows[1].product.id, qty: -1, reason: 'damage', userId: 'u' });
    const legacy = new MemoryStorage();
    const events: StoredEvent[] = [{ event: ev, syncedAt: null, rejected: null }];
    legacy.setItem('pos:config', JSON.stringify(config));
    legacy.setItem('pos:events', JSON.stringify(events));
    // La proyección antigua no alcanzó a guardar el evento: se recupera al abrir.
    legacy.setItem('pos:state', JSON.stringify(state));
    legacy.setItem('pos:meta', JSON.stringify({ lastSeq: 0, lastHlc: null, saleNumber: 4, sessionId: null }));
    legacy.setItem('pos:cursor', '12');

    const db = await LocalDb.open({ name: dbName(), legacy });
    expect(db.allEvents().map((s) => s.event.id)).toEqual([ev.id]);
    expect(db.meta).toMatchObject({ lastSeq: 1, saleNumber: 4 });
    expect(db.state.stock[rows[1].product.id]).toBe(rows[1].initialStock - 1);
    expect(await db.getCursor()).toBe(12);
    expect(legacy.data.size).toBe(0);
    const audit = await db.getAudit();
    expect(audit.map((a) => a.type)).toContain('storage_migrated');
    db.close();
  });

  it('re-aplica eventos locales si la proyección guardada quedó atrasada', async () => {
    const name = dbName();
    const { rows, state } = initialState();
    const db = await LocalDb.open({ name, legacy: null });
    await db.bootstrap(config, structuredClone(state), 0, [], []);
    const f = factory();
    db.record(f.create('StockAdjusted', { productId: rows[2].product.id, qty: -2, reason: 'damage', userId: 'u' }));
    await db.flush();
    db.close();
    // Simula corte justo antes de escribir la proyección.
    const raw = await LocalDb.open({ name, legacy: null });
    await (raw as unknown as { dexie: { kv: { put(r: unknown): Promise<unknown> } } }).dexie.kv.put({ key: 'state', value: state });
    raw.close();

    const recovered = await LocalDb.open({ name, legacy: null });
    expect(recovered.state.stock[rows[2].product.id]).toBe(rows[2].initialStock - 2);
    recovered.close();
  });

  it('sincroniza con el servidor: lotes, marcado e idempotencia', async () => {
    const server = new InMemorySyncServer();
    const { rows, state } = initialState();
    const db = await LocalDb.open({ name: dbName(), legacy: null });
    await db.bootstrap(config, state, 0, [], []);
    const f = factory();
    for (let i = 0; i < 250; i++) db.record(f.create('StockAdjusted', { productId: rows[i % 30].product.id, qty: -1, reason: 'damage', userId: 'u' }));
    const client = new SyncClient({ baseUrl: 'http://local', deviceId: config.deviceId, getToken: () => config.deviceId, store: db, fetch: server.fetchFor() });
    const st = await client.syncNow();
    expect(st.state).toBe('synced');
    expect(server.log).toHaveLength(250);
    expect(await db.countPending()).toBe(0);
    await client.syncNow();
    expect(server.log).toHaveLength(250);
    db.close();
  });

  it('exporta e importa un respaldo completo', async () => {
    const { rows, state } = initialState();
    const src = await LocalDb.open({ name: dbName(), legacy: null });
    await src.bootstrap(config, state, 3, [{ id: 'usr_ana', name: 'Ana', role: 'cashier', pinHash: 'x' }], []);
    const f = factory();
    src.record(f.create('StockAdjusted', { productId: rows[0].product.id, qty: -5, reason: 'damage', userId: 'u' }), { saleNumber: 9 });
    const backup = JSON.parse(JSON.stringify(await src.exportBackup()));
    expect(backup.format).toBe(BACKUP_FORMAT);
    src.close();

    const dst = await LocalDb.open({ name: dbName(), legacy: null });
    await dst.importBackup(backup);
    expect(dst.getConfig()?.deviceId).toBe(config.deviceId);
    expect(dst.meta.saleNumber).toBe(9);
    expect(dst.state.stock[rows[0].product.id]).toBe(rows[0].initialStock - 5);
    expect(await dst.countPending()).toBe(1);
    expect(dst.getUsers()).toHaveLength(1);
    dst.close();
  });

  it('rechaza respaldos inválidos o de una versión más nueva', () => {
    expect(() => parseBackup({ hola: 1 })).toThrow(/no es un respaldo/);
    expect(() => parseBackup({ format: BACKUP_FORMAT, schemaVersion: 999, events: [], state: {}, users: [] })).toThrow(/versión más nueva/);
    expect(() => parseBackup({ format: BACKUP_FORMAT, schemaVersion: 1, events: [{}], state: {}, users: [] })).toThrow(/dañados/);
  });
});
