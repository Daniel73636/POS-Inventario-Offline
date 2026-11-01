import {
  DEMO_CUSTOMERS,
  DEMO_STORE,
  DEMO_TENANT,
  demoCatalog,
  type EventPayload,
  type EventType,
  type PosEvent,
  type RegisterDeviceResponse,
  type ServerEvent,
  type SnapshotResponse,
} from '@pos/contracts';
import {
  applyEvent,
  emptyState,
  EventFactory,
  HybridLogicalClock,
  setRandomSource,
  stateFromSnapshot,
  SyncClient,
  uuidv7,
  type PosState,
  type SyncStatus,
  type SyncStore,
} from '@pos/sync-engine';
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

setRandomSource((bytes) => Crypto.getRandomValues(bytes));

export interface MobileConfig {
  mode: 'demo' | 'server';
  apiUrl: string | null;
  deviceId: string;
  deviceToken: string | null;
  tenantId: string;
  tenantName: string;
  storeId: string;
  storeName: string;
  userId: string;
}

/**
 * Base local Android: SQLite (expo-sqlite). Mismo diseño que la caja:
 * tabla events (fuente de verdad) + proyección derivada; evento y proyección
 * se escriben en la misma transacción.
 */
const db = SQLite.openDatabaseSync('pos.db');
db.execSync(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, body TEXT NOT NULL,
    synced_at TEXT, rejected TEXT
  );
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

