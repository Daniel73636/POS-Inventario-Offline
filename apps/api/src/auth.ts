import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hashToken, type Database } from '@pos/db';

export interface OwnerClaims {
  ownerId: string;
  tenantId: string;
  exp: number;
}

export interface DeviceRow {
  id: string;
  tenant_id: string;
  store_id: string;
  name: string;
  revoked_at: string | null;
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');

/** Token firmado HMAC-SHA256 (formato tipo JWT compacto) para el panel del dueño. */
export function signOwnerToken(secret: string, claims: Omit<OwnerClaims, 'exp'>, ttlSec = 8 * 3600): string {
  const body = b64(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyOwnerToken(secret: string, token: string): OwnerClaims | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as OwnerClaims;
  return claims.exp > Date.now() / 1000 ? claims : null;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

export async function requireDevice(db: Database, req: FastifyRequest, reply: FastifyReply): Promise<DeviceRow | null> {
  const token = bearer(req);
  if (!token) {
    await reply.code(401).send({ title: 'Falta credencial del dispositivo' });
    return null;
  }
  const [device] = await db.query<DeviceRow>('SELECT id, tenant_id, store_id, name, revoked_at FROM devices WHERE token_hash = $1', [hashToken(token)]);
  if (!device) {
    await reply.code(401).send({ title: 'Dispositivo no registrado' });
    return null;
  }
  if (device.revoked_at) {
    await reply.code(403).send({ title: 'Dispositivo revocado', wipe: true });
    return null;
  }
  return device;
}

export async function requireOwner(secret: string, req: FastifyRequest, reply: FastifyReply): Promise<OwnerClaims | null> {
  const token = bearer(req);
  const claims = token ? verifyOwnerToken(secret, token) : null;
  if (!claims) {
    await reply.code(401).send({ title: 'Sesión inválida o vencida' });
    return null;
  }
  return claims;
}
