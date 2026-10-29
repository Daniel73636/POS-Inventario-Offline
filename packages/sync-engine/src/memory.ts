import { parseEvent, type PosEvent, type PullResponse, type PushResponse, type ServerEvent } from '@pos/contracts';
import type { FetchLike, SyncStore } from './client';
import { applyEvent, emptyState, type PosState } from './projection';

/**
 * Implementación de referencia del servidor de sincronización en memoria.
 * Misma semántica que la API real: ON CONFLICT (device_id, seq) DO NOTHING
 * y cursor global monótono (server_seq). Se usa en pruebas de convergencia.
 */
export class InMemorySyncServer {
  readonly log: ServerEvent[] = [];
  private readonly keys = new Set<string>();

  push(deviceId: string, events: unknown[]): PushResponse {
    const res: PushResponse = { accepted: [], duplicates: [], rejected: [], serverTime: new Date().toISOString(), cursor: 0 };
    for (const raw of events) {
      const parsed = parseEvent(raw);
      if (!parsed.ok) {
        res.rejected.push({ id: (raw as { id?: string })?.id ?? null, reason: parsed.error });
        continue;
      }
      const e = parsed.event;
      if (e.deviceId !== deviceId) {
        res.rejected.push({ id: e.id, reason: 'device_id no coincide con la credencial' });
        continue;
      }
      const key = `${e.deviceId}#${e.seq}`;
      if (this.keys.has(key)) {
        res.duplicates.push(e.id);
        continue;
      }
      this.keys.add(key);
      this.log.push({ ...e, serverSeq: this.log.length + 1 });
      res.accepted.push(e.id);
    }
    res.cursor = this.log.length;
    return res;
  }

  pull(cursor: number, limit = 500): PullResponse<ServerEvent> {
    const events = this.log.slice(cursor, cursor + limit);
    const next = cursor + events.length;
    return { events, cursor: next, hasMore: next < this.log.length, serverTime: new Date().toISOString() };
  }

  /** Proyección consolidada (lo que vería el panel del dueño). */
  state(): PosState {
    const s = emptyState();
    for (const e of this.log) applyEvent(s, e);
    return s;
  }

  /** Adaptador fetch para conectar un SyncClient real a este servidor (token = deviceId). */
  fetchFor(opts: { failRate?: number; random?: () => number; duplicateRate?: number } = {}): FetchLike {
    const rnd = opts.random ?? Math.random;
    return async (url, init) => {
      if (opts.failRate && rnd() < opts.failRate) throw new TypeError('Network request failed');
      const deviceId = (init?.headers?.authorization ?? '').replace('Bearer ', '');
      const u = new URL(url, 'http://local');
      let body: unknown;
      if (u.pathname === '/v1/sync/push') {
        const { events } = JSON.parse(init?.body ?? '{}') as { events: unknown[] };
        body = this.push(deviceId, events);
        // Simula reintento duplicado de la red (el servidor debe ignorarlo).
        if (opts.duplicateRate && rnd() < opts.duplicateRate) this.push(deviceId, events);
        // Simula respuesta perdida tras confirmar en el servidor.
        if (opts.failRate && rnd() < opts.failRate / 2) throw new TypeError('Respuesta perdida');
      } else if (u.pathname === '/v1/sync/pull') {
        body = this.pull(Number(u.searchParams.get('cursor') ?? 0), Number(u.searchParams.get('limit') ?? 500));
      } else {
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
      }
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
  }
}

/** Almacén local en memoria (útil para pruebas y como referencia de implementación). */
export class MemorySyncStore implements SyncStore {
  readonly events: Array<PosEvent & { syncedAt: string | null; rejected?: string }> = [];
  cursor = 0;

  constructor(readonly state: PosState = emptyState()) {}

  /** Registra un evento local y lo aplica a las proyecciones (atómico en memoria). */
  record(event: PosEvent): void {
    this.events.push({ ...event, syncedAt: null });
    applyEvent(this.state, event);
  }

  async getPendingEvents(limit: number): Promise<PosEvent[]> {
    return this.events
      .filter((e) => !e.syncedAt && !e.rejected)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map(({ syncedAt: _s, rejected: _r, ...e }) => e as PosEvent);
  }

  async countPending(): Promise<number> {
    return this.events.filter((e) => !e.syncedAt && !e.rejected).length;
  }

  async markSynced(ids: string[], syncedAt: string): Promise<void> {
    const set = new Set(ids);
    for (const e of this.events) if (set.has(e.id)) e.syncedAt = syncedAt;
  }

  async markRejected(rejected: Array<{ id: string | null; reason: string }>): Promise<void> {
    for (const r of rejected) {
      const e = this.events.find((x) => x.id === r.id);
      if (e) e.rejected = r.reason;
    }
  }

  async getCursor(): Promise<number> {
    return this.cursor;
  }

  async applyRemoteEvents(events: ServerEvent[], cursor: number): Promise<void> {
    for (const e of events) applyEvent(this.state, e);
    this.cursor = cursor;
  }
}
