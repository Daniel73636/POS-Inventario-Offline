import { divRoundHalfEven, percentBp, type Cents } from './money';

export interface TaxLineInput {
  /** Importe neto de la línea tras descuentos (con o sin impuesto según taxIncluded). */
  amountCents: Cents;
  /** Tarifa en puntos básicos: 1900 = IVA 19 %, 800 = INC 8 %, 0 = exento. */
  taxRateBp: number;
  taxIncluded: boolean;
}

export interface TaxConfig {
  /** Redondeo por línea o por total (agrupado por tarifa), según norma local. */
  rounding: 'line' | 'total';
}

export interface TaxLineResult {
  baseCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
}

export interface TaxSummary {
  baseCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  lines: TaxLineResult[];
  byRate: Array<{ taxRateBp: number; baseCents: Cents; taxCents: Cents }>;
}

export const DEFAULT_TAX_CONFIG: TaxConfig = { rounding: 'line' };

export function splitTax(amountCents: Cents, rateBp: number, included: boolean): TaxLineResult {
  if (rateBp === 0) return { baseCents: amountCents, taxCents: 0, totalCents: amountCents };
  if (included) {
    const base = divRoundHalfEven(BigInt(amountCents) * 10000n, 10000 + rateBp);
    return { baseCents: base, taxCents: amountCents - base, totalCents: amountCents };
  }
  const tax = percentBp(amountCents, rateBp);
  return { baseCents: amountCents, taxCents: tax, totalCents: amountCents + tax };
}

/**
 * Impuestos de un conjunto de líneas: IVA incluido o no, INC, exentos.
 * - rounding 'line': cada línea redondea su impuesto.
 * - rounding 'total': se agrupa por (tarifa, incluido) y se redondea una vez
 *   por grupo; el impuesto se reparte a las líneas por mayor residuo.
 */
export function computeTaxes(lines: TaxLineInput[], config: TaxConfig = DEFAULT_TAX_CONFIG): TaxSummary {
  let results: TaxLineResult[];
  if (config.rounding === 'line') {
    results = lines.map((l) => splitTax(l.amountCents, l.taxRateBp, l.taxIncluded));
  } else {
    results = lines.map(() => ({ baseCents: 0, taxCents: 0, totalCents: 0 }));
    const groups = new Map<string, number[]>();
    lines.forEach((l, i) => {
      const key = `${l.taxRateBp}|${l.taxIncluded}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    });
    for (const idxs of groups.values()) {
      const first = lines[idxs[0]];
      const amount = idxs.reduce((s, i) => s + lines[i].amountCents, 0);
      const group = splitTax(amount, first.taxRateBp, first.taxIncluded);
      let taxLeft = group.taxCents;
      idxs.forEach((i, k) => {
        const l = lines[i];
        const isLast = k === idxs.length - 1;
        const tax = isLast
          ? taxLeft
          : amount === 0
            ? 0
            : divRoundHalfEven(BigInt(group.taxCents) * BigInt(l.amountCents), amount);
        taxLeft -= tax;
        results[i] = l.taxIncluded
          ? { baseCents: l.amountCents - tax, taxCents: tax, totalCents: l.amountCents }
          : { baseCents: l.amountCents, taxCents: tax, totalCents: l.amountCents + tax };
      });
    }
  }

  const byRateMap = new Map<number, { baseCents: number; taxCents: number }>();
  results.forEach((r, i) => {
    const rate = lines[i].taxRateBp;
    const acc = byRateMap.get(rate) ?? { baseCents: 0, taxCents: 0 };
    acc.baseCents += r.baseCents;
    acc.taxCents += r.taxCents;
    byRateMap.set(rate, acc);
  });

  return {
    baseCents: results.reduce((s, r) => s + r.baseCents, 0),
    taxCents: results.reduce((s, r) => s + r.taxCents, 0),
    totalCents: results.reduce((s, r) => s + r.totalCents, 0),
    lines: results,
    byRate: [...byRateMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([taxRateBp, v]) => ({ taxRateBp, ...v })),
  };
}
