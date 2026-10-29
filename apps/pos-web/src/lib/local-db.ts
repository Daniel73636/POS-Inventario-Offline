import type { PosEvent, PriceList, ServerEvent, User } from '@pos/contracts';
import { applyEvent, emptyState, type PosState, type SyncStore } from '@pos/sync-engine';

/**
 * Base local del navegador sobre localStorage.
 * - Registro de eventos inmutable (fuente de verdad del dispositivo).
 * - Proyección (PosState) derivada; si la pestaña se cierra entre escribir el
 *   evento y la proyección, al arrancar se re-aplican los eventos faltantes.
 * Ruta de producción: Tauri + SQLite (SQLCipher) con la misma interfaz SyncStore.
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

const K = {
  config: 'pos:config',
  events: 'pos:events',
  state: 'pos:state',
  cursor: 'pos:cursor',
  meta: 'pos:meta',
  users: 'pos:users',
  priceLists: 'pos:priceLists',
  parked: 'pos:parked',
  draft: 'pos:draft',
};

export interface LocalMeta {
  lastSeq: number;
  lastHlc: string | null;
  saleNumber: number;
  sessionId: string | null;
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  window.localStorage.setItem(key, JSON.stringify(value));
}

export class LocalDb implements SyncStore {
  state: PosState;
  private events: StoredEvent[];
  meta: LocalMeta;

  constructor() {
    this.events = read<StoredEvent[]>(K.events, []);
    this.state = read<PosState>(K.state, emptyState());
    this.meta = read<LocalMeta>(K.meta, { lastSeq: 0, lastHlc: null, saleNumber: 0, sessionId: null });
    this.recover();
  }

  /** Recuperación tras corte: aplica eventos locales registrados pero no proyectados. */
  private recover(): void {
    const config = this.getConfig();
    if (!config) return;
    const applied = this.state.applied[config.deviceId] ?? 0;
    let changed = false;
    for (const s of this.events) {
      if (s.event.deviceId === config.deviceId && s.event.seq > applied) {
        applyEvent(this.state, s.event);
        changed = true;
      }
      if (s.event.deviceId === config.deviceId && s.event.seq > this.meta.lastSeq) {
        this.meta.lastSeq = s.event.seq;
        this.meta.lastHlc = s.event.hlc;
      }
    }
    if (changed) this.persistState();
  }

  getConfig(): DeviceConfig | null {
    return read<DeviceConfig | null>(K.config, null);
  }

  setConfig(config: DeviceConfig): void {
    write(K.config, config);
  }

  getUsers(): User[] {
    return read<User[]>(K.users, []);
  }

  getPriceLists(): PriceList[] {
    return read<PriceList[]>(K.priceLists, [{ id: 'general', name: 'General' }]);
  }

  /** Inicializa la base local (snapshot del servidor o catálogo demo). */
  bootstrap(config: DeviceConfig, state: PosState, cursor: number, users: User[], priceLists: PriceList[]): void {
    this.events = [];
    this.state = state;
    this.meta = { lastSeq: 0, lastHlc: null, saleNumber: 0, sessionId: null };
    write(K.config, config);
    write(K.events, this.events);
    write(K.cursor, cursor);
    write(K.users, users);
    write(K.priceLists, priceLists);
    write(K.parked, []);
    this.persistState();
    this.persistMeta();
  }

  /** Registra un evento local y actualiza la proyección: el evento se escribe primero. */
  record(event: PosEvent, metaPatch: Partial<LocalMeta> = {}): void {
    this.events.push({ event, syncedAt: null, rejected: null });
    write(K.events, this.events);
    this.meta = { ...this.meta, ...metaPatch, lastSeq: event.seq, lastHlc: event.hlc };
    this.persistMeta();
    applyEvent(this.state, event);
    this.persistState();
  }

  persistState(): void {
    write(K.state, this.state);
  }

  persistMeta(): void {
    write(K.meta, this.meta);
  }

  setMeta(patch: Partial<LocalMeta>): void {
    this.meta = { ...this.meta, ...patch };
    this.persistMeta();
  }

  allEvents(): StoredEvent[] {
    return this.events;
  }

  getParked(): ParkedSale[] {
    return read<ParkedSale[]>(K.parked, []);
  }

  setParked(list: ParkedSale[]): void {
    write(K.parked, list);
  }

  getDraft<T>(): T | null {
    return read<T | null>(K.draft, null);
  }

  setDraft(cart: unknown): void {
    write(K.draft, cart);
  }

  reset(): void {
    for (const key of Object.values(K)) window.localStorage.removeItem(key);
    this.events = [];
    this.state = emptyState();
    this.meta = { lastSeq: 0, lastHlc: null, saleNumber: 0, sessionId: null };
  }

  // ------------------------------------------------------------ SyncStore
  async getPendingEvents(limit: number): Promise<PosEvent[]> {
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
    for (const s of this.events) if (set.has(s.event.id)) s.syncedAt = syncedAt;
    write(K.events, this.events);
  }

  async markRejected(rejected: Array<{ id: string | null; reason: string }>): Promise<void> {
    for (const r of rejected) {
      const s = this.events.find((x) => x.event.id === r.id);
      if (s) s.rejected = r.reason;
    }
    write(K.events, this.events);
  }

  async getCursor(): Promise<number> {
    return read<number>(K.cursor, 0);
  }

  async applyRemoteEvents(events: ServerEvent[], cursor: number): Promise<void> {
    for (const e of events) applyEvent(this.state, e);
    this.persistState();
    write(K.cursor, cursor);
  }
}
