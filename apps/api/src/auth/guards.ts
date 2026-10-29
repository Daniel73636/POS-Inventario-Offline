import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { hashToken, type Database } from '@pos/db';
import type { AppConfig } from '../config';
import { CONFIG, DB } from '../config';
import type { AuthedRequest, OwnerAuth } from '../common/http';
import { verifyToken } from './token';

function bearer(req: AuthedRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

/** Credencial de dispositivo (token de larga vida, hash en la base). Revocado = 403. */
@Injectable()
export class DeviceGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Database) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    if (!token) throw new UnauthorizedException('Falta credencial de dispositivo');
    const [dev] = await this.db.query<{ id: string; tenant_id: string; store_id: string; name: string; revoked_at: string | null }>(
      'SELECT id, tenant_id, store_id, name, revoked_at FROM devices WHERE token_hash = $1',
      [hashToken(token)],
    );
    if (!dev) throw new UnauthorizedException('Credencial de dispositivo inválida');
    if (dev.revoked_at) throw new ForbiddenException('Dispositivo revocado');
    req.device = { id: dev.id, tenantId: dev.tenant_id, storeId: dev.store_id, name: dev.name };
    return true;
  }
}

/** Sesión del dueño (panel web). */
@Injectable()
export class OwnerGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    const payload = token ? verifyToken<OwnerAuth>(token, this.config.jwtSecret) : null;
    if (!payload?.tenantId) throw new UnauthorizedException('Inicia sesión como dueño');
    req.owner = { ownerId: payload.ownerId, tenantId: payload.tenantId, email: payload.email };
    return true;
  }
}