function kvGet<T>(key: string, fallback: T): T {
  const row = db.getFirstSync<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]);
  return row ? (JSON.parse(row.value) as T) : fallback;
}
function kvSet(key: string, value: unknown): void {
  db.runSync('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
}

type Listener = () => void;

class MobileStore implements SyncStore {
  state: PosState = kvGet<PosState>('state', emptyState());
  config: MobileConfig | null = kvGet<MobileConfig | null>('config', null);
  sync: SyncStatus = { state: 'idle', pending: 0, lastSyncAt: null, lastError: null, clockSkewMs: 0, clockWarning: false };
  private listeners = new Set<Listener>();
  private factory: EventFactory | null = null;
  private client: SyncClient | null = null;

  constructor() {
    this.init();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private init(): void {
    this.client?.stop();
    this.client = null;
    const cfg = this.config;
    if (!cfg) return;
    const last = db.getFirstSync<{ seq: number; body: string }>('SELECT seq, body FROM events ORDER BY seq DESC LIMIT 1');
    const lastHlc = last ? (JSON.parse(last.body) as PosEvent).hlc : null;
    const clock = new HybridLogicalClock(cfg.deviceId, () => Date.now(), lastHlc);
    this.factory = new EventFactory({ tenantId: cfg.tenantId, storeId: cfg.storeId, deviceId: cfg.deviceId }, clock, last?.seq ?? 0);
    if (cfg.mode === 'server' && cfg.apiUrl) {
      this.client = new SyncClient({ baseUrl: cfg.apiUrl, deviceId: cfg.deviceId, getToken: () => cfg.deviceToken, store: this, clock, intervalMs: 20000 });
      this.client.subscribe((s) => {
        this.sync = s;
        this.notify();
      });
      this.client.start();
    }
    void this.countPending().then((pending) => {
      this.sync = { ...this.sync, pending };
      this.notify();
    });
  }

  emit<K extends EventType>(type: K, payload: EventPayload<K>): void {
    if (!this.factory) throw new Error('Dispositivo sin configurar');
    const event = this.factory.create(type, payload);
    db.withTransactionSync(() => {
      db.runSync('INSERT INTO events (id, seq, body) VALUES (?, ?, ?)', [event.id, event.seq, JSON.stringify(event)]);
      applyEvent(this.state, event);
      kvSet('state', this.state);
    });
    this.sync = { ...this.sync, pending: this.sync.pending + 1, state: this.client ? 'pending' : this.sync.state };
    this.client?.nudge(800);
    this.notify();
  }

  private bootstrap(cfg: MobileConfig, state: PosState, cursor: number): void {
    db.withTransactionSync(() => {
      db.runSync('DELETE FROM events');
      db.runSync('DELETE FROM kv');
      kvSet('config', cfg);
      kvSet('state', state);
      kvSet('cursor', cursor);
    });
    this.config = cfg;
    this.state = state;
    this.init();
    this.notify();
  }

  setupDemo(): void {
    const rows = demoCatalog();
    const state = stateFromSnapshot({
      products: rows.map((r) => r.product),
      customers: DEMO_CUSTOMERS,
      stock: rows.map((r) => ({ productId: r.product.id, qty: r.initialStock })),
      lots: rows
        .filter((r) => r.expiresOn && r.product.tracksLots)
        .map((r) => ({ productId: r.product.id, lotId: `L-${r.product.sku}`, qty: r.initialStock, expiresOn: r.expiresOn })),
    });
    this.bootstrap(
      { mode: 'demo', apiUrl: null, deviceId: `and-demo-${uuidv7().slice(-12)}`, deviceToken: null, tenantId: DEMO_TENANT.id, tenantName: DEMO_TENANT.name, storeId: DEMO_STORE.id, storeName: DEMO_STORE.name, userId: 'usr_ana' },
      state,
      0,
    );
  }

  async setupServer(apiUrl: string, pairingCode: string, name: string): Promise<void> {
    const base = apiUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/v1/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode, name, platform: 'android' }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `Error ${res.status}`);
    const reg = (await res.json()) as RegisterDeviceResponse;
    const snapRes = await fetch(`${base}/v1/sync/snapshot`, { headers: { authorization: `Bearer ${reg.deviceToken}` } });
    if (!snapRes.ok) throw new Error('No se pudo descargar el catálogo');
    const snap = (await snapRes.json()) as SnapshotResponse;
    const cashier = snap.users.find((u) => u.role === 'cashier') ?? snap.users[0];
    this.bootstrap(
      { mode: 'server', apiUrl: base, deviceId: reg.deviceId, deviceToken: reg.deviceToken, tenantId: reg.tenantId, tenantName: reg.tenantName, storeId: reg.storeId, storeName: reg.storeName, userId: cashier?.id ?? 'usr_movil' },
      stateFromSnapshot(snap),
      snap.cursor,
    );
  }

  async syncNow(): Promise<void> {
    await this.client?.syncNow();
    this.notify();
  }

  /** Turno de caja del dispositivo (se abre automáticamente con base 0 en la primera venta). */
  currentSessionId(): string {
    let id = kvGet<string | null>('session', null);
    if (!id || this.state.cashSessions[id]?.closedAt) {
      id = uuidv7();
      this.emit('CashSessionOpened', { sessionId: id, userId: this.config?.userId ?? 'usr_movil', openingCents: 0 });
      kvSet('session', id);
    }
    return id;
  }

  nextSaleNumber(): number {
    const n = kvGet<number>('saleNumber', 0) + 1;
    kvSet('saleNumber', n);
    return n;
  }

  // ------------------------------------------------------------ SyncStore
  async getPendingEvents(limit: number): Promise<PosEvent[]> {
    return db
      .getAllSync<{ body: string }>('SELECT body FROM events WHERE synced_at IS NULL AND rejected IS NULL ORDER BY seq LIMIT ?', [limit])
      .map((r) => JSON.parse(r.body) as PosEvent);
  }

  async countPending(): Promise<number> {
    return db.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE synced_at IS NULL AND rejected IS NULL')?.n ?? 0;
  }

  async markSynced(ids: string[], syncedAt: string): Promise<void> {
    db.withTransactionSync(() => {
      for (const id of ids) db.runSync('UPDATE events SET synced_at = ? WHERE id = ?', [syncedAt, id]);
    });
  }

  async markRejected(rejected: Array<{ id: string | null; reason: string }>): Promise<void> {
    for (const r of rejected) if (r.id) db.runSync('UPDATE events SET rejected = ? WHERE id = ?', [r.reason, r.id]);
  }

  async getCursor(): Promise<number> {
    return kvGet<number>('cursor', 0);
  }

  async applyRemoteEvents(events: ServerEvent[], cursor: number): Promise<void> {
    db.withTransactionSync(() => {
      for (const e of events) applyEvent(this.state, e);
      kvSet('state', this.state);
      kvSet('cursor', cursor);
    });
    if (events.length) this.notify();
  }

  reset(): void {
    this.client?.stop();
    db.withTransactionSync(() => {
      db.runSync('DELETE FROM events');
      db.runSync('DELETE FROM kv');
    });
    this.config = null;
    this.state = emptyState();
    this.notify();
  }
}

export const store = new MobileStore();
