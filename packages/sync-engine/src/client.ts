import {
  MAX_CLOCK_SKEW_MS,
  MAX_PUSH_BATCH,
  type PosEvent,
  type PullResponse,
  type PushResponse,
  type ServerEvent,
} from '@pos/contracts';
import type { HybridLogicalClock } from './hlc';

/** Persistencia local que el cliente necesita (IndexedDB, SQLite, memoria...). */
export interface SyncStore {
  /** Eventos locales pendientes (synced_at IS NULL), ordenados por seq. */
  getPendingEvents(limit: number): Promise<PosEvent[]>;
  countPending(): Promise<number>;
  markSynced(ids: string[], syncedAt: string): Promise<void>;
  markRejected(rejected: Array<{ id: string | null; reason: string }>): Promise<void>;
  getCursor(): Promise<number>;
  /** Aplica eventos remotos a las proyecciones y guarda el cursor (idealmente en una transacción). */
  applyRemoteEvents(events: ServerEvent[], cursor: number): Promise<void>;
}

export type SyncState = 'idle' | 'syncing' | 'synced' | 'pending' | 'offline' | 'error' | 'revoked';

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncAt: string | null;
  lastError: string | null;
  clockSkewMs: number;
  clockWarning: boolean;
}

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface SyncClientOptions {
  baseUrl: string;
  deviceId: string;
  getToken: () => string | null | Promise<string | null>;
  store: SyncStore;
  clock?: HybridLogicalClock;
  fetch?: FetchLike;
  /** Sondeo de respaldo (15–60 s recomendado). */
  intervalMs?: number;
  pullBatch?: number;
  timeoutMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
}

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

export class SyncClient {
  private status: SyncStatus = {
    state: 'idle',
    pending: 0,
    lastSyncAt: null,
    lastError: null,
    clockSkewMs: 0,
    clockWarning: false,
  };
  private listeners = new Set<(s: SyncStatus) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight: Promise<SyncStatus> | null = null;
  private failures = 0;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: SyncClientOptions) {
    const f = opts.fetch ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
    if (!f) throw new Error('No hay fetch disponible');
    this.fetchImpl = f.bind(globalThis) as FetchLike;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(listener: (s: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }

  /** Recalcula el contador de pendientes (llamar tras registrar un evento local). */
  async refreshPending(): Promise<void> {
    const pending = await this.opts.store.countPending();
    const state: SyncState =
      this.status.state === 'offline' || this.status.state === 'revoked' || this.status.state === 'syncing'
        ? this.status.state
        : pending > 0
          ? 'pending'
          : this.status.lastSyncAt
            ? 'synced'
            : this.status.state;
    this.setStatus({ pending, state });
  }

  private async request<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    const token = await this.opts.getToken();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), this.opts.timeoutMs ?? 15000);
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller?.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new SyncHttpError(res.status, text || `HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private observeServerTime(serverTime: string): void {
    const skew = Date.now() - Date.parse(serverTime);
    if (Number.isFinite(skew)) {
      this.setStatus({ clockSkewMs: skew, clockWarning: Math.abs(skew) > MAX_CLOCK_SKEW_MS });
    }
  }

  /** Sube eventos pendientes en lotes ordenados por seq. Reenviar es seguro (idempotente). */
  async push(): Promise<{ accepted: number; duplicates: number; rejected: number }> {
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    for (;;) {
      const batch = await this.opts.store.getPendingEvents(MAX_PUSH_BATCH);
      if (batch.length === 0) break;
      const res = await this.request<PushResponse>('/v1/sync/push', { method: 'POST', body: { events: batch } });
      this.observeServerTime(res.serverTime);
      const ok = [...res.accepted, ...res.duplicates];
      if (ok.length) await this.opts.store.markSynced(ok, res.serverTime);
      if (res.rejected.length) await this.opts.store.markRejected(res.rejected);
      accepted += res.accepted.length;
      duplicates += res.duplicates.length;
      rejected += res.rejected.length;
      if (ok.length + res.rejected.length === 0 || batch.length < MAX_PUSH_BATCH) break;
    }
    return { accepted, duplicates, rejected };
  }

  /** Baja eventos de otros dispositivos desde el cursor global. */
  async pull(): Promise<number> {
    let applied = 0;
    const limit = this.opts.pullBatch ?? 500;
    for (;;) {
      const cursor = await this.opts.store.getCursor();
      const res = await this.request<PullResponse<ServerEvent>>(`/v1/sync/pull?cursor=${cursor}&limit=${limit}`, {
        method: 'GET',
      });
      this.observeServerTime(res.serverTime);
      const foreign = res.events.filter((e) => e.deviceId !== this.opts.deviceId);
      for (const e of foreign) this.opts.clock?.receive(e.hlc);
      await this.opts.store.applyRemoteEvents(foreign, res.cursor);
      applied += foreign.length;
      if (!res.hasMore || res.cursor <= cursor) break;
    }
    return applied;
  }

  /** Un ciclo completo push + pull. Las llamadas concurrentes comparten la misma ejecución. */
  syncNow(): Promise<SyncStatus> {
    if (!this.inFlight) {
      this.inFlight = this.runCycle().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async runCycle(): Promise<SyncStatus> {
    this.setStatus({ state: 'syncing' });
    try {
      await this.push();
      await this.pull();
      this.failures = 0;
      const pending = await this.opts.store.countPending();
      this.setStatus({
        state: pending > 0 ? 'pending' : 'synced',
        pending,
        lastSyncAt: new Date().toISOString(),
        lastError: null,
      });
    } catch (err) {
      this.failures += 1;
      const pending = await this.opts.store.countPending().catch(() => this.status.pending);
      if (err instanceof SyncHttpError && (err.status === 401 || err.status === 403)) {
        this.setStatus({ state: 'revoked', pending, lastError: 'Dispositivo no autorizado o revocado' });
      } else if (err instanceof SyncHttpError) {
        this.setStatus({ state: 'error', pending, lastError: err.message.slice(0, 300) });
      } else {
        this.setStatus({ state: 'offline', pending, lastError: err instanceof Error ? err.message : String(err) });
      }
    }
    return this.status;
  }

  /** Espera con crecimiento exponencial y jitter tras fallos. */
  nextDelayMs(): number {
    const base = this.opts.intervalMs ?? 20000;
    if (this.failures === 0) return base;
    const max = this.opts.maxBackoffMs ?? 120000;
    const exp = Math.min(max, 2000 * 2 ** (this.failures - 1));
    const rnd = this.opts.random ?? Math.random;
    return Math.round(exp * (0.5 + rnd() / 2));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.syncNow();
      if (this.status.state === 'revoked') {
        this.running = false;
        return;
      }
      if (this.running) this.timer = setTimeout(loop, this.nextDelayMs());
    };
    void loop();
  }

  /** Programa una sincronización pronto (p. ej. tras una venta) sin bloquear la UI. */
  nudge(delayMs = 500): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.syncNow();
      if (this.running) this.timer = setTimeout(() => this.nudge(0), this.nextDelayMs());
    }, delayMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
