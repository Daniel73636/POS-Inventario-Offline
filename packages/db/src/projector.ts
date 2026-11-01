import type { PosEvent, Product } from '@pos/contracts';
import { averageCost, daysUntil, NEAR_EXPIRY_DAYS, priceLine } from '@pos/domain-pos';
import { uuidv7 } from '@pos/sync-engine';
import type { Queryable } from './adapter';
import { appendAudit } from './audit';

/*
 * Regla: toda lectura y escritura de proyecciones filtra por tenant_id del evento.
 * Los ids (producto, venta, turno...) los generan los clientes y no son secretos.
 */

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
  m: { idx: number | string; productId: string; qty: number; unitCostCents?: number | null; reason: string; refId?: string | null; userId?: string | null; lotCode?: string | null; expiresOn?: string | null },
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

async function productName(q: Queryable, tenantId: string, productId: string): Promise<string> {
  const [row] = await q.query<{ name: string }>('SELECT name FROM products WHERE tenant_id = $1 AND id = $2', [tenantId, productId]);
  return row?.name ?? productId;
}

async function upsertProduct(q: Queryable, e: PosEvent, p: Product): Promise<void> {
  const rows = await q.query<{ id: string }>(
    `INSERT INTO products (id, tenant_id, name, sku, category, unit, tax_rate_bp, price_cents, cost_avg_cents, min_stock, active, data, updated_hlc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
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
  const t = e.tenantId;
  switch (e.type) {
    case 'ProductUpserted':
      await upsertProduct(q, e, e.payload.product);
      return;

    case 'CustomerUpserted': {
      const c = e.payload.customer;
      await q.query(
        `INSERT INTO customers (id, tenant_id, name, data, updated_hlc) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, updated_hlc = EXCLUDED.updated_hlc
         WHERE customers.updated_hlc < EXCLUDED.updated_hlc`,
        [c.id, t, c.name, JSON.stringify(c), e.hlc],
      );
      return;
    }

    case 'StockReceived': {
      const p = e.payload;
      const [prod] = await q.query<{ cost_avg_cents: number }>('SELECT cost_avg_cents FROM products WHERE tenant_id = $1 AND id = $2', [t, p.productId]);
      if (prod) {
        const stock = await currentStock(q, t, p.productId);
        const cost = averageCost(stock, Number(prod.cost_avg_cents), p.qty, p.unitCostCents);
        await q.query(
          `UPDATE products SET cost_avg_cents = $3, data = jsonb_set(data, '{costAvgCents}', to_jsonb($3::bigint)) WHERE tenant_id = $1 AND id = $2`,
          [t, p.productId, cost],
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
      if (p.expiresOn) {
        const days = daysUntil(p.expiresOn, e.occurredAt.slice(0, 10));
        if (days <= NEAR_EXPIRY_DAYS) {
          const name = await productName(q, t, p.productId);
          const when = days < 0 ? `venció el ${p.expiresOn.slice(0, 10)}` : `vence el ${p.expiresOn.slice(0, 10)} (${days} días)`;
          await alert(q, t, 'near_expiry', p.productId, `"${name}" ${when}. Lote ${p.lotCode ?? 'sin código'}.`, {
            lotCode: p.lotCode ?? null,
            expiresOn: p.expiresOn.slice(0, 10),
            qty: p.qty,
            daysLeft: days,
          });
        }
      }
      return;
    }

    case 'StockAdjusted': {
      const p = e.payload;
      await insertMovement(q, e, { idx: 0, productId: p.productId, qty: p.qty, reason: p.reason === 'count' ? 'count' : 'adjust', userId: p.userId });
      const name = await productName(q, t, p.productId);
      await appendAudit(q, {
        tenantId: t,
        occurredAt: e.occurredAt,
        action: 'ajuste_inventario',
        actorUserId: p.userId,
        authorizedBy: null,
        deviceId: e.deviceId,
        eventId: e.id,
        refId: p.productId,
        data: { producto: name, delta: p.qty, motivo: p.reason, contado: p.countedQty ?? null, nota: p.note ?? null },
      });
      if (p.qty < 0) await checkNegative(q, e, p.productId, name);
      return;
    }

    case 'SaleCompleted': {
      const s = e.payload;
      const inserted = await q.query(
        `INSERT INTO sales (id, tenant_id, store_id, device_id, cash_session_id, user_id, customer_id, status, local_number, fiscal_number,
                            subtotal_cents, discount_cents, tax_cents, total_cents, occurred_at, hlc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id`,
        [s.saleId, t, e.storeId, e.deviceId, s.cashSessionId, s.userId, s.customerId, s.localNumber, s.fiscalNumber ?? null,
          s.subtotalCents, s.discountCents, s.taxCents, s.totalCents, e.occurredAt, e.hlc],
      );
      if (!inserted.length) return;
      if (s.discountAuthorizedBy && s.discountCents > 0) {
        await appendAudit(q, {
          tenantId: t,
          occurredAt: e.occurredAt,
          action: 'descuento_autorizado',
          actorUserId: s.userId,
          authorizedBy: s.discountAuthorizedBy,
          deviceId: e.deviceId,
          eventId: e.id,
          refId: s.saleId,
          data: { venta: s.localNumber, descuentoCents: s.discountCents, brutoCents: s.subtotalCents, totalCents: s.totalCents },
        });
      }
      let priceListId: string | null = null;
      if (s.customerId) {
        const [cus] = await q.query<{ data: { priceListId?: string | null } }>('SELECT data FROM customers WHERE tenant_id = $1 AND id = $2', [t, s.customerId]);
        priceListId = cus?.data.priceListId ?? null;
      }
      for (const [i, it] of s.items.entries()) {
        await q.query(
          `INSERT INTO sale_items (id, tenant_id, sale_id, product_id, name, pack_id, qty, base_qty, unit_price_cents, unit_cost_cents, discount_cents, tax_rate_bp, tax_cents, line_total_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [`${s.saleId}:${i}`, t, s.saleId, it.productId, it.name, it.packId, it.qty, it.baseQty, it.unitPriceCents, it.unitCostCents,
            it.discountCents, it.taxRateBp, it.taxCents, it.lineTotalCents],
        );
        const lots = it.lots ?? [];
        if (!lots.length) {
          await insertMovement(q, e, { idx: i, productId: it.productId, qty: -it.baseQty, unitCostCents: it.unitCostCents, reason: 'sale', refId: s.saleId, userId: s.userId });
        } else {
          let allocatedMilli = 0;
          for (const [li, lot] of lots.entries()) {
            allocatedMilli += Math.round(lot.qty * 1000);
            await insertMovement(q, e, {
              idx: `${i}:${li}`,
              productId: it.productId,
              qty: -lot.qty,
              unitCostCents: it.unitCostCents,
              reason: 'sale',
              refId: s.saleId,
              userId: s.userId,
              lotCode: lot.lotId,
              expiresOn: lot.expiresOn ?? null,
            });
          }
          const shortMilli = Math.round(it.baseQty * 1000) - allocatedMilli;
          if (shortMilli > 0) {
            await insertMovement(q, e, {
              idx: `${i}:faltante`,
              productId: it.productId,
              qty: -(shortMilli / 1000),
              unitCostCents: it.unitCostCents,
              reason: 'sale',
              refId: s.saleId,
              userId: s.userId,
            });
          }
        }
        await checkNegative(q, e, it.productId, it.name);

        // Precio cambiado mientras la caja estaba desconectada: se informa, nunca se bloquea.
        const [prod] = await q.query<{ data: Product }>('SELECT data FROM products WHERE tenant_id = $1 AND id = $2', [t, it.productId]);
        if (prod) {
          let expected: number | null = null;
          try {
            expected = priceLine(prod.data, it.qty, { priceListId: priceListId ?? undefined, packId: it.packId }).unitPriceCents;
          } catch {
            expected = null;
          }
          if (expected !== null && expected !== it.unitPriceCents) {
            const diff = it.unitPriceCents - expected;
            await alert(q, t, 'price_diff', it.productId, `"${it.name}" se vendió a un precio distinto al vigente (diferencia ${diff / 100}).`, {
              saleId: s.saleId,
              soldCents: it.unitPriceCents,
              currentCents: expected,
            });
          }
        }
      }
      for (const [i, pay] of s.payments.entries()) {
        await q.query('INSERT INTO sale_payments (id, tenant_id, sale_id, method, amount_cents, reference) VALUES ($1,$2,$3,$4,$5,$6)', [
          `${s.saleId}:${i}`,
          t,
          s.saleId,
          pay.method,
          pay.amountCents,
          pay.reference ?? null,
        ]);
      }
      return;
    }

    case 'SaleVoided': {
      const updated = await q.query<{ id: string; local_number: number; total_cents: number }>(
        `UPDATE sales SET status = 'voided', voided_at = $3, void_reason = $4 WHERE tenant_id = $1 AND id = $2 AND status = 'completed' RETURNING id, local_number, total_cents`,
        [t, e.payload.saleId, e.occurredAt, e.payload.reason],
      );
      if (!updated.length) return;
      const moves = await q.query<{ product_id: string; lot_code: string | null; expires_on: string | Date | null; qty: number; unit_cost_cents: number | null }>(
        `SELECT product_id, lot_code, expires_on, qty, unit_cost_cents FROM stock_movements
         WHERE tenant_id = $1 AND ref_id = $2 AND reason = 'sale' ORDER BY id`,
        [t, e.payload.saleId],
      );
      if (moves.length) {
        for (const [i, it] of moves.entries()) {
          const exp = it.expires_on instanceof Date ? it.expires_on.toISOString().slice(0, 10) : it.expires_on ? String(it.expires_on).slice(0, 10) : null;
          await insertMovement(q, e, {
            idx: i,
            productId: it.product_id,
            qty: -Number(it.qty),
            unitCostCents: it.unit_cost_cents === null ? null : Number(it.unit_cost_cents),
            reason: 'return',
            refId: e.payload.saleId,
            userId: e.payload.userId,
            lotCode: it.lot_code,
            expiresOn: exp,
          });
        }
      } else {
        const items = await q.query<{ product_id: string; base_qty: number; unit_cost_cents: number }>(
          'SELECT product_id, base_qty, unit_cost_cents FROM sale_items WHERE tenant_id = $1 AND sale_id = $2 ORDER BY id',
          [t, e.payload.saleId],
        );
        for (const [i, it] of items.entries()) {
          await insertMovement(q, e, { idx: i, productId: it.product_id, qty: Number(it.base_qty), unitCostCents: Number(it.unit_cost_cents), reason: 'return', refId: e.payload.saleId, userId: e.payload.userId });
        }
      }
      await alert(q, t, 'sale_voided', null, `Venta anulada: ${e.payload.reason}`, { saleId: e.payload.saleId, authorizedBy: e.payload.authorizedBy, userId: e.payload.userId });
      await appendAudit(q, {
        tenantId: t,
        occurredAt: e.occurredAt,
        action: 'venta_anulada',
        actorUserId: e.payload.userId,
        authorizedBy: e.payload.authorizedBy,
        deviceId: e.deviceId,
        eventId: e.id,
        refId: e.payload.saleId,
        data: { venta: Number(updated[0].local_number), totalCents: Number(updated[0].total_cents), motivo: e.payload.reason },
      });
      return;
    }

    case 'CashSessionOpened':
      await q.query(
        `INSERT INTO cash_sessions (id, tenant_id, store_id, device_id, user_id, opened_at, opening_cents) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, id) DO NOTHING`,
        [e.payload.sessionId, t, e.storeId, e.deviceId, e.payload.userId, e.occurredAt, e.payload.openingCents],
      );
      return;

    case 'CashMovement':
      await q.query(
        `INSERT INTO cash_movements (id, tenant_id, session_id, kind, amount_cents, reason, user_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, id) DO NOTHING`,
        [e.payload.movementId, t, e.payload.sessionId, e.payload.kind, e.payload.amountCents, e.payload.reason, e.payload.userId, e.occurredAt],
      );
      return;

    case 'CashSessionClosed': {
      const p = e.payload;
      // Sólo el dispositivo que abrió el turno puede cerrarlo.
      const closed = await q.query(
        `UPDATE cash_sessions SET closed_at = $3, counted_cents = $4, expected_cents = $5, difference_cents = $6
         WHERE tenant_id = $1 AND id = $2 AND device_id = $7 AND closed_at IS NULL RETURNING id`,
        [t, p.sessionId, e.occurredAt, p.countedCents, p.expectedCents, p.differenceCents, e.deviceId],
      );
      if (closed.length && p.differenceCents !== 0) {
        await alert(q, t, 'cash_difference', null, `Cierre de caja con diferencia de ${p.differenceCents / 100}.`, { sessionId: p.sessionId, deviceId: e.deviceId });
        await appendAudit(q, {
          tenantId: t,
          occurredAt: e.occurredAt,
          action: 'cierre_con_diferencia',
          actorUserId: p.userId,
          authorizedBy: null,
          deviceId: e.deviceId,
          eventId: e.id,
          refId: p.sessionId,
          data: { esperadoCents: p.expectedCents, contadoCents: p.countedCents, diferenciaCents: p.differenceCents },
        });
      }
      return;
    }
  }
}
