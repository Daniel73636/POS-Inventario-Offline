import type { PosEvent, PriceList, ServerEvent, User } from '@pos/contracts';
import { applyEvent, emptyState, type PosState, type SyncStore } from '@pos/sync-engine';
import Dexie, { type Table } from 'dexie';

/**
 * Base local del navegador sobre IndexedDB (Dexie).
 * - Registro de eventos inmutable (fuente de verdad del dispositivo).
 * - Proyección (PosState) derivada; si la pestaña se cierra antes de guardarla,
 *   al arrancar se re-aplican los eventos locales que falten.
 * - Lectura síncrona desde una caché en memoria cargada por `LocalDb.open()`;
 *   las escrituras pasan por una cola serializada hacia IndexedDB.
 * Ruta de producción de escritorio: Tauri + SQLite (SQLCipher) con la misma interfaz SyncStore.
 */
export interface DeviceConfig {
  mode: 'demo' | 'server';
  apiUrl: string | null;
  deviceId: string;
  deviceToken: string | null;
  deviceName: string;
  tenantId: string;
  tenantName: string;
  storeId: string;
  storeName: string;
}

export interface StoredEvent {
  event: PosEvent;
  syncedAt: string | null;
  rejected: string | null;
}

export interface ParkedSale {
  id: string;
  at: string;
  label: string;
  cart: unknown;
}

export interface LocalMeta {
  lastSeq: number;
  lastHlc: string | null;
  saleNumber: number;
  sessionId: string | null;
}

export interface LocalAuditEntry {
  id?: number;
  at: string;
  type: 'pin_failed' | 'pin_locked' | 'login' | 'supervisor_authorized' | 'backup_exported' | 'backup_imported' | 'storage_migrated';
  userId: string | null;
  detail: string;
}

/** Versión del esquema IndexedDB. Cada cambio agrega un `version(n)` en PosDexie. */
export const SCHEMA_VERSION = 1;
export const BACKUP_FORMAT = 'pos-inventario-respaldo';

interface EventRow extends StoredEvent {
  id: string;
  seq: number;
  /** 1 = pendiente de subir (IndexedDB no indexa null). */
  pending: 0 | 1;
}

interface KvRow {
  key: string;
  value: unknown;
}

class PosDexie extends Dexie {
  events!: Table<EventRow, string>;
  kv!: Table<KvRow, string>;
  audit!: Table<LocalAuditEntry, number>;

  constructor(name: string) {
    super(name, { chromeTransactionDurability: 'strict' });
    this.version(1).stores({ events: '&id, seq, pending', kv: '&key', audit: '++id, at' });
  }
}

const LEGACY_KEYS = {
  config: 'pos:config',
  events: 'pos:events',
  state: 'pos:state',
  cursor: 'pos:cursor',
  meta: 'pos:meta',
  users: 'pos:users',
  priceLists: 'pos:priceLists',
  parked: 'pos:parked',
  draft: 'pos:draft',
} as const;

type KvKey = 'schemaVersion' | 'config' | 'state' | 'cursor' | 'meta' | 'users' | 'priceLists' | 'parked' | 'draft' | 'security';

const EMPTY_META: LocalMeta = { lastSeq: 0, lastHlc: null, saleNumber: 0, sessionId: null };
const DEFAULT_PRICE_LISTS: PriceList[] = [{ id: 'general', name: 'General' }];

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  config: DeviceConfig | null;
  meta: LocalMeta;
  cursor: number;
  users: User[];
  priceLists: PriceList[];
  parked: ParkedSale[];
  state: PosState;
  events: StoredEvent[];
}

export interface OpenOptions {
  name?: string;
  /** Almacenamiento antiguo a migrar (por defecto window.localStorage). */
  legacy?: Pick<Storage, 'getItem' | 'removeItem'> | null;
}

