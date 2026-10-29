import { computeCartTotals, type Cart, type CartTotals } from './cart';
import { multiplyQty, QTY_SCALE, qtyToMilli, type Cents } from './money';
import { splitPayments, type PaymentInput, type PaymentMethod } from './payments';
import { DEFAULT_TAX_CONFIG, type TaxConfig } from './taxes';

export interface SaleItemDraft {
  productId: string;
  name: string;
  packId: string | null;
  qty: number;
  /** Unidades base que salen del inventario (qty × unidades de la presentación). */
  baseQty: number;
  unitPriceCents: Cents;
  unitCostCents: Cents;
  discountCents: Cents;
  taxRateBp: number;
  taxCents: Cents;
  lineTotalCents: Cents;
}

export interface SaleDraft {
  customerId: string | null;
  subtotalCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  changeCents: Cents;
  items: SaleItemDraft[];
  payments: Array<{ method: PaymentMethod; amountCents: Cents; reference?: string | null }>;
}

export type FinalizeResult =
  | { ok: true; sale: SaleDraft; totals: CartTotals }
  | { ok: false; errors: string[] };

/** Convierte carrito + pagos en el contenido inmutable de SaleCompleted. */
export function finalizeSale(
  cart: Cart,
  payments: PaymentInput[],
  taxConfig: TaxConfig = DEFAULT_TAX_CONFIG,
): FinalizeResult {
  if (cart.lines.length === 0) return { ok: false, errors: ['El carrito está vacío'] };
  const totals = computeCartTotals(cart, taxConfig);
  const split = splitPayments(totals.totalCents, payments);
  if (!split.ok) {
    const errors = [...split.errors];
    if (split.remainingCents > 0) errors.push(`Falta por pagar ${split.remainingCents} centavos`);
    return { ok: false, errors };
  }
  if (split.applied.some((p) => p.method === 'credit') && !cart.customerId) {
    return { ok: false, errors: ['La venta a crédito requiere un cliente'] };
  }
  const items = cart.lines.map((l, i) => {
    const t = totals.lines[i];
    const unitsPerPack = l.packId ? l.pricing.packs?.find((p) => p.id === l.packId)?.unitsPerPack ?? 1 : 1;
    return {
      productId: l.productId,
      name: l.name,
      packId: l.packId,
      qty: l.qty,
      baseQty: (qtyToMilli(l.qty) * unitsPerPack) / QTY_SCALE,
      unitPriceCents: l.unitPriceCents,
      unitCostCents: l.unitCostCents,
      discountCents: t.discountCents,
      taxRateBp: l.taxRateBp,
      taxCents: t.taxCents,
      lineTotalCents: t.totalCents,
    };
  });
  return {
    ok: true,
    totals,
    sale: {
      customerId: cart.customerId,
      subtotalCents: totals.grossCents,
      discountCents: totals.discountCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      changeCents: split.changeCents,
      items,
      payments: split.applied.map((p) => ({ method: p.method, amountCents: p.amountCents, reference: p.reference ?? null })),
    },
  };
}

export interface ProfitInput {
  items: Array<{ qty: number; unitCostCents: Cents; lineTotalCents: Cents; taxCents: Cents }>;
}

export interface ProfitResult {
  revenueCents: Cents;
  costCents: Cents;
  profitCents: Cents;
  /** Margen sobre ingreso neto, en puntos básicos. */
  marginBp: number;
}

/** Utilidad de una venta usando los costos congelados en sus ítems (sin impuestos). */
export function profitOfSale(sale: ProfitInput): ProfitResult {
  const revenue = sale.items.reduce((s, i) => s + (i.lineTotalCents - i.taxCents), 0);
  const cost = sale.items.reduce((s, i) => s + multiplyQty(i.unitCostCents, i.qty), 0);
  const profit = revenue - cost;
  return {
    revenueCents: revenue,
    costCents: cost,
    profitCents: profit,
    marginBp: revenue === 0 ? 0 : Math.round((profit * 10000) / revenue),
  };
}
