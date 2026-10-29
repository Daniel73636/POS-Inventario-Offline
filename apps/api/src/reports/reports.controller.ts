import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Database } from '@pos/db';
import { CONFIG, DB, type AppConfig } from '../config';
import type { AuthedRequest } from '../common/http';
import { OwnerGuard } from '../auth/guards';

/** Fecha local del negocio (YYYY-MM-DD). */
function localDate(tz: string, d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Filtro de rango: $2 = desde, $3 = hasta (incluido), $4 = zona horaria.
const RANGE = `s.occurred_at >= ($2::date)::timestamp AT TIME ZONE $4 AND s.occurred_at < (($3::date + 1))::timestamp AT TIME ZONE $4`;

@Controller('v1')
@UseGuards(OwnerGuard)
export class ReportsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private range(req: AuthedRequest, from?: string, to?: string): [string, string, string, string] {
    const today = localDate(this.config.timezone);
    const f = from && DATE_RE.test(from) ? from : today;
    const t = to && DATE_RE.test(to) ? to : f > today ? f : today;
    return [req.owner!.tenantId, f, t < f ? f : t, this.config.timezone];
  }

  @Get('reports/dashboard')
  async dashboard(@Req() req: AuthedRequest, @Query('from') from?: string, @Query('to') to?: string) {
    const p = this.range(req, from, to);
    const [totals] = await this.db.query<Record<string, number>>(
      `SELECT COUNT(*)::int AS sales, COALESCE(SUM(total_cents),0) AS total_cents, COALESCE(SUM(tax_cents),0) AS tax_cents,
              COALESCE(SUM(discount_cents),0) AS discount_cents
       FROM sales s WHERE s.tenant_id = $1 AND s.status = 'completed' AND ${RANGE}`,
      p,
    );
    const [profit] = await this.db.query<Record<string, number>>(
      `SELECT COALESCE(SUM(i.line_total_cents - i.tax_cents),0) AS revenue_cents,
              COALESCE(SUM(ROUND(i.unit_cost_cents * i.qty)),0) AS cost_cents
       FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.tenant_id = $1 AND s.status = 'completed' AND ${RANGE}`,
      p,
    );
    const byMethod = await this.db.query<{ method: string; amount_cents: number }>(
      `SELECT sp.method, SUM(sp.amount_cents) AS amount_cents FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
       WHERE s.tenant_id = $1 AND s.status = 'completed' AND ${RANGE} GROUP BY sp.method ORDER BY 2 DESC`,
      p,
    );
    const byHour = await this.db.query<{ hour: number; total_cents: number; sales: number }>(
      `SELECT EXTRACT(HOUR FROM s.occurred_at AT TIME ZONE $4)::int AS hour, SUM(total_cents) AS total_cents, COUNT(*)::int AS sales
       FROM sales s WHERE s.tenant_id = $1 AND s.status = 'completed' AND ${RANGE} GROUP BY 1 ORDER BY 1`,
      p,
    );
    const top = await this.db.query<{ product_id: string; name: string; qty: number; total_cents: number }>(
      `SELECT i.product_id, MAX(i.name) AS name, SUM(i.base_qty) AS qty, SUM(i.line_total_cents) AS total_cents
       FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.tenant_id = $1 AND s.status = 'completed' AND ${RANGE}
       GROUP BY i.product_id ORDER BY 4 DESC LIMIT 8`,
      p,
    );
    const [inv] = await this.db.query<Record<string, number>>(
      `SELECT COUNT(*) FILTER (WHERE COALESCE(sl.qty,0) < 0)::int AS negative,
              COUNT(*) FILTER (WHERE pr.min_stock IS NOT NULL AND COALESCE(sl.qty,0) <= pr.min_stock)::int AS low
       FROM products pr LEFT JOIN stock_levels sl ON sl.product_id = pr.id WHERE pr.tenant_id = $1 AND pr.active`,
      [p[0]],
    );
    const [alerts] = await this.db.query<{ open: number }>('SELECT COUNT(*)::int AS open FROM alerts WHERE tenant_id = $1 AND resolved_at IS NULL', [p[0]]);
    const [devices] = await this.db.query<{ online: number; total: number }>(
      `SELECT COUNT(*) FILTER (WHERE last_seen_at > now() - interval '5 minutes' AND revoked_at IS NULL)::int AS online,
              COUNT(*) FILTER (WHERE revoked_at IS NULL)::int AS total
       FROM devices WHERE tenant_id = $1 AND platform <> 'server'`,
      [p[0]],
    );
    const revenue = Number(profit.revenue_cents);
    const cost = Number(profit.cost_cents);
    return {
      range: { from: p[1], to: p[2], timezone: p[3] },
      sales: Number(totals.sales),
      totalCents: Number(totals.total_cents),
      taxCents: Number(totals.tax_cents),
      discountCents: Number(totals.discount_cents),
      avgTicketCents: totals.sales ? Math.round(Number(totals.total_cents) / Number(totals.sales)) : 0,
      revenueCents: revenue,
      costCents: cost,
      profitCents: revenue - cost,
      marginBp: revenue ? Math.round(((revenue - cost) * 10000) / revenue) : 0,
      byMethod: byMethod.map((m) => ({ method: m.method, amountCents: Number(m.amount_cents) })),
      byHour: byHour.map((h) => ({ hour: h.hour, totalCents: Number(h.total_cents), sales: h.sales })),
      topProducts: top.map((t) => ({ productId: t.product_id, name: t.name, qty: Number(t.qty), totalCents: Number(t.total_cents) })),
      inventory: { negative: Number(inv.negative), low: Number(inv.low) },
      openAlerts: Number(alerts.open),
      devices,
    };
  }

  @Get('reports/sales')
  async sales(@Req() req: AuthedRequest, @Query('from') from?: string, @Query('to') to?: string) {
    const p = this.range(req, from, to);
    const rows = await this.db.query<{ day: string; sales: number; total_cents: number; tax_cents: number; discount_cents: number; voided: number }>(
      `SELECT to_char(s.occurred_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS sales,
              COALESCE(SUM(total_cents) FILTER (WHERE status = 'completed'),0) AS total_cents,
              COALESCE(SUM(tax_cents) FILTER (WHERE status = 'completed'),0) AS tax_cents,
              COALESCE(SUM(discount_cents) FILTER (WHERE status = 'completed'),0) AS discount_cents,
              COUNT(*) FILTER (WHERE status = 'voided')::int AS voided
       FROM sales s WHERE s.tenant_id = $1 AND ${RANGE} GROUP BY 1 ORDER BY 1`,
      p,
    );
    return {
      range: { from: p[1], to: p[2] },
      days: rows.map((r) => ({ day: r.day, sales: r.sales, totalCents: Number(r.total_cents), taxCents: Number(r.tax_cents), discountCents: Number(r.discount_cents), voided: r.voided })),
    };
  }

  @Get('reports/profit')
  async profit(@Req() req: AuthedRequest, @Query('from') from?: string, @Query('to') to?: string) {
    const p = this.range(req, from, to);
    const rows = await this.db.query<{ product_id: string; name: string; qty: number; revenue_cents: number; cost_cents: number }>(
      `SELECT i.product_id, MAX(i.name) AS name, SUM(i.base_qty) AS qty,
              SUM(i.line_total_cents - i.tax_cents) AS revenue_cents, SUM(ROUND(i.unit_cost_cents * i.qty)) AS cost_cents
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
       WHERE s.tenant_id = $1 AND s.status = 'completed' AND ${RANGE}
       GROUP BY i.product_id ORDER BY (SUM(i.line_total_cents - i.tax_cents) - SUM(ROUND(i.unit_cost_cents * i.qty))) DESC`,
      p,
    );
    const products = rows.map((r) => {
      const revenue = Number(r.revenue_cents);
      const cost = Number(r.cost_cents);
      return {
        productId: r.product_id,
        name: r.name,
        qty: Number(r.qty),
        revenueCents: revenue,
        costCents: cost,
        profitCents: revenue - cost,
        marginBp: revenue ? Math.round(((revenue - cost) * 10000) / revenue) : 0,
        belowCost: revenue < cost,
      };
    });
    const revenue = products.reduce((s, x) => s + x.revenueCents, 0);
    const cost = products.reduce((s, x) => s + x.costCents, 0);
    return { range: { from: p[1], to: p[2] }, revenueCents: revenue, costCents: cost, profitCents: revenue - cost, products };
  }

  @Get('reports/inventory')
  async inventory(@Req() req: AuthedRequest) {
    const rows = await this.db.query<{ id: string; name: string; sku: string; category: string; unit: string; price_cents: number; cost_avg_cents: number; min_stock: number | null; qty: number; active: boolean }>(
      `SELECT pr.id, pr.name, pr.sku, pr.category, pr.unit, pr.price_cents, pr.cost_avg_cents, pr.min_stock, pr.active, COALESCE(sl.qty,0) AS qty
       FROM products pr LEFT JOIN stock_levels sl ON sl.product_id = pr.id AND sl.tenant_id = pr.tenant_id
       WHERE pr.tenant_id = $1 ORDER BY pr.category, pr.name`,
      [req.owner!.tenantId],
    );
    const items = rows.map((r) => {
      const qty = Number(r.qty);
      return {
        productId: r.id,
        name: r.name,
        sku: r.sku,
        category: r.category,
        unit: r.unit,
        qty,
        minStock: r.min_stock === null ? null : Number(r.min_stock),
        costAvgCents: Number(r.cost_avg_cents),
        priceCents: Number(r.price_cents),
        costValueCents: Math.round(Math.max(qty, 0) * Number(r.cost_avg_cents)),
        retailValueCents: Math.round(Math.max(qty, 0) * Number(r.price_cents)),
        status: qty < 0 ? 'negative' : r.min_stock !== null && qty <= Number(r.min_stock) ? 'low' : 'ok',
        active: r.active,
      };
    });
    return {
      items,
      costValueCents: items.reduce((s, i) => s + i.costValueCents, 0),
      retailValueCents: items.reduce((s, i) => s + i.retailValueCents, 0),
    };
  }

  @Get('reports/cash')
  async cash(@Req() req: AuthedRequest, @Query('from') from?: string, @Query('to') to?: string) {
    const p = this.range(req, from, to);
    const rows = await this.db.query(
      `SELECT cs.id, cs.device_id, d.name AS device_name, u.name AS user_name, cs.opened_at, cs.closed_at, cs.opening_cents,
              cs.counted_cents, cs.expected_cents, cs.difference_cents,
              (SELECT COALESCE(SUM(sp.amount_cents),0) FROM sale_payments sp JOIN sales s2 ON s2.id = sp.sale_id
                 WHERE s2.cash_session_id = cs.id AND s2.status = 'completed' AND sp.method = 'cash') AS cash_sales_cents,
              (SELECT COUNT(*)::int FROM sales s3 WHERE s3.cash_session_id = cs.id) AS sales
       FROM cash_sessions cs LEFT JOIN devices d ON d.id = cs.device_id LEFT JOIN users u ON u.id = cs.user_id
       WHERE cs.tenant_id = $1 AND cs.opened_at >= ($2::date)::timestamp AT TIME ZONE $4 AND cs.opened_at < (($3::date + 1))::timestamp AT TIME ZONE $4
       ORDER BY cs.opened_at DESC`,
      p,
    );
    return { range: { from: p[1], to: p[2] }, sessions: rows };
  }

  @Get('sales')
  async salesList(@Req() req: AuthedRequest, @Query('from') from?: string, @Query('to') to?: string) {
    const p = this.range(req, from, to);
    return this.db.query(
      `SELECT s.id, s.local_number, s.device_id, d.name AS device_name, s.status, s.total_cents, s.tax_cents, s.discount_cents,
              s.occurred_at, c.name AS customer_name,
              (SELECT string_agg(DISTINCT sp.method, ',') FROM sale_payments sp WHERE sp.sale_id = s.id) AS methods,
              (SELECT COUNT(*)::int FROM sale_items i WHERE i.sale_id = s.id) AS items
       FROM sales s LEFT JOIN devices d ON d.id = s.device_id LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.tenant_id = $1 AND ${RANGE} ORDER BY s.occurred_at DESC LIMIT 300`,
      p,
    );
  }

  @Get('alerts')
  async alerts(@Req() req: AuthedRequest, @Query('all') all?: string) {
    return this.db.query(
      `SELECT a.id, a.kind, a.product_id, p.name AS product_name, a.message, a.data, a.created_at, a.resolved_at
       FROM alerts a LEFT JOIN products p ON p.id = a.product_id
       WHERE a.tenant_id = $1 AND ($2::boolean OR a.resolved_at IS NULL) ORDER BY a.created_at DESC LIMIT 200`,
      [req.owner!.tenantId, all === 'true'],
    );
  }

  @Post('alerts/:id/resolve')
  @HttpCode(200)
  async resolve(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.db.query('UPDATE alerts SET resolved_at = now() WHERE id = $1 AND tenant_id = $2', [id, req.owner!.tenantId]);
    return { id, resolved: true };
  }
}
