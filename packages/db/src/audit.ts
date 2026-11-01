import { createHash } from 'node:crypto';
import type { Queryable } from './adapter';

export const AUDIT_GENESIS = '0'.repeat(64);

export type AuditAction = 'venta_anulada' | 'descuento_autorizado' | 'ajuste_inventario' | 'cierre_con_diferencia';

export interface AuditEntryInput {
  tenantId: string;
  occurredAt: string;
  action: AuditAction;
  actorUserId: string | null;
  authorizedBy: string | null;
  deviceId: string | null;
  eventId: string | null;
  refId: string | null;
  data: Record<string, unknown>;
}

export interface AuditRow {
  seq: number;
  tenant_id: string;
  occurred_at: string | Date;
  action: string;
  actor_user_id: string | null;
  authorized_by: string | null;
  device_id: string | null;
  event_id: string | null;
  ref_id: string | null;
  data: Record<string, unknown> | string;
  prev_hash: string;
  hash: string;
  recorded_at?: string | Date;
}

/** JSON con llaves ordenadas: el hash no depende del orden en que JSONB devuelve las llaves. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

export function auditHash(prevHash: string, e: Omit<AuditEntryInput, 'occurredAt'> & { occurredAt: string }): string {
  const body = canonical({
    tenantId: e.tenantId,
    occurredAt: new Date(e.occurredAt).toISOString(),
    action: e.action,
    actorUserId: e.actorUserId,
    authorizedBy: e.authorizedBy,
    deviceId: e.deviceId,
    eventId: e.eventId,
    refId: e.refId,
    data: e.data,
  });
  return createHash('sha256').update(`${prevHash}|${body}`).digest('hex');
}

/**
 * Agrega una entrada al final de la cadena del tenant. Debe llamarse dentro de la
 * transacción de ingesta (que ya bloquea la fila del tenant) para serializar la cadena.
 */
export async function appendAudit(q: Queryable, e: AuditEntryInput): Promise<void> {
  const [last] = await q.query<{ hash: string }>('SELECT hash FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1', [e.tenantId]);
  const prev = last?.hash ?? AUDIT_GENESIS;
  const hash = auditHash(prev, e);
  await q.query(
    `INSERT INTO audit_log (tenant_id, occurred_at, action, actor_user_id, authorized_by, device_id, event_id, ref_id, data, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (event_id, action) DO NOTHING`,
    [e.tenantId, e.occurredAt, e.action, e.actorUserId, e.authorizedBy, e.deviceId, e.eventId, e.refId, JSON.stringify(e.data), prev, hash],
  );
}

/** Recorre la cadena del tenant y devuelve la primera entrada alterada, si la hay. */
export async function verifyAuditChain(q: Queryable, tenantId: string): Promise<{ ok: boolean; entries: number; brokenAtSeq: number | null }> {
  const rows = await q.query<AuditRow>('SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY seq', [tenantId]);
  let prev = AUDIT_GENESIS;
  for (const r of rows) {
    const data = typeof r.data === 'string' ? (JSON.parse(r.data) as Record<string, unknown>) : r.data;
    const expected = auditHash(prev, {
      tenantId: r.tenant_id,
      occurredAt: new Date(r.occurred_at).toISOString(),
      action: r.action as AuditAction,
      actorUserId: r.actor_user_id,
      authorizedBy: r.authorized_by,
      deviceId: r.device_id,
      eventId: r.event_id,
      refId: r.ref_id,
      data,
    });
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, entries: rows.length, brokenAtSeq: Number(r.seq) };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length, brokenAtSeq: null };
}
