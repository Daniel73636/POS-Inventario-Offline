import type { PosEvent, Product } from '@pos/contracts';
import { averageCost, priceLine } from '@pos/domain-pos';
import { uuidv7 } from '@pos/sync-engine';
import type { Queryable } from './adapter';

async function currentStock(q: Queryable, tenantId: string, productId: string): Promise<number> {
  const [row] = await q.query<{ qty: number | null }>(
    'SELECT COALESCE(SUM(qty), 0) AS qty FROM stock_movements WHERE tenant_id = $1 AND product_id = $2',
    [tenantId, productId],
  );
  return Number(row?.qty ?? 0);
}

async function insertMovement(
  q: Queryable,
  e: PosEvent,
  m: { idx: number; productId: string; qty: number; unitCostCents?: number | null; reason: string; refId?: string | null; userId?: string | null; lotCode?: string | null; expiresOn?: string | null },
): Promise<void> {
  await q.query(
    `INSERT INTO stock_movements (id, tenant_id, store_id, product_id, lot_code, expires_on, qty, unit_cost_cents, reason, ref_id, device_id, user_id, hlc, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING`,
    [
      `${e.id}:${m.idx}`,
      e.tenantId,
      e.storeId,
      m.productId,
      m.lotCode ?? null,
      m.expiresOn ?? null,
      m.qty,
      m.unitCostCents ?? null,
      m.reason,
      m.refId ?? null,
      e.deviceId,
      m.userId ?? null,
      e.hlc,
      e.occurredAt,
    ],
  );
}

async function alert(q: Queryable, tenantId: string, kind: string, productId: string | null, message: string, data: unknown): Promise<void> {
  await q.query('INSERT INTO alerts (id, tenant_id, kind, product_id, message, data) VALUES ($1,$2,$3,$4,$5,$6)', [
    uuidv7(),
    tenantId,
    kind,
    productId,
    message,
    JSON.stringify(data),
  ]);
}

async function checkNegative(q: Queryable, e: PosEvent, productId: string, name: string): Promise<void> {
  const qty = await currentStock(q, e.tenantId, productId);
  if (qty < 0) {
    await alert(q, e.tenantId, 'negative_stock', productId, `Stock negativo de "${name}": ${qty}. Revisar ventas sin conexión o inventario.`, {
      qty,
      eventId: e.id,
      deviceId: e.deviceId,
    });
  }
}

async function upsertProduct(q: Queryable, e: PosEvent, p: Product): Promise<void> {
  const rows = await q.query<{ id: string }>(
    `INSERT INTO products (id, tenant_id, name, sku, category, unit, tax_rate_bp, price_cents, cost_avg_cents, min_stock, active, data, updated_hlc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, sku = EXCLUDED.sku, category = EXCLUDED.category, unit = EXCLUDED.unit,
       tax_rate_bp = EXCLUDED.tax_rate_bp, price_cents = EXCLUDED.price_cents, min_stock = EXCLUDED.min_stock,
       active = EXCLUDED.active, data = EXCLUDED.data, updated_hlc = EXCLUDED.updated_hlc
     WHERE products.updated_hlc < EXCLUDED.updated_hlc
     RETURNING id`,
    [p.id, e.tenantId, p.name, p.sku, p.category, p.unit, p.taxRateBp, p.priceCents, p.costAvgCents, p.minStock, p.active, JSON.stringify(p), e.hlc],
  );
  if (!rows.length) return; // una versión más reciente ya existe (LWW)

  await q.query('DELETE FROM barcodes WHERE tenant_id = $1 AND product_id = $2', [e.tenantId, p.id]);
  const codes = [
    ...p.barcodes.map((b) => ({ code: b, packId: null as string | null })),
    ...p.packs.filter((k) => k.barcode).map((k) => ({ code: k.barcode as string, packId: k.id })),
  ];
  for (const c of codes) {
    const [existing] = await q.query<{ product_id: string }>(
      'SELECT product_id FROM barcodes WHERE tenant_id = $1 AND barcode = $2',
      [e.tenantId, c.code],
    );
    if (existing && existing.product_id !== p.id) {
      await alert(q, e.tenantId, 'barcode_conflict', p.id, `El código ${c.code} estaba asignado a otro producto; se reasignó a "${p.name}".`, {
        barcode: c.code,
        previousProductId: existing.product_id,
      });
    }
    await q.query(
      `INSERT INTO barcodes (tenant_id, barcode, product_id, pack_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, barcode) DO UPDATE SET product_id = EXCLUDED.product_id, pack_id = EXCLUDED.pack_id`,
      [e.tenantId, c.code, p.id, c.packId],
    );
  }
}

