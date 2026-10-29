import type { Cents } from './money';
import type { PaymentMethod } from './payments';

export interface CashSessionInput {
  openingCents: Cents;
  /** Pagos aplicados de ventas completadas (no anuladas) del turno. */
  salePayments: Array<{ method: PaymentMethod; amountCents: Cents }>;
  movements: Array<{ kind: 'in' | 'out'; amountCents: Cents }>;
  /** Devoluciones en efectivo del turno. */
  cashRefundsCents?: Cents;
}

export interface CashExpectedResult {
  expectedCents: Cents;
  cashSalesCents: Cents;
  inCents: Cents;
  outCents: Cents;
  byMethod: Record<PaymentMethod, Cents>;
}

/** Efectivo esperado en el cierre = base + ventas en efectivo + ingresos − retiros − devoluciones. */
export function cashExpected(session: CashSessionInput): CashExpectedResult {
  const byMethod: Record<PaymentMethod, Cents> = { cash: 0, card: 0, transfer: 0, credit: 0 };
  for (const p of session.salePayments) byMethod[p.method] += p.amountCents;
  const inCents = session.movements.filter((m) => m.kind === 'in').reduce((s, m) => s + m.amountCents, 0);
  const outCents = session.movements.filter((m) => m.kind === 'out').reduce((s, m) => s + m.amountCents, 0);
  return {
    expectedCents: session.openingCents + byMethod.cash + inCents - outCents - (session.cashRefundsCents ?? 0),
    cashSalesCents: byMethod.cash,
    inCents,
    outCents,
    byMethod,
  };
}

export const COP_DENOMINATIONS: Cents[] = [
  10000000, 5000000, 2000000, 1000000, 500000, 200000, 100000, 50000, 20000, 10000, 5000,
];

/** Total de un conteo por denominación: { [centavos]: cantidad }. */
export function countDenominations(counts: Record<string, number>): Cents {
  return Object.entries(counts).reduce((s, [den, n]) => s + Number(den) * Math.max(0, Math.floor(n || 0)), 0);
}
