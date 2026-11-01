import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Post, Query, Req, UseGuards } from '@nestjs/common';
import { FiscalRangeRequestSchema, PushRequestSchema, type FiscalRange } from '@pos/contracts';
import { buildSnapshot, ingestEvents, pullEvents, type Database } from '@pos/db';
import { uuidv7 } from '@pos/sync-engine';
import { z } from 'zod';
import { DB } from '../config';
import { parseBody, type AuthedRequest } from '../common/http';
import { DeviceGuard } from '../auth/guards';
import { FACTURACION, type FacturacionProvider, type ResultadoFacturacion } from '../fiscal/facturacion';

const FiscalDocumentRequestSchema = z.object({ saleId: z.string().min(1) });

@Controller('v1')
@UseGuards(DeviceGuard)
export class SyncController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(FACTURACION) private readonly facturacion: FacturacionProvider,
  ) {}

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
   * Reserva un rango de numeración por dispositivo.
   * El servidor es el árbitro de la unicidad; la caja consume el rango sin conexión.
   */
  @Post('fiscal/ranges')
  async reserveRange(@Req() req: AuthedRequest, @Body() body: unknown): Promise<FiscalRange & { validezLegal: boolean }> {
    const { size } = parseBody(FiscalRangeRequestSchema, body ?? {});
    const d = req.device!;
    const res = await this.facturacion.resolucion(d.tenantId);
    return this.db.tx(async (q) => {
      await q.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [d.tenantId]);
      const [last] = await q.query<{ max: number | null }>('SELECT MAX(range_to) AS max FROM fiscal_ranges WHERE tenant_id = $1', [d.tenantId]);
      const from = Number(last?.max ?? 0) + 1;
      const to = from + size - 1;
      const id = uuidv7();
      await q.query(
        'INSERT INTO fiscal_ranges (id, tenant_id, store_id, device_id, prefix, range_from, range_to) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, d.tenantId, d.storeId, d.id, res.prefijo, from, to],
      );
      return {
        id,
        prefix: res.prefijo,
        from,
        to,
        resolution: `${res.numeroResolucion}${this.facturacion.validezLegal ? '' : ' (simulador, sin validez fiscal)'}`,
        validUntil: res.vigenteHasta,
        validezLegal: this.facturacion.validezLegal,
      };
    });
  }

  /** Envía una venta sincronizada al proveedor de facturación configurado. */
  @Post('fiscal/documents')
  @HttpCode(200)
  async emitDocument(@Req() req: AuthedRequest, @Body() body: unknown): Promise<ResultadoFacturacion> {
    const { saleId } = parseBody(FiscalDocumentRequestSchema, body);
    const tenantId = req.device!.tenantId;
    const [sale] = await this.db.query<{ local_number: number; occurred_at: string; total_cents: number; tax_cents: number; customer_id: string | null; status: string }>(
      'SELECT local_number, occurred_at, total_cents, tax_cents, customer_id, status FROM sales WHERE tenant_id = $1 AND id = $2',
      [tenantId, saleId],
    );
    if (!sale) throw new NotFoundException('Venta no encontrada (¿ya se sincronizó?)');
    const items = await this.db.query<{ name: string; qty: number; unit_price_cents: number; tax_rate_bp: number; line_total_cents: number }>(
      'SELECT name, qty, unit_price_cents, tax_rate_bp, line_total_cents FROM sale_items WHERE tenant_id = $1 AND sale_id = $2 ORDER BY id',
      [tenantId, saleId],
    );
    const [customer] = sale.customer_id
      ? await this.db.query<{ name: string; data: { docId?: string | null } }>('SELECT name, data FROM customers WHERE tenant_id = $1 AND id = $2', [tenantId, sale.customer_id])
      : [];
    return this.facturacion.emitirFactura(tenantId, {
      saleId,
      numero: Number(sale.local_number),
      fechaEmision: new Date(sale.occurred_at).toISOString(),
      cliente: customer ? { nombre: customer.name, documento: customer.data.docId ?? null } : null,
      subtotalCents: Number(sale.total_cents) - Number(sale.tax_cents),
      impuestosCents: Number(sale.tax_cents),
      totalCents: Number(sale.total_cents),
      lineas: items.map((i) => ({
        descripcion: i.name,
        cantidad: Number(i.qty),
        valorUnitarioCents: Number(i.unit_price_cents),
        tarifaImpuestoBp: i.tax_rate_bp,
        totalCents: Number(i.line_total_cents),
      })),
    });
  }
}
