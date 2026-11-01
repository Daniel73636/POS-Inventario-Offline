import {
  MAX_PULL_BATCH,
  parseEvent,
  type Customer,
  type EventPayload,
  type EventType,
  type PosEvent,
  type Product,
  type PullResponse,
  type PushResponse,
  type ServerEvent,
  type SnapshotResponse,
} from '@pos/contracts';
import { HybridLogicalClock, uuidv7 } from '@pos/sync-engine';
import type { Database, Queryable } from './adapter';
import { projectEvent } from './projector';

export interface DeviceIdentity {
  id: string;
  tenantId: string;
  storeId: string;
}

/**
 * Ingesta idempotente de un lote de eventos de un dispositivo.
 * - Valida cada evento con Zod; los inválidos se rechazan con motivo.
 * - Bloquea la fila del tenant: el cursor global (server_seq) avanza en orden de commit,
 *   así un pull nunca se salta eventos de transacciones concurrentes.
 * - (device_id, seq) único: reenviar un evento nunca lo duplica.
 */
export async function ingestEventsTx(q: Queryable, device: DeviceIdentity, rawEvents: unknown[]): Promise<PushResponse> {
  const res: PushResponse = { accepted: [], duplicates: [], rejected: [], serverTime: new Date().toISOString(), cursor: 0 };
  const valid: PosEvent[] = [];
  for (const raw of rawEvents) {
    const parsed = parseEvent(raw);
    const rawId = typeof raw === 'object' && raw && 'id' in raw ? String((raw as { id: unknown }).id) : null;
    if (!parsed.ok) {
      res.rejected.push({ id: rawId, reason: parsed.error });
      continue;
    }
    const e = parsed.event;
    if (e.deviceId !== device.id || e.tenantId !== device.tenantId || e.storeId !== device.storeId) {
      res.rejected.push({ id: e.id, reason: 'El evento no corresponde a la credencial del dispositivo' });
      continue;
    }
    valid.push(e);
  }
  valid.sort((a, b) => a.seq - b.seq);

  const [tenant] = await q.query<{ server_seq: number }>('SELECT server_seq FROM tenants WHERE id = $1 FOR UPDATE', [device.tenantId]);
  if (!tenant) throw new Error(`Tenant ${device.tenantId} no existe`);
  let serverSeq = Number(tenant.server_seq);
  let maxSeq = 0;

  for (const e of valid) {
    const [dup] = await q.query<{ id: string }>('SELECT id FROM events WHERE device_id = $1 AND seq = $2', [e.deviceId, e.seq]);
    if (dup) {
      if (dup.id === e.id) res.duplicates.push(e.id);
      else res.rejected.push({ id: e.id, reason: `seq ${e.seq} ya usado por otro evento del dispositivo` });
      continue;
    }
    const [sameId] = await q.query('SELECT 1 FROM events WHERE id = $1', [e.id]);
    if (sameId) {
      res.rejected.push({ id: e.id, reason: 'id de evento repetido' });
      continue;
    }
    serverSeq += 1;
    await q.query(
      `INSERT INTO events (id, server_seq, tenant_id, store_id, device_id, seq, hlc, type, payload, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.id, serverSeq, e.tenantId, e.storeId, e.deviceId, e.seq, e.hlc, e.type, JSON.stringify(e.payload), e.occurredAt],
    );
    await projectEvent(q, e);
    res.accepted.push(e.id);
    maxSeq = Math.max(maxSeq, e.seq);
  }

  await q.query('UPDATE tenants SET server_seq = $2 WHERE id = $1', [device.tenantId, serverSeq]);
  await q.query('UPDATE devices SET last_seq = GREATEST(last_seq, $2), last_seen_at = now() WHERE id = $1', [device.id, maxSeq]);
  res.cursor = serverSeq;
  return res;
}

export function ingestEvents(db: Database, device: DeviceIdentity, rawEvents: unknown[]): Promise<PushResponse> {
  return db.tx((q) => ingestEventsTx(q, device, rawEvents));
}

export async function pullEvents(db: Database, tenantId: string, cursor: number, limit = MAX_PULL_BATCH): Promise<PullResponse<ServerEvent>> {
  const lim = Math.max(1, Math.min(limit, MAX_PULL_BATCH));
  const rows = await db.query<{
    id: string; server_seq: number; tenant_id: string; store_id: string; device_id: string; seq: number; hlc: string; type: string; payload: unknown; occurred_at: Date | string;
  }>(
    `SELECT id, server_seq, tenant_id, store_id, device_id, seq, hlc, type, payload, occurred_at
     FROM events WHERE tenant_id = $1 AND server_seq > $2 ORDER BY server_seq LIMIT $3`,
    [tenantId, cursor, lim + 1],
  );
  const hasMore = rows.length > lim;
  const page = rows.slice(0, lim);
  const events = page.map(
    (r) =>
      ({
        id: r.id,
        serverSeq: Number(r.server_seq),
        tenantId: r.tenant_id,
        storeId: r.store_id,
        deviceId: r.device_id,
        seq: Number(r.seq),
        hlc: r.hlc,
        type: r.type,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
        occurredAt: new Date(r.occurred_at).toISOString(),
      }) as ServerEvent,
  );
  return {
    events,
    cursor: page.length ? Number(page[page.length - 1].server_seq) : cursor,
    hasMore,
    serverTime: new Date().toISOString(),
  };
}

export async function buildSnapshot(db: Database, tenantId: string, storeId: string): Promise<SnapshotResponse> {
  return db.tx(async (q) => {
    // Bloqueo compartido del cursor: el snapshot es coherente con server_seq.
    const [tenant] = await q.query<{ id: string; name: string; server_seq: number }>(
      'SELECT id, name, server_seq FROM tenants WHERE id = $1 FOR SHARE',
      [tenantId],
    );
    if (!tenant) throw new Error('Tenant no existe');
    const [store] = await q.query<{ id: string; name: string }>('SELECT id, name FROM stores WHERE id = $1', [storeId]);
    const products = await q.query<{ data: Product; cost_avg_cents: number; updated_hlc: string }>(
      'SELECT data, cost_avg_cents, updated_hlc FROM products WHERE tenant_id = $1 ORDER BY name',
      [tenantId],
    );
    const customers = await q.query<{ data: Customer }>('SELECT data FROM customers WHERE tenant_id = $1 ORDER BY name', [tenantId]);
    const users = await q.query<{ id: string; name: string; role: 'cashier' | 'supervisor' | 'owner'; pin_hash: string }>(
      'SELECT id, name, role, pin_hash FROM users WHERE tenant_id = $1 ORDER BY name',
      [tenantId],
    );
    const priceLists = await q.query<{ id: string; name: string }>('SELECT id, name FROM price_lists WHERE tenant_id = $1 ORDER BY id', [tenantId]);
    const stock = await q.query<{ product_id: string; qty: number }>(
      'SELECT product_id, qty FROM stock_levels WHERE tenant_id = $1 AND store_id = $2',
      [tenantId, storeId],
    );
    const lots = await q.query<{ product_id: string; lot_code: string; qty: number; expires_on: string | Date | null }>(
      `SELECT product_id, lot_code, SUM(qty) AS qty, MAX(expires_on) AS expires_on
       FROM stock_movements
       WHERE tenant_id = $1 AND store_id = $2 AND lot_code IS NOT NULL
       GROUP BY product_id, lot_code
       HAVING SUM(qty) <> 0`,
      [tenantId, storeId],
    );
    return {
      tenant: { id: tenant.id, name: tenant.name },
      store: { id: store?.id ?? storeId, name: store?.name ?? storeId },
      priceLists,
      products: products.map((p) => ({ ...p.data, costAvgCents: Number(p.cost_avg_cents), updatedHlc: p.updated_hlc })),
      customers: customers.map((c) => c.data),
      users: users.map((u) => ({ id: u.id, name: u.name, role: u.role, pinHash: u.pin_hash })),
      stock: stock.map((s) => ({ productId: s.product_id, qty: Number(s.qty) })),
      lots: lots.map((l) => ({
        productId: l.product_id,
        lotId: l.lot_code,
        qty: Number(l.qty),
        expiresOn: l.expires_on instanceof Date ? l.expires_on.toISOString().slice(0, 10) : l.expires_on ? String(l.expires_on).slice(0, 10) : null,
      })),
      cursor: Number(tenant.server_seq),
      serverTime: new Date().toISOString(),
    };
  });
}

export function serverDeviceId(tenantId: string): string {
  return `srv_${tenantId}`;
}

const clocks = new Map<string, HybridLogicalClock>();

/**
 * Emite eventos originados en el servidor (panel web): mismo camino que un dispositivo,
 * así las cajas los reciben por pull y se aplican con las mismas reglas.
 */
export async function emitServerEvents(
  db: Database,
  tenantId: string,
  items: Array<{ type: EventType; payload: EventPayload<EventType> }>,
): Promise<PushResponse> {
  const deviceId = serverDeviceId(tenantId);
  return db.tx(async (q) => {
    const [dev] = await q.query<{ last_seq: number; store_id: string }>(
      'SELECT last_seq, store_id FROM devices WHERE id = $1 FOR UPDATE',
      [deviceId],
    );
    if (!dev) throw new Error(`No existe el dispositivo servidor para ${tenantId}`);
    let clock = clocks.get(tenantId);
    if (!clock) {
      const [last] = await q.query<{ hlc: string | null }>('SELECT MAX(hlc) AS hlc FROM events WHERE tenant_id = $1', [tenantId]);
      clock = new HybridLogicalClock(deviceId, () => Date.now(), last?.hlc ?? null);
      clocks.set(tenantId, clock);
    }
    let seq = Number(dev.last_seq);
    const now = new Date();
    const events = items.map((it) => ({
      id: uuidv7(now.getTime()),
      tenantId,
      storeId: dev.store_id,
      deviceId,
      seq: ++seq,
      hlc: clock!.now(),
      type: it.type,
      payload: it.payload,
      occurredAt: now.toISOString(),
    }));
    const res = await ingestEventsTx(q, { id: deviceId, tenantId, storeId: dev.store_id }, events);
    if (res.rejected.length) throw new Error(`Evento de servidor inválido: ${res.rejected.map((r) => r.reason).join('; ')}`);
    return res;
  });
}
