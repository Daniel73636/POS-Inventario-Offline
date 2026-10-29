import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import { FiscalRangeRequestSchema, PushRequestSchema, type FiscalRange } from '@pos/contracts';
import { buildSnapshot, ingestEvents, pullEvents, type Database } from '@pos/db';
import { uuidv7 } from '@pos/sync-engine';
import { DB } from '../config';
import { parseBody, type AuthedRequest } from '../common/http';
import { DeviceGuard } from '../auth/guards';

@Controller('v1')
@UseGuards(DeviceGuard)
export class SyncController {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Sube un lote de eventos (máx. 200). Idempotente por (device_id, seq). */
  @Post('sync/push')
  @HttpCode(200)
  async push(@Req() req: AuthedRequest, @Body() body: unknown) {
    const { events } = parseBody(PushRequestSchema, body);
    return ingestEvents(this.db, req.device!, events);
  }

  /** Baja cambios desde el cursor global del tenant. */
  @Get('sync/pull')
  async pull(@Req() req: AuthedRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const c = Math.max(0, Number(cursor ?? 0) || 0);
    const l = Math.max(1, Number(limit ?? 500) || 500);
    return pullEvents(this.db, req.device!.tenantId, c, l);
  }

  /** Descarga inicial: catálogo, clientes, usuarios, stock y cursor coherente. */
  @Get('sync/snapshot')
  async snapshot(@Req() req: AuthedRequest) {
    return buildSnapshot(this.db, req.device!.tenantId, req.device!.storeId);
  }

  /**
   * Reserva un rango de numeración por dispositivo (stub del adaptador FiscalProvider).
   * El servidor es el árbitro de la unicidad; la caja consume el rango sin conexión.
   */
  @Post('fiscal/ranges')
  async reserveRange(@Req() req: AuthedRequest, @Body() body: unknown): Promise<FiscalRange> {
    const { size } = parseBody(FiscalRangeRequestSchema, body ?? {});
    const d = req.device!;
    return this.db.tx(async (q) => {
      await q.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [d.tenantId]);
      const [last] = await q.query<{ max: number | null }>('SELECT MAX(range_to) AS max FROM fiscal_ranges WHERE tenant_id = $1', [d.tenantId]);
      const from = Number(last?.max ?? 0) + 1;
      const to = from + size - 1;
      const id = uuidv7();
      await q.query(
        'INSERT INTO fiscal_ranges (id, tenant_id, store_id, device_id, prefix, range_from, range_to) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, d.tenantId, d.storeId, d.id, 'POS', from, to],
      );
      return {
        id,
        prefix: 'POS',
        from,
        to,
        resolution: 'STUB-DIAN-0000 (pruebas, no válido fiscalmente)',
        validUntil: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
      };
    });
  }
}