function readLegacy<T>(legacy: Pick<Storage, 'getItem'>, key: string, fallback: T): T {
  const raw = legacy.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRow(s: StoredEvent): EventRow {
  return { ...s, id: s.event.id, seq: s.event.seq, pending: !s.syncedAt && !s.rejected ? 1 : 0 };
}

function fromRow(r: EventRow): StoredEvent {
  return { event: r.event, syncedAt: r.syncedAt, rejected: r.rejected };
}

export class LocalDb implements SyncStore {
  state: PosState = emptyState();
  meta: LocalMeta = { ...EMPTY_META };
  /** Resultado de navigator.storage.persist(); null = no soportado. */
  persisted: boolean | null = null;
  /** Último error de escritura en IndexedDB (cuota, permisos...). La UI lo muestra. */
  writeError: string | null = null;

  private events: StoredEvent[] = [];
  private config: DeviceConfig | null = null;
  private users: User[] = [];
  private priceLists: PriceList[] = DEFAULT_PRICE_LISTS;
  private parked: ParkedSale[] = [];
  private draft: unknown = null;
  private security: unknown = null;
  private cursor = 0;
  private queue: Promise<void> = Promise.resolve();
  private stateWriteScheduled = false;
  private errorListeners = new Set<(message: string) => void>();

  private constructor(private readonly dexie: PosDexie) {}

  static async open(opts: OpenOptions = {}): Promise<LocalDb> {
    const dexie = new PosDexie(opts.name ?? 'pos-inventario');
    await dexie.open();
    const db = new LocalDb(dexie);
    const legacy = opts.legacy !== undefined ? opts.legacy : typeof window !== 'undefined' ? window.localStorage : null;
    await db.load(legacy);
    return db;
  }

  /** Pide almacenamiento persistente para que el navegador no desaloje la base. */
  async requestPersistence(): Promise<boolean | null> {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage?.persist) return (this.persisted = null);
    try {
      this.persisted = (await storage.persisted?.()) || (await storage.persist());
    } catch {
      this.persisted = false;
    }
    return this.persisted;
  }

  onWriteError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private async load(legacy: Pick<Storage, 'getItem' | 'removeItem'> | null): Promise<void> {
    const version = await this.dexie.kv.get('schemaVersion');
    if (!version) {
      if (legacy && (legacy.getItem(LEGACY_KEYS.config) || legacy.getItem(LEGACY_KEYS.events))) await this.migrateFromLegacy(legacy);
      else await this.dexie.kv.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
    }
    const kv = new Map((await this.dexie.kv.toArray()).map((r) => [r.key, r.value]));
    this.config = (kv.get('config') as DeviceConfig | undefined) ?? null;
    this.state = (kv.get('state') as PosState | undefined) ?? emptyState();
    this.meta = { ...EMPTY_META, ...((kv.get('meta') as LocalMeta | undefined) ?? {}) };
    this.cursor = (kv.get('cursor') as number | undefined) ?? 0;
    this.users = (kv.get('users') as User[] | undefined) ?? [];
    this.priceLists = (kv.get('priceLists') as PriceList[] | undefined) ?? DEFAULT_PRICE_LISTS;
    this.parked = (kv.get('parked') as ParkedSale[] | undefined) ?? [];
    this.draft = kv.get('draft') ?? null;
    this.security = kv.get('security') ?? null;
    this.events = (await this.dexie.events.orderBy('seq').toArray()).map(fromRow);
    this.recover();
  }

  /** Importa la base antigua de localStorage en una sola transacción y luego la borra. */
  private async migrateFromLegacy(legacy: Pick<Storage, 'getItem' | 'removeItem'>): Promise<void> {
    const events = readLegacy<StoredEvent[]>(legacy, LEGACY_KEYS.events, []);
    const values: Array<[KvKey, unknown]> = [
      ['config', readLegacy(legacy, LEGACY_KEYS.config, null)],
      ['state', readLegacy(legacy, LEGACY_KEYS.state, emptyState())],
      ['meta', readLegacy(legacy, LEGACY_KEYS.meta, EMPTY_META)],
      ['cursor', readLegacy(legacy, LEGACY_KEYS.cursor, 0)],
      ['users', readLegacy(legacy, LEGACY_KEYS.users, [])],
      ['priceLists', readLegacy(legacy, LEGACY_KEYS.priceLists, DEFAULT_PRICE_LISTS)],
      ['parked', readLegacy(legacy, LEGACY_KEYS.parked, [])],
      ['draft', readLegacy(legacy, LEGACY_KEYS.draft, null)],
      ['schemaVersion', SCHEMA_VERSION],
    ];
    await this.dexie.transaction('rw', this.dexie.events, this.dexie.kv, this.dexie.audit, async () => {
      await this.dexie.events.bulkPut(events.map(toRow));
      await this.dexie.kv.bulkPut(values.map(([key, value]) => ({ key, value })));
      await this.dexie.audit.add({ at: new Date().toISOString(), type: 'storage_migrated', userId: null, detail: `${events.length} eventos migrados desde localStorage` });
    });
    for (const key of Object.values(LEGACY_KEYS)) legacy.removeItem(key);
  }

  /** Recuperación tras corte: aplica eventos locales registrados pero no proyectados. */
  private recover(): void {
    const config = this.config;
    if (!config) return;
    const applied = this.state.applied[config.deviceId] ?? 0;
    let changed = false;
    for (const s of this.events) {
      if (s.event.deviceId !== config.deviceId) continue;
      if (s.event.seq > applied) {
        applyEvent(this.state, s.event);
        changed = true;
      }
      if (s.event.seq > this.meta.lastSeq) {
        this.meta.lastSeq = s.event.seq;
        this.meta.lastHlc = s.event.hlc;
      }
    }
    if (changed) this.persistState();
  }

  // ------------------------------------------------------------ cola de escritura
  private enqueue(fn: () => Promise<unknown>): Promise<void> {
    const run = this.queue.then(fn).then(
      () => undefined,
      (err: unknown) => {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        this.writeError = message;
        for (const l of this.errorListeners) l(message);
      },
    );
    this.queue = run;
    return run;
  }

  /** Espera a que todo lo escrito en memoria sea durable en IndexedDB. */
  flush(): Promise<void> {
    return this.queue;
  }

  private putKv(key: KvKey, value: unknown): Promise<void> {
    return this.enqueue(() => this.dexie.kv.put({ key, value }));
  }

  /** Guarda la proyección; varias llamadas seguidas se agrupan en una sola escritura. */
  persistState(): void {
    if (this.stateWriteScheduled) return;
    this.stateWriteScheduled = true;
    void this.enqueue(async () => {
      this.stateWriteScheduled = false;
      await this.dexie.kv.put({ key: 'state', value: this.state });
    });
  }

  persistMeta(): void {
    void this.putKv('meta', this.meta);
  }

  // ------------------------------------------------------------ API de la caja
  getConfig(): DeviceConfig | null {
    return this.config;
  }

  setConfig(config: DeviceConfig): void {
    this.config = config;
    void this.putKv('config', config);
  }

  getUsers(): User[] {
    return this.users;
  }

  getPriceLists(): PriceList[] {
    return this.priceLists;
  }

  getSecurity<T>(): T | null {
    return (this.security as T | null) ?? null;
  }

  setSecurity(value: unknown): void {
    this.security = value;
    void this.putKv('security', value);
  }

  /** Inicializa la base local (snapshot del servidor o catálogo demo). */
  bootstrap(config: DeviceConfig, state: PosState, cursor: number, users: User[], priceLists: PriceList[]): Promise<void> {
    this.events = [];
    this.state = state;
    this.meta = { ...EMPTY_META };
    this.config = config;
    this.cursor = cursor;
    this.users = users;
    this.priceLists = priceLists;
    this.parked = [];
    this.draft = null;
    this.security = null;
    return this.enqueue(() =>
      this.dexie.transaction('rw', this.dexie.events, this.dexie.kv, async () => {
        await this.dexie.events.clear();
        await this.dexie.kv.clear();
        await this.dexie.kv.bulkPut([
          { key: 'schemaVersion', value: SCHEMA_VERSION },
          { key: 'config', value: config },
          { key: 'state', value: state },
          { key: 'meta', value: this.meta },
          { key: 'cursor', value: cursor },
          { key: 'users', value: users },
          { key: 'priceLists', value: priceLists },
          { key: 'parked', value: [] },
        ]);
      }),
    );
  }

  /** Registra un evento local y actualiza la proyección: el evento se escribe primero. */
  record(event: PosEvent, metaPatch: Partial<LocalMeta> = {}): void {
    const stored: StoredEvent = { event, syncedAt: null, rejected: null };
    this.events.push(stored);
    this.meta = { ...this.meta, ...metaPatch, lastSeq: event.seq, lastHlc: event.hlc };
    const meta = this.meta;
    void this.enqueue(() =>
      this.dexie.transaction('rw', this.dexie.events, this.dexie.kv, async () => {
        await this.dexie.events.add(toRow(stored));
        await this.dexie.kv.put({ key: 'meta', value: meta });
      }),
    );
    applyEvent(this.state, event);
    this.persistState();
  }

  setMeta(patch: Partial<LocalMeta>): void {
    this.meta = { ...this.meta, ...patch };
    this.persistMeta();
  }

  allEvents(): StoredEvent[] {
    return this.events;
  }

  getParked(): ParkedSale[] {
    return this.parked;
  }

  setParked(list: ParkedSale[]): void {
    this.parked = list;
    void this.putKv('parked', list);
  }

  getDraft<T>(): T | null {
    return (this.draft as T | null) ?? null;
  }

  setDraft(cart: unknown): void {
    this.draft = cart;
    void this.putKv('draft', cart);
  }

  appendAudit(entry: Omit<LocalAuditEntry, 'id' | 'at'>): void {
    void this.enqueue(() => this.dexie.audit.add({ ...entry, at: new Date().toISOString() }));
  }

  async getAudit(limit = 50): Promise<LocalAuditEntry[]> {
    await this.flush();
    return this.dexie.audit.orderBy('id').reverse().limit(limit).toArray();
  }

  reset(): Promise<void> {
    this.events = [];
    this.state = emptyState();
    this.meta = { ...EMPTY_META };
    this.config = null;
    this.cursor = 0;
    this.users = [];
    this.priceLists = DEFAULT_PRICE_LISTS;
    this.parked = [];
    this.draft = null;
    this.security = null;
    return this.enqueue(() =>
      this.dexie.transaction('rw', this.dexie.events, this.dexie.kv, async () => {
        await this.dexie.events.clear();
        await this.dexie.kv.clear();
        await this.dexie.kv.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
      }),
    );
  }

  close(): void {
    this.dexie.close();
  }

  // ------------------------------------------------------------ respaldo
  /** Respaldo completo. Incluye la credencial del dispositivo: tratar el archivo como secreto. */
  async exportBackup(): Promise<BackupFile> {
    await this.flush();
    this.appendAudit({ type: 'backup_exported', userId: null, detail: `${this.events.length} eventos` });
    return structuredClone({
      format: BACKUP_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      config: this.config,
      meta: this.meta,
      cursor: this.cursor,
      users: this.users,
      priceLists: this.priceLists,
      parked: this.parked,
      state: this.state,
      events: this.events,
    });
  }

  /** Reemplaza la base local por el respaldo. Lanza si el archivo no es válido. */
  async importBackup(input: unknown): Promise<void> {
    const b = parseBackup(input);
    await this.flush();
    this.config = b.config;
    this.meta = { ...EMPTY_META, ...b.meta };
    this.cursor = b.cursor;
    this.users = b.users;
    this.priceLists = b.priceLists;
    this.parked = b.parked;
    this.draft = null;
    this.security = null;
    this.state = b.state;
    this.events = [...b.events].sort((x, y) => x.event.seq - y.event.seq);
    this.writeError = null;
    await this.enqueue(() =>
      this.dexie.transaction('rw', this.dexie.events, this.dexie.kv, this.dexie.audit, async () => {
        await this.dexie.events.clear();
        await this.dexie.kv.clear();
        await this.dexie.events.bulkPut(this.events.map(toRow));
        await this.dexie.kv.bulkPut([
          { key: 'schemaVersion', value: SCHEMA_VERSION },
          { key: 'config', value: b.config },
          { key: 'state', value: b.state },
          { key: 'meta', value: this.meta },
          { key: 'cursor', value: b.cursor },
          { key: 'users', value: b.users },
          { key: 'priceLists', value: b.priceLists },
          { key: 'parked', value: b.parked },
        ]);
        await this.dexie.audit.add({ at: new Date().toISOString(), type: 'backup_imported', userId: null, detail: `Respaldo del ${b.exportedAt}, ${b.events.length} eventos` });
      }),
    );
    if (this.writeError) throw new Error(`No se pudo restaurar el respaldo: ${this.writeError}`);
    this.recover();
  }

  // ------------------------------------------------------------ SyncStore
  async getPendingEvents(limit: number): Promise<PosEvent[]> {
    await this.flush();
    return this.events
      .filter((s) => !s.syncedAt && !s.rejected)
      .sort((a, b) => a.event.seq - b.event.seq)
      .slice(0, limit)
      .map((s) => s.event);
  }

  async countPending(): Promise<number> {
    return this.events.filter((s) => !s.syncedAt && !s.rejected).length;
  }

  async markSynced(ids: string[], syncedAt: string): Promise<void> {
    const set = new Set(ids);
    const changed = this.events.filter((s) => set.has(s.event.id));
    for (const s of changed) s.syncedAt = syncedAt;
    await this.enqueue(() => this.dexie.events.bulkPut(changed.map(toRow)));
  }

  async markRejected(rejected: Array<{ id: string | null; reason: string }>): Promise<void> {
    const changed: StoredEvent[] = [];
    for (const r of rejected) {
      const s = this.events.find((x) => x.event.id === r.id);
      if (s) {
        s.rejected = r.reason;
        changed.push(s);
      }
    }
    await this.enqueue(() => this.dexie.events.bulkPut(changed.map(toRow)));
  }

  async getCursor(): Promise<number> {
    return this.cursor;
  }

  async applyRemoteEvents(events: ServerEvent[], cursor: number): Promise<void> {
    for (const e of events) applyEvent(this.state, e);
    this.cursor = cursor;
    const state = this.state;
    await this.enqueue(() =>
      this.dexie.transaction('rw', this.dexie.kv, async () => {
        await this.dexie.kv.bulkPut([
          { key: 'state', value: state },
          { key: 'cursor', value: cursor },
        ]);
      }),
    );
  }
}