/** Aplica un evento ya aceptado a las proyecciones centrales (misma transacción que el insert). */
export async function projectEvent(q: Queryable, e: PosEvent): Promise<void> {
  switch (e.type) {
    case 'ProductUpserted':
      await upsertProduct(q, e, e.payload.product);
      return;

    case 'CustomerUpserted': {
      const c = e.payload.customer;
      await q.query(
        `INSERT INTO customers (id, tenant_id, name, data, updated_hlc) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, updated_hlc = EXCLUDED.updated_hlc
         WHERE customers.updated_hlc < EXCLUDED.updated_hlc`,
        [c.id, e.tenantId, c.name, JSON.stringify(c), e.hlc],
      );
      return;
    }

    case 'StockReceived': {
      const p = e.payload;
      const [prod] = await q.query<{ cost_avg_cents: number }>('SELECT cost_avg_cents FROM products WHERE id = $1', [p.productId]);
      if (prod) {
        const stock = await currentStock(q, e.tenantId, p.productId);
        const cost = averageCost(stock, Number(prod.cost_avg_cents), p.qty, p.unitCostCents);
        await q.query(
          `UPDATE products SET cost_avg_cents = $2, data = jsonb_set(data, '{costAvgCents}', to_jsonb($2::bigint)) WHERE id = $1`,
          [p.productId, cost],
        );
      }
      await insertMovement(q, e, {
        idx: 0,
        productId: p.productId,
        qty: p.qty,
        unitCostCents: p.unitCostCents,
        reason: 'purchase',
        userId: p.userId,
        lotCode: p.lotCode,
        expiresOn: p.expiresOn,
      });
      return;
    }

    case 'StockAdjusted': {
      const p = e.payload;
      await insertMovement(q, e, { idx: 0, productId: p.productId, qty: p.qty, reason: p.reason === 'count' ? 'count' : 'adjust', userId: p.userId });
      if (p.qty < 0) await checkNegative(q, e, p.productId, p.productId);
      return;
    }

    case 'SaleCompleted': {
      const s = e.payload;
      const inserted = await q.query(
        `INSERT INTO sales (id, tenant_id, store_id, device_id, cash_session_id, user_id, customer_id, status, local_number, fiscal_number,
                            subtotal_cents, discount_cents, tax_cents, total_cents, occurred_at, hlc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [s.saleId, e.tenantId, e.storeId, e.deviceId, s.cashSessionId, s.userId, s.customerId, s.localNumber, s.fiscalNumber ?? null,
          s.subtotalCents, s.discountCents, s.taxCents, s.totalCents, e.occurredAt, e.hlc],
      );
      if (!inserted.length) return;
      let priceListId: string | null = null;
      if (s.customerId) {
        const [cus] = await q.query<{ data: { priceListId?: string | null } }>('SELECT data FROM customers WHERE id = $1', [s.customerId]);
        priceListId = cus?.data.priceListId ?? null;
      }
      for (const [i, it] of s.items.entries()) {
        await q.query(
          `INSERT INTO sale_items (id, sale_id, product_id, name, pack_id, qty, base_qty, unit_price_cents, unit_cost_cents, discount_cents, tax_rate_bp, tax_cents, line_total_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [`${s.saleId}:${i}`, s.saleId, it.productId, it.name, it.packId, it.qty, it.baseQty, it.unitPriceCents, it.unitCostCents,
            it.discountCents, it.taxRateBp, it.taxCents, it.lineTotalCents],
        );
        await insertMovement(q, e, { idx: i, productId: it.productId, qty: -it.baseQty, unitCostCents: it.unitCostCents, reason: 'sale', refId: s.saleId, userId: s.userId });
        await checkNegative(q, e, it.productId, it.name);

        // Precio cambiado mientras la caja estaba desconectada: se informa, nunca se bloquea.
        const [prod] = await q.query<{ data: Product }>('SELECT data FROM products WHERE id = $1', [it.productId]);
        if (prod) {
          let expected: number | null = null;
          try {
            expected = priceLine(prod.data, it.qty, { priceListId: priceListId ?? undefined, packId: it.packId }).unitPriceCents;
          } catch {
            expected = null;
          }
          if (expected !== null && expected !== it.unitPriceCents) {
            const diff = it.unitPriceCents - expected;
            await alert(q, e.tenantId, 'price_diff', it.productId, `"${it.name}" se vendió a un precio distinto al vigente (diferencia ${diff / 100}).`, {
              saleId: s.saleId,
              soldCents: it.unitPriceCents,
              currentCents: expected,
            });
          }
        }
      }
      for (const [i, pay] of s.payments.entries()) {
        await q.query('INSERT INTO sale_payments (id, sale_id, method, amount_cents, reference) VALUES ($1,$2,$3,$4,$5)', [
          `${s.saleId}:${i}`,
          s.saleId,
          pay.method,
          pay.amountCents,
          pay.reference ?? null,
        ]);
      }
      return;
    }

    case 'SaleVoided': {
      const updated = await q.query<{ id: string }>(
        `UPDATE sales SET status = 'voided', voided_at = $2, void_reason = $3 WHERE id = $1 AND status = 'completed' RETURNING id`,
        [e.payload.saleId, e.occurredAt, e.payload.reason],
      );
      if (!updated.length) return;
      const items = await q.query<{ product_id: string; base_qty: number; unit_cost_cents: number }>(
        'SELECT product_id, base_qty, unit_cost_cents FROM sale_items WHERE sale_id = $1 ORDER BY id',
        [e.payload.saleId],
      );
      for (const [i, it] of items.entries()) {
        await insertMovement(q, e, { idx: i, productId: it.product_id, qty: Number(it.base_qty), unitCostCents: Number(it.unit_cost_cents), reason: 'return', refId: e.payload.saleId, userId: e.payload.userId });
      }
      await alert(q, e.tenantId, 'sale_voided', null, `Venta anulada: ${e.payload.reason}`, { saleId: e.payload.saleId, authorizedBy: e.payload.authorizedBy, userId: e.payload.userId });
      return;
    }

    case 'CashSessionOpened':
      await q.query(
        `INSERT INTO cash_sessions (id, tenant_id, store_id, device_id, user_id, opened_at, opening_cents) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [e.payload.sessionId, e.tenantId, e.storeId, e.deviceId, e.payload.userId, e.occurredAt, e.payload.openingCents],
      );
      return;

    case 'CashMovement':
      await q.query(
        `INSERT INTO cash_movements (id, session_id, kind, amount_cents, reason, user_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [e.payload.movementId, e.payload.sessionId, e.payload.kind, e.payload.amountCents, e.payload.reason, e.payload.userId, e.occurredAt],
      );
      return;

    case 'CashSessionClosed': {
      const p = e.payload;
      await q.query(
        `UPDATE cash_sessions SET closed_at = $2, counted_cents = $3, expected_cents = $4, difference_cents = $5 WHERE id = $1`,
        [p.sessionId, e.occurredAt, p.countedCents, p.expectedCents, p.differenceCents],
      );
      if (p.differenceCents !== 0) {
        await alert(q, e.tenantId, 'cash_difference', null, `Cierre de caja con diferencia de ${p.differenceCents / 100}.`, { sessionId: p.sessionId, deviceId: e.deviceId });
      }
      return;
    }
  }
}
