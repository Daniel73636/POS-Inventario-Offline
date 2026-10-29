import { assertCents, type Cents } from './money';

export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'credit';

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  transfer: 'Transferencia',
  credit: 'Crédito',
};

/** Atajos de teclado del diálogo de pago. */
export const PAYMENT_METHOD_KEYS: Record<string, PaymentMethod> = {
  e: 'cash',
  t: 'card',
  r: 'transfer',
  c: 'credit',
};

export interface PaymentInput {
  method: PaymentMethod;
  /** Monto entregado (en efectivo puede superar el total). */
  amountCents: Cents;
  reference?: string | null;
}

export interface SplitPaymentsResult {
  ok: boolean;
  paidCents: Cents;
  remainingCents: Cents;
  changeCents: Cents;
  /** Pagos aplicados a la venta (el efectivo descontando el cambio). */
  applied: PaymentInput[];
  errors: string[];
}

/**
 * Valida un pago mixto y calcula el cambio.
 * Reglas: solo el efectivo da cambio; los medios no-efectivo no pueden
 * superar el total; montos enteros positivos.
 */
export function splitPayments(totalCents: Cents, payments: PaymentInput[]): SplitPaymentsResult {
  assertCents(totalCents, 'total');
  const errors: string[] = [];
  for (const p of payments) {
    if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) {
      errors.push(`Monto inválido para ${p.method}`);
    }
  }
  const paid = payments.reduce((s, p) => s + p.amountCents, 0);
  const nonCash = payments.filter((p) => p.method !== 'cash').reduce((s, p) => s + p.amountCents, 0);
  if (nonCash > totalCents) errors.push('Los pagos sin efectivo superan el total (no dan cambio)');

  const remaining = Math.max(0, totalCents - paid);
  const change = errors.length ? 0 : Math.max(0, paid - totalCents);

  // Descontar el cambio de los pagos en efectivo, empezando por el último.
  let changeLeft = change;
  const applied = [...payments]
    .reverse()
    .map((p) => {
      if (p.method !== 'cash' || changeLeft === 0) return { ...p };
      const reduce = Math.min(changeLeft, p.amountCents);
      changeLeft -= reduce;
      return { ...p, amountCents: p.amountCents - reduce };
    })
    .reverse()
    .filter((p) => p.amountCents > 0);

  return {
    ok: errors.length === 0 && remaining === 0,
    paidCents: paid,
    remainingCents: remaining,
    changeCents: change,
    applied,
    errors,
  };
}

/** Billetes rápidos sugeridos (COP) mayores o iguales al total. */
export function quickCashOptions(totalCents: Cents, bills: Cents[] = [200000, 500000, 1000000, 2000000, 5000000, 10000000]): Cents[] {
  const options = new Set<Cents>([totalCents]);
  for (const bill of bills) {
    const rounded = Math.ceil(totalCents / bill) * bill;
    if (rounded >= totalCents) options.add(rounded);
  }
  return [...options].sort((a, b) => a - b).slice(0, 6);
}
