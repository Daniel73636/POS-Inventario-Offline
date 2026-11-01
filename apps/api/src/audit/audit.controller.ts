import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { verifyAuditChain, type Database } from '@pos/db';
import { DB } from '../config';
import type { AuthedRequest } from '../common/http';
import { OwnerGuard } from '../auth/guards';

/** Registro de auditoría (sólo lectura para el dueño; la base impide modificarlo). */
@Controller('v1/audit')
@UseGuards(OwnerGuard)
export class AuditController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  async list(@Req() req: AuthedRequest, @Query('action') action?: string, @Query('limit') limit?: string) {
    const l = Math.min(500, Math.max(1, Number(limit ?? 200) || 200));
    return this.db.query(
      `SELECT a.seq, a.occurred_at, a.recorded_at, a.action, a.actor_user_id, ua.name AS actor_name,
              a.authorized_by, ub.name AS authorized_by_name, a.device_id, d.name AS device_name, a.ref_id, a.data, a.hash
       FROM audit_log a
       LEFT JOIN users ua ON ua.id = a.actor_user_id AND ua.tenant_id = a.tenant_id
       LEFT JOIN users ub ON ub.id = a.authorized_by AND ub.tenant_id = a.tenant_id
       LEFT JOIN devices d ON d.id = a.device_id AND d.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1 AND ($2::text IS NULL OR a.action = $2)
       ORDER BY a.seq DESC LIMIT $3`,
      [req.owner!.tenantId, action?.trim() || null, l],
    );
  }

  /** Recalcula la cadena de hashes: detecta filas alteradas directamente en la base. */
  @Get('verify')
  async verify(@Req() req: AuthedRequest) {
    return verifyAuditChain(this.db, req.owner!.tenantId);
  }
}
