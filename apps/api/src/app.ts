import { randomBytes } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreatePairingCodeSchema,
  CustomerSchema,
  FiscalRangeRequestSchema,
  LoginRequestSchema,
  ProductSchema,
  PushRequestSchema,
  RegisterDeviceRequestSchema,
  StockAdjustRequestSchema,
  StockReceiveRequestSchema,
  type RegisterDeviceResponse,
} from '@pos/contracts';
import {
  buildSnapshot,
  emitServerEvents,
  hashToken,
  ingestEvents,
  newDeviceToken,
  pullEvents,
  verifyPassword,
  type Database,
} from '@pos/db';
import { profitOfSale } from '@pos/domain-pos';
import { uuidv7 } from '@pos/sync-engine';
import { requireDevice, requireOwner, signOwnerToken } from './auth';

export interface AppOptions {
  db: Database;
  secret: string;
  logger?: boolean;
  corsOrigins?: string[] | true;
}

function bad(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: z.ZodError) {
  return reply.code(400).send({
    title: 'Datos inválidos',
    errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** Rango de fechas [desde, hasta) en ISO a partir de ?from=YYYY-MM-DD&to=YYYY-MM-DD (por defecto: últimos 7 días). */
function range(query: Record<string, string | undefined>): { from: string; to: string } {
  const to = query.to ? new Date(`${query.to}T23:59:59.999`) : new Date();
  const from = query.from ? new Date(`${query.from}T00:00:00`) : new Date(to.getTime() - 6 * 86400000);
  if (!query.from) from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db, secret } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  await app.register(cors, { origin: opts.corsOrigins ?? true });

  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    void reply.code(status).send({ title: status === 500 ? 'Error interno' : err.message });
  });

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, service: 'pos-api', db: db.kind, time: new Date().toISOString() };
  });

  // ---------------------------------------------------------------- dispositivos
  app.post('/v1/devices/register', async (req, reply) => {
    const parsed = RegisterDeviceRequestSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error);
    const { pairingCode, name, platform } = parsed.data;
    const token = newDeviceToken();
    const deviceId = `dev_${uuidv7()}`;
    const result = await db.tx(async (q) => {
      const [code] = await q.query<{ tenant_id: string; store_id: string; uses_left: number; expires_at: string | null }>(
        'SELECT tenant_id, store_id, uses_left, expires_at FROM pairing_codes WHERE code = $1 FOR UPDATE',
        [pairingCode.trim().toUpperCase()],
      );
      if (!code || code.uses_left <= 0 || (code.expires_at && new Date(code.expires_at) < new Date())) return null;
      await q.query('UPDATE pairing_codes SET uses_left = uses_left - 1 WHERE code = $1', [pairingCode.trim().toUpperCase()]);
      await q.query('INSERT INTO devices (id, tenant_id, store_id, name, platform, token_hash) VALUES ($1,$2,$3,$4,$5,$6)', [
        deviceId, code.tenant_id, code.store_id, name, platform, hashToken(token),
      ]);
      const [t] = await q.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [code.tenant_id]);
      const [s] = await q.query<{ name: string }>('SELECT name FROM stores WHERE id = $1', [code.store_id]);
      return { tenantId: code.tenant_id, storeId: code.store_id, tenantName: t.name, storeName: s.name };
    });
    if (!result) return reply.code(403).send({ title: 'Código de vinculación inválido, usado o vencido' });
    const body: RegisterDeviceResponse = { deviceId, deviceToken: token, ...result, serverTime: new Date().toISOString() };
    return reply.code(201).send(body);
  });

  app.post<{ Params: { id: string } }>('/v1/devices/:id/revoke', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    const rows = await db.query('UPDATE devices SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING id', [req.params.id, owner.tenantId]);
    if (!rows.length) return reply.code(404).send({ title: 'Dispositivo no encontrado' });
    return { ok: true };
  });

  app.get('/v1/devices', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    return db.query(
      `SELECT d.id, d.name, d.platform, d.last_seq, d.created_at, d.last_seen_at, d.revoked_at,
              (SELECT COUNT(*)::int FROM events e WHERE e.device_id = d.id) AS events
       FROM devices d WHERE d.tenant_id = $1 ORDER BY d.created_at`,
      [owner.tenantId],
    );
  });

  app.post('/v1/devices/pairing-codes', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    const parsed = CreatePairingCodeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed.error);
    const code = randomBytes(4).toString('hex').toUpperCase();
    const [store] = await db.query<{ id: string }>('SELECT id FROM stores WHERE tenant_id = $1 LIMIT 1', [owner.tenantId]);
    await db.query(`INSERT INTO pairing_codes (code, tenant_id, store_id, uses_left, expires_at) VALUES ($1,$2,$3,$4, now() + interval '24 hours')`, [
      code, owner.tenantId, store.id, parsed.data.uses,
    ]);
    return reply.code(201).send({ code, uses: parsed.data.uses, expiresInHours: 24 });
  });

  // ---------------------------------------------------------------- sincronización
  app.post('/v1/sync/push', async (req, reply) => {
    const device = await requireDevice(db, req, reply);
    if (!device) return;
    const parsed = PushRequestSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error);
    return ingestEvents(db, { id: device.id, tenantId: device.tenant_id, storeId: device.store_id }, parsed.data.events);
  });

  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/v1/sync/pull', async (req, reply) => {
    const device = await requireDevice(db, req, reply);
    if (!device) return;
    const cursor = Math.max(0, Number(req.query.cursor ?? 0) || 0);
    const limit = Number(req.query.limit ?? 500) || 500;
    await db.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [device.id]);
    return pullEvents(db, device.tenant_id, cursor, limit);
  });

  app.get('/v1/sync/snapshot', async (req, reply) => {
    const device = await requireDevice(db, req, reply);
    if (!device) return;
    return buildSnapshot(db, device.tenant_id, device.store_id);
  });

  /** Stub del módulo fiscal: reserva rangos de numeración por dispositivo (proveedor real pendiente). */
  app.post('/v1/fiscal/ranges', async (req, reply) => {
    const device = await requireDevice(db, req, reply);
    if (!device) return;
    const parsed = FiscalRangeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed.error);
    return db.tx(async (q) => {
      await q.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [device.tenant_id]);
      const [last] = await q.query<{ max: number | null }>('SELECT MAX(range_to) AS max FROM fiscal_ranges WHERE tenant_id = $1', [device.tenant_id]);
      const from = Number(last?.max ?? 0) + 1;
      const to = from + parsed.data.size - 1;
      const id = uuidv7();
      await q.query('INSERT INTO fiscal_ranges (id, tenant_id, store_id, device_id, prefix, range_from, range_to) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
        id, device.tenant_id, device.store_id, device.id, 'POS', from, to,
      ]);
      return { id, prefix: 'POS', from, to, resolution: 'DEMO-SIN-VALIDEZ-FISCAL', validUntil: new Date(Date.now() + 365 * 86400000).toISOString() };
    });
  });

  // ---------------------------------------------------------------- panel del dueño
  app.post('/v1/auth/login', async (req, reply) => {
    const parsed = LoginRequestSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error);
    const [owner] = await db.query<{ id: string; tenant_id: string; name: string; password_hash: string }>(
      'SELECT id, tenant_id, name, password_hash FROM owners WHERE email = $1',
      [parsed.data.email.toLowerCase()],
    );
    if (!owner || !verifyPassword(parsed.data.password, owner.password_hash)) {
      return reply.code(401).send({ title: 'Correo o contraseña incorrectos' });
    }
    const [t] = await db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [owner.tenant_id]);
    return { token: signOwnerToken(secret, { ownerId: owner.id, tenantId: owner.tenant_id }), name: owner.name, tenantName: t.name };
  });

  app.get('/v1/products', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    const rows = await db.query<{ data: Record<string, unknown>; cost_avg_cents: number; qty: number | null }>(
      `SELECT p.data, p.cost_avg_cents, s.qty FROM products p
       LEFT JOIN stock_levels s ON s.product_id = p.id AND s.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1 ORDER BY p.category, p.name`,
      [owner.tenantId],
    );
    return rows.map((r) => ({ ...r.data, costAvgCents: Number(r.cost_avg_cents), stock: Number(r.qty ?? 0) }));
  });

  /** Crear/editar producto: se emite ProductUpserted y las cajas lo reciben por pull. */
  app.put<{ Params: { id: string } }>('/v1/products/:id', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    const parsed = ProductSchema.safeParse({ ...(req.body as object), id: req.params.id });
    if (!parsed.success) return bad(reply, parsed.error);
    const product = parsed.data;
    if (!product.prices.some((p) => p.priceListId === 'general' && p.minQty === 1 && !p.packId)) {
      product.prices = [{ priceListId: 'general', priceCents: product.priceCents, minQty: 1 }, ...product.prices];
    } else {
      product.prices = product.prices.map((p) => (p.priceListId === 'general' && p.minQty === 1 && !p.packId ? { ...p, priceCents: product.priceCents } : p));
    }
    await emitServerEvents(db, owner.tenantId, [{ type: 'ProductUpserted', payload: { product } }]);
    return { ok: true, product };
  });

  app.get('/v1/customers', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    const rows = await db.query<{ data: Record<string, unknown>; id: string }>('SELECT id, data FROM customers WHERE tenant_id = $1 ORDER BY name', [owner.tenantId]);
    const balances = await db.query<{ customer_id: string; total: number }>(
      `SELECT s.customer_id, SUM(p.amount_cents) AS total FROM sale_payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.tenant_id = $1 AND p.method = 'credit' AND s.status = 'completed' GROUP BY 1`,
      [owner.tenantId],
    );
    const bal = new Map(balances.map((b) => [b.customer_id, Number(b.total)]));
    return rows.map((r) => ({ ...r.data, balanceCents: bal.get(r.id) ?? 0 }));
  });

  app.put<{ Params: { id: string } }>('/v1/customers/:id', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    const parsed = CustomerSchema.safeParse({ ...(req.body as object), id: req.params.id });
    if (!parsed.success) return bad(reply, parsed.error);
    await emitServerEvents(db, owner.tenantId, [{ type: 'CustomerUpserted', payload: { customer: parsed.data } }]);
    return { ok: true, customer: parsed.data };
  });

  app.post('/v1/inventory/adjustments', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    const parsed = StockAdjustRequestSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error);
    await emitServerEvents(db, owner.tenantId, [{ type: 'StockAdjusted', payload: { ...parsed.data, userId: owner.ownerId } }]);
    return { ok: true };
  });

  app.post('/v1/purchases', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    const parsed = StockReceiveRequestSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error);
    await emitServerEvents(db, owner.tenantId, [{ type: 'StockReceived', payload: { ...parsed.data, userId: owner.ownerId } }]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- reportes
  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/reports/sales', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    const { from, to } = range(req.query);
    const params = [owner.tenantId, from, to];
    const [totals] = await db.query<Record<string, number>>(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents),0) AS total_cents, COALESCE(SUM(tax_cents),0) AS tax_cents,
              COALESCE(SUM(discount_cents),0) AS discount_cents
       FROM sales WHERE tenant_id = $1 AND status = 'completed' AND occurred_at >= $2 AND occurred_at <= $3`,
      params,
    );
    const byDay = await db.query(
      `SELECT to_char(occurred_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS day, COUNT(*)::int AS count, SUM(total_cents) AS total_cents
       FROM sales WHERE tenant_id = $1 AND status = 'completed' AND occurred_at >= $2 AND occurred_at <= $3 GROUP BY 1 ORDER BY 1`,
      params,
    );
    const byMethod = await db.query(
      `SELECT p.method, SUM(p.amount_cents) AS total_cents FROM sale_payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.tenant_id = $1 AND s.status = 'completed' AND s.occurred_at >= $2 AND s.occurred_at <= $3 GROUP BY 1 ORDER BY 2 DESC`,
      params,
    );
    const recent = await db.query(
      `SELECT s.id, s.local_number, s.total_cents, s.status, s.occurred_at, d.name AS device
       FROM sales s LEFT JOIN devices d ON d.id = s.device_id WHERE s.tenant_id = $1 ORDER BY s.occurred_at DESC LIMIT 20`,
      [owner.tenantId],
    );
    return { from, to, totals, byDay, byMethod, recent };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/reports/profit', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    const { from, to } = range(req.query);
    const items = await db.query<{ product_id: string; name: string; qty: number; unit_cost_cents: number; line_total_cents: number; tax_cents: number }>(
      `SELECT i.product_id, i.name, i.base_qty AS qty, i.unit_cost_cents, i.line_total_cents, i.tax_cents, i.pack_id, i.qty AS sold_qty
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
       WHERE s.tenant_id = $1 AND s.status = 'completed' AND s.occurred_at >= $2 AND s.occurred_at <= $3`,
      [owner.tenantId, from, to],
    );
    type Row = { productId: string; name: string; qty: number; revenueCents: number; costCents: number; profitCents: number };
    const byProduct = new Map<string, Row>();
    const all = { items: [] as Array<{ qty: number; unitCostCents: number; lineTotalCents: number; taxCents: number }> };
    for (const raw of items as Array<(typeof items)[number] & { sold_qty: number }>) {
      // unit_cost_cents corresponde a la presentación vendida (qty vendida, no unidades base).
      const it = { qty: Number(raw.sold_qty), unitCostCents: Number(raw.unit_cost_cents), lineTotalCents: Number(raw.line_total_cents), taxCents: Number(raw.tax_cents) };
      all.items.push(it);
      const p = profitOfSale({ items: [it] });
      const row = byProduct.get(raw.product_id) ?? { productId: raw.product_id, name: raw.name, qty: 0, revenueCents: 0, costCents: 0, profitCents: 0 };
      row.qty += Number(raw.qty);
      row.revenueCents += p.revenueCents;
      row.costCents += p.costCents;
      row.profitCents += p.profitCents;
      byProduct.set(raw.product_id, row);
    }
    return {
      from,
      to,
      totals: profitOfSale(all),
      byProduct: [...byProduct.values()].sort((a, b) => b.profitCents - a.profitCents),
    };
  });

  app.get('/v1/reports/inventory', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    const rows = await db.query<{ id: string; name: string; category: string; min_stock: number | null; cost_avg_cents: number; price_cents: number; qty: number | null }>(
      `SELECT p.id, p.name, p.category, p.min_stock, p.cost_avg_cents, p.price_cents, COALESCE(s.qty, 0) AS qty
       FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id AND s.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1 AND p.active ORDER BY p.name`,
      [owner.tenantId],
    );
    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      qty: Number(r.qty ?? 0),
      minStock: r.min_stock === null ? null : Number(r.min_stock),
      costAvgCents: Number(r.cost_avg_cents),
      priceCents: Number(r.price_cents),
      valueCents: Math.round(Number(r.qty ?? 0) * Number(r.cost_avg_cents)),
      status: Number(r.qty) < 0 ? 'negative' : r.min_stock !== null && Number(r.qty) <= Number(r.min_stock) ? 'low' : 'ok',
    }));
    return {
      items,
      totalValueCents: items.reduce((s, i) => s + Math.max(0, i.valueCents), 0),
      lowCount: items.filter((i) => i.status === 'low').length,
      negativeCount: items.filter((i) => i.status === 'negative').length,
    };
  });

  app.get('/v1/reports/cash', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    return db.query(
      `SELECT c.id, c.opened_at, c.closed_at, c.opening_cents, c.counted_cents, c.expected_cents, c.difference_cents,
              d.name AS device, u.name AS cashier,
              (SELECT COALESCE(SUM(total_cents),0) FROM sales s WHERE s.cash_session_id = c.id AND s.status = 'completed') AS sales_cents
       FROM cash_sessions c LEFT JOIN devices d ON d.id = c.device_id LEFT JOIN users u ON u.id = c.user_id
       WHERE c.tenant_id = $1 ORDER BY c.opened_at DESC LIMIT 50`,
      [owner.tenantId],
    );
  });

  app.get('/v1/alerts', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    return db.query('SELECT id, kind, product_id, message, created_at FROM alerts WHERE tenant_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 100', [owner.tenantId]);
  });

  app.post<{ Params: { id: string } }>('/v1/alerts/:id/resolve', async (req, reply) => {
    const owner = await requireOwner(secret, req, reply);
    if (!owner) return;
    await db.query('UPDATE alerts SET resolved_at = now() WHERE id = $1 AND tenant_id = $2', [req.params.id, owner.tenantId]);
    return { ok: true };
  });

  return app;
}
