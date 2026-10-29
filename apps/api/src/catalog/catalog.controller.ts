import { Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  CustomerSchema,
  ProductSchema,
  StockAdjustRequestSchema,
  StockReceiveRequestSchema,
  TAX_RATES_BP,
  type Customer,
  type Product,
} from '@pos/contracts';
import { emitServerEvents, type Database } from '@pos/db';
import { uuidv7 } from '@pos/sync-engine';
import { DB } from '../config';
import { parseBody, type AuthedRequest } from '../common/http';
import { OwnerGuard } from '../auth/guards';

const ProductCreateSchema = ProductSchema.omit({ id: true, taxRateBp: true }).extend({
  taxRateBp: ProductSchema.shape.taxRateBp.optional(),
});
const ProductUpdateSchema = ProductCreateSchema.partial();
const CustomerCreateSchema = CustomerSchema.omit({ id: true });

@Controller('v1')
@UseGuards(OwnerGuard)
export class CatalogController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get('products')
  async products(@Req() req: AuthedRequest, @Query('q') q?: string, @Query('includeInactive') includeInactive?: string) {
    const rows = await this.db.query<{ data: Product; cost_avg_cents: number; stock: number | null; updated_hlc: string }>(
      `SELECT p.data, p.cost_avg_cents, p.updated_hlc, COALESCE(s.qty, 0) AS stock
       FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id AND s.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1 AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%' OR p.sku ILIKE '%' || $2 || '%'
             OR EXISTS (SELECT 1 FROM barcodes b WHERE b.product_id = p.id AND b.barcode = $2))
         AND ($3::boolean OR p.active)
       ORDER BY p.category, p.name`,
      [req.owner!.tenantId, q?.trim() || null, includeInactive === 'true'],
    );
    return rows.map((r) => ({ ...r.data, costAvgCents: Number(r.cost_avg_cents), stock: Number(r.stock ?? 0), updatedHlc: r.updated_hlc }));
  }

  @Get('products/:id')
  async product(@Req() req: AuthedRequest, @Param('id') id: string) {
    const p = await this.loadProduct(req.owner!.tenantId, id);
    const movements = await this.db.query(
      `SELECT id, qty, unit_cost_cents, reason, ref_id, device_id, occurred_at FROM stock_movements
       WHERE tenant_id = $1 AND product_id = $2 ORDER BY occurred_at DESC LIMIT 50`,
      [req.owner!.tenantId, id],
    );
    const [stock] = await this.db.query<{ qty: number }>('SELECT COALESCE(SUM(qty),0) AS qty FROM stock_movements WHERE product_id = $1', [id]);
    return { ...p, stock: Number(stock?.qty ?? 0), movements };
  }

  private async loadProduct(tenantId: string, id: string): Promise<Product> {
    const [row] = await this.db.query<{ data: Product; cost_avg_cents: number }>(
      'SELECT data, cost_avg_cents FROM products WHERE id = $1 AND tenant_id = $2',
      [id, tenantId],
    );
    if (!row) throw new NotFoundException('Producto no encontrado');
    return { ...row.data, costAvgCents: Number(row.cost_avg_cents) };
  }

  private async assertBarcodesFree(tenantId: string, product: Product): Promise<void> {
    const codes = [...product.barcodes, ...product.packs.map((p) => p.barcode).filter(Boolean)] as string[];
    if (!codes.length) return;
    const taken = await this.db.query<{ barcode: string; product_id: string }>(
      'SELECT barcode, product_id FROM barcodes WHERE tenant_id = $1 AND barcode = ANY($2::text[]) AND product_id <> $3',
      [tenantId, codes, product.id],
    );
    if (taken.length) throw new ConflictException(`Código de barras ya asignado: ${taken.map((t) => t.barcode).join(', ')}`);
  }

  private normalize(input: Partial<Product> & { taxCode?: Product['taxCode'] }): Partial<Product> {
    const out = { ...input };
    if (input.taxCode && input.taxRateBp === undefined) out.taxRateBp = TAX_RATES_BP[input.taxCode];
    if (input.priceCents !== undefined) {
      const prices = (input.prices ?? []).filter((p) => !(p.priceListId === 'general' && p.minQty === 1 && !p.packId));
      out.prices = [{ priceListId: 'general', priceCents: input.priceCents, minQty: 1 }, ...prices];
    }
    return out;
  }

  @Post('products')
  async createProduct(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = parseBody(ProductCreateSchema, body);
    const product = ProductSchema.parse({
      ...this.normalize({ ...input, taxRateBp: input.taxRateBp ?? TAX_RATES_BP[input.taxCode] }),
      id: `prd_${uuidv7().replace(/-/g, '').slice(-12)}`,
    });
    await this.assertBarcodesFree(req.owner!.tenantId, product);
    await emitServerEvents(this.db, req.owner!.tenantId, [{ type: 'ProductUpserted', payload: { product } }]);
    return product;
  }

  @Put('products/:id')
  async updateProduct(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    const patch = parseBody(ProductUpdateSchema, body);
    const current = await this.loadProduct(req.owner!.tenantId, id);
    const merged = { ...current, ...this.normalize({ ...current, ...patch, prices: patch.prices ?? current.prices }), id };
    if (patch.taxCode && patch.taxRateBp === undefined) merged.taxRateBp = TAX_RATES_BP[patch.taxCode];
    const product = ProductSchema.parse(merged);
    await this.assertBarcodesFree(req.owner!.tenantId, product);
    await emitServerEvents(this.db, req.owner!.tenantId, [{ type: 'ProductUpserted', payload: { product } }]);
    return product;
  }

  /** Baja lógica: las ventas ya hechas conservan su copia congelada. */
  @Delete('products/:id')
  async deactivate(@Req() req: AuthedRequest, @Param('id') id: string) {
    const current = await this.loadProduct(req.owner!.tenantId, id);
    const product = { ...current, active: false };
    await emitServerEvents(this.db, req.owner!.tenantId, [{ type: 'ProductUpserted', payload: { product } }]);
    return product;
  }

  @Post('inventory/receipts')
  async receive(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = parseBody(StockReceiveRequestSchema, body);
    await this.loadProduct(req.owner!.tenantId, input.productId);
    const res = await emitServerEvents(this.db, req.owner!.tenantId, [
      { type: 'StockReceived', payload: { ...input, userId: req.owner!.ownerId } },
    ]);
    return { ok: true, eventIds: res.accepted };
  }

  @Post('inventory/adjustments')
  async adjust(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = parseBody(StockAdjustRequestSchema, body);
    await this.loadProduct(req.owner!.tenantId, input.productId);
    const res = await emitServerEvents(this.db, req.owner!.tenantId, [
      { type: 'StockAdjusted', payload: { ...input, userId: req.owner!.ownerId } },
    ]);
    return { ok: true, eventIds: res.accepted };
  }

  @Get('customers')
  async customers(@Req() req: AuthedRequest) {
    const rows = await this.db.query<{ data: Customer; balance: number }>(
      `SELECT c.data,
              COALESCE((SELECT SUM(sp.amount_cents) FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
                        WHERE s.customer_id = c.id AND sp.method = 'credit' AND s.status = 'completed'), 0) AS balance
       FROM customers c WHERE c.tenant_id = $1 ORDER BY c.name`,
      [req.owner!.tenantId],
    );
    return rows.map((r) => ({ ...r.data, creditBalanceCents: Number(r.balance) }));
  }

  @Post('customers')
  async createCustomer(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = parseBody(CustomerCreateSchema, body);
    const customer = CustomerSchema.parse({ ...input, id: `cus_${uuidv7().replace(/-/g, '').slice(-12)}` });
    await emitServerEvents(this.db, req.owner!.tenantId, [{ type: 'CustomerUpserted', payload: { customer } }]);
    return customer;
  }

  @Put('customers/:id')
  async updateCustomer(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    const patch = parseBody(CustomerCreateSchema.partial(), body);
    const [row] = await this.db.query<{ data: Customer }>('SELECT data FROM customers WHERE id = $1 AND tenant_id = $2', [id, req.owner!.tenantId]);
    if (!row) throw new NotFoundException('Cliente no encontrado');
    const customer = CustomerSchema.parse({ ...row.data, ...patch, id });
    await emitServerEvents(this.db, req.owner!.tenantId, [{ type: 'CustomerUpserted', payload: { customer } }]);
    return customer;
  }

  @Get('price-lists')
  async priceLists(@Req() req: AuthedRequest) {
    return this.db.query('SELECT id, name FROM price_lists WHERE tenant_id = $1 ORDER BY id', [req.owner!.tenantId]);
  }
}
