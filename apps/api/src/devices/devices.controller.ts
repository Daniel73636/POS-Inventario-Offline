import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { CreatePairingCodeSchema, DEMO_PAIRING_CODE, RegisterDeviceRequestSchema, type RegisterDeviceResponse } from '@pos/contracts';
import { hashToken, newDeviceToken, newPairingCode, type Database } from '@pos/db';
import { uuidv7 } from '@pos/sync-engine';
import { CONFIG, DB, type AppConfig } from '../config';
import { parseBody, type AuthedRequest } from '../common/http';
import { RateLimitGuard } from '../common/rate-limit';
import { OwnerGuard } from '../auth/guards';

const INVALID_CODE = 'Código de emparejamiento inválido o vencido';

@Controller('v1/devices')
export class DevicesController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Registro con código de emparejamiento; devuelve la credencial del dispositivo (una sola vez). */
  @Post('register')
  @UseGuards(RateLimitGuard)
  async register(@Body() body: unknown): Promise<RegisterDeviceResponse> {
    const input = parseBody(RegisterDeviceRequestSchema, body);
    const pairingCode = input.pairingCode.trim().toUpperCase();
    if (!this.config.demoMode && pairingCode === DEMO_PAIRING_CODE) throw new UnauthorizedException(INVALID_CODE);
    return this.db.tx(async (q) => {
      const [code] = await q.query<{ tenant_id: string; store_id: string; uses_left: number; expires_at: string | null }>(
        'SELECT tenant_id, store_id, uses_left, expires_at FROM pairing_codes WHERE upper(code) = $1 FOR UPDATE',
        [pairingCode],
      );
      // Fuera de demo todo código debe tener caducidad: los códigos sin vencimiento sólo existen en el seed demo.
      const expired = code?.expires_at ? new Date(code.expires_at) < new Date() : !this.config.demoMode;
      if (!code || code.uses_left <= 0 || expired) throw new UnauthorizedException(INVALID_CODE);
      await q.query('UPDATE pairing_codes SET uses_left = uses_left - 1 WHERE upper(code) = $1', [pairingCode]);
      const deviceId = `dev_${uuidv7().replace(/-/g, '').slice(-16)}`;
      const token = newDeviceToken();
      await q.query(
        'INSERT INTO devices (id, tenant_id, store_id, name, platform, token_hash, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6, now())',
        [deviceId, code.tenant_id, code.store_id, input.name, input.platform, hashToken(token)],
      );
      const [t] = await q.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [code.tenant_id]);
      const [s] = await q.query<{ name: string }>('SELECT name FROM stores WHERE id = $1 AND tenant_id = $2', [code.store_id, code.tenant_id]);
      return {
        deviceId,
        deviceToken: token,
        tenantId: code.tenant_id,
        tenantName: t?.name ?? '',
        storeId: code.store_id,
        storeName: s?.name ?? '',
        serverTime: new Date().toISOString(),
      };
    });
  }

  @Get()
  @UseGuards(OwnerGuard)
  async list(@Req() req: AuthedRequest) {
    return this.db.query(
      `SELECT d.id, d.name, d.platform, d.last_seq, d.created_at, d.last_seen_at, d.revoked_at,
              (SELECT COUNT(*)::int FROM events e WHERE e.device_id = d.id AND e.tenant_id = d.tenant_id) AS events
       FROM devices d WHERE d.tenant_id = $1 AND d.platform <> 'server' ORDER BY d.created_at DESC`,
      [req.owner!.tenantId],
    );
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @UseGuards(OwnerGuard)
  async revoke(@Req() req: AuthedRequest, @Param('id') id: string) {
    const rows = await this.db.query(
      `UPDATE devices SET revoked_at = now(), token_hash = NULL WHERE id = $1 AND tenant_id = $2 AND platform <> 'server' RETURNING id`,
      [id, req.owner!.tenantId],
    );
    if (!rows.length) throw new NotFoundException('Dispositivo no encontrado');
    return { id, revoked: true };
  }

  @Get('pairing-codes')
  @UseGuards(OwnerGuard)
  async codes(@Req() req: AuthedRequest) {
    return this.db.query(
      `SELECT code, uses_left, created_at, expires_at FROM pairing_codes
       WHERE tenant_id = $1 AND uses_left > 0 AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC`,
      [req.owner!.tenantId],
    );
  }

  /** Fuera de demo los códigos son de un solo uso y vencen en 24 h. */
  @Post('pairing-codes')
  @UseGuards(OwnerGuard)
  async createCode(@Req() req: AuthedRequest, @Body() body: unknown) {
    const requested = parseBody(CreatePairingCodeSchema, body ?? {}).uses;
    const uses = this.config.demoMode ? requested : 1;
    const [store] = await this.db.query<{ id: string }>('SELECT id FROM stores WHERE tenant_id = $1 ORDER BY id LIMIT 1', [req.owner!.tenantId]);
    if (!store) throw new NotFoundException('La empresa no tiene tiendas');
    const code = newPairingCode();
    await this.db.query(
      `INSERT INTO pairing_codes (code, tenant_id, store_id, uses_left, expires_at) VALUES ($1,$2,$3,$4, now() + interval '24 hours')`,
      [code, req.owner!.tenantId, store.id, uses],
    );
    return { code, uses, expiresInHours: 24 };
  }
}