/** Valida la estructura mínima de un archivo de respaldo. */
export function parseBackup(input: unknown): BackupFile {
  const b = input as Partial<BackupFile> | null;
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) throw new Error('El archivo no es un respaldo de POS Inventario');
  if (typeof b.schemaVersion !== 'number' || b.schemaVersion > SCHEMA_VERSION) {
    throw new Error('El respaldo es de una versión más nueva de la caja; actualiza antes de restaurar');
  }
  if (!Array.isArray(b.events) || !b.state || typeof b.state !== 'object' || !Array.isArray(b.users)) {
    throw new Error('El respaldo está incompleto o dañado');
  }
  for (const s of b.events) {
    if (!s?.event?.id || typeof s.event.seq !== 'number') throw new Error('El respaldo contiene eventos dañados');
  }
  return {
    format: BACKUP_FORMAT,
    schemaVersion: b.schemaVersion,
    exportedAt: String(b.exportedAt ?? ''),
    config: b.config ?? null,
    meta: { ...EMPTY_META, ...(b.meta ?? {}) },
    cursor: Number(b.cursor ?? 0),
    users: b.users,
    priceLists: b.priceLists ?? DEFAULT_PRICE_LISTS,
    parked: b.parked ?? [],
    state: b.state,
    events: b.events,
  };
}
