import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { CreatePairingCodeSchema, RegisterDeviceRequestSchema, type RegisterDeviceResponse } from '@pos/contracts';
import { hashToken, newDeviceToken, type Database } from '@pos/db';
import { uuidv7 } from '@pos/sync-engine';
import { randomInt } from 'node:crypto';
import { DB } from '../config';
import { parseBody, type AuthedRequest } from '../common/http';
import { OwnerGuard } from '../auth/guards';

@Controller('v1/devices')
export class DevicesController {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Registro con código de emparejamiento; devuelve la credencial del dispositivo (una sola vez). */
  @Post('register')
  async register(@Body() body: unknown): Promise<RegisterDeviceResponse> {
    const input = parseBody(RegisterDeviceRequestSchema, body);
    return this.db.tx(async (q) => {
      const [code] = await q.query<{ tenant_id: string; store_id: string; uses_left: number; expires_at: string | null }>(
        'SELECT tenant_id, store_id, uses_left, expires_at FROM pairing_codes WHERE upper(code) = upper($1) FOR UPDATE',
        [input.pairingCode.trim()],
      );
      if (!code || code.uses_left <= 0 || (code.expires_at && new Date(code.expires_at) < new Date())) {
        throw new UnauthorizedException('Código de emparejamiento inválido o vencido');
      }
      await q.query('UPDATE pairing_codes SET uses_left = uses_left - 1 WHERE upper(code) = upper($1)', [input.pairingCode.trim()]);
      const deviceId = `dev_${uuidv7().replace(/-/g, '').slice(-16)}`;
      const token = newDeviceToken();
      await q.query(
        'INSERT INTO devices (id, tenant_id, store_id, name, platform, token_hash, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6, now())',
        [deviceId, code.tenant_id, code.store_id, input.name, input.platform, hashToken(token)],
      );
      const [t] = await q.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [code.tenant_id]);
      const [s] = await q.query<{ name: string }>('SELECT name FROM stores WHERE id = $1', [code.store_id]);
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
    const rows = await this.db.query<{
      id: string; name: string; platform: string; last_seq: number; created_at: string; last_seen_at: string | null; revoked_at: string | null; pending_hint: number;
    }>(
      `SELECT d.id, d.name, d.platform, d.last_seq, d.created_at, d.last_seen_at, d.revoked_at,
              (SELECT COUNT(*)::int FROM events e WHERE e.device_id = d.id) AS events
       FROM devices d WHERE d.tenant_id = $1 AND d.platform <> 'server' ORDER BY d.created_at DESC`,
      [req.owner!.tenantId],
    );
    return rows;
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @UseGuards(OwnerGuard)
  async revoke(@Req() req: AuthedRequest, @Param('id') id: string) {
    const rows = await this.db.query(
      'UPDATE devices SET revoked_at = now(), token_hash = NULL WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, req.owner!.tenantId],
    );
    if (!rows.length) throw new NotFoundException('Dispositivo no encontrado');
    return { id, revoked: true };
  }

  @Get('pairing-codes')
  @UseGuards(OwnerGuard)
  async codes(@Req() req: AuthedRequest) {
    return this.db.query(
      'SELECT code, uses_left, created_at, expires_at FROM pairing_codes WHERE tenant_id = $1 AND uses_left > 0 ORDER BY created_at DESC',
      [req.owner!.tenantId],
    );
  }

  @Post('pairing-codes')
  @UseGuards(OwnerGuard)
  async createCode(@Req() req: AuthedRequest, @Body() body: unknown) {
    const { uses } = parseBody(CreatePairingCodeSchema, body ?? {});
    const [store] = await this.db.query<{ id: string }>('SELECT id FROM stores WHERE tenant_id = $1 ORDER BY id LIMIT 1', [req.owner!.tenantId]);
    const code = `${randomInt(1000, 9999)}-${randomInt(1000, 9999)}`;
    await this.db.query(
      `INSERT INTO pairing_codes (code, tenant_id, store_id, uses_left, expires_at) VALUES ($1,$2,$3,$4, now() + interval '24 hours')`,
      [code, req.owner!.tenantId, store.id, uses],
    );
    return { code, uses, expiresInHours: 24 };
  }
}
