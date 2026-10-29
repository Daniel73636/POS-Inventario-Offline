/**
 * Dinero: SIEMPRE enteros en la unidad mínima (centavos).
 * Las cantidades (kg, l) pueden ser decimales; se convierten a milésimas
 * para multiplicar sin errores de coma flotante.
 */
export type Cents = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export const QTY_SCALE = 1000;

export function assertCents(value: number, label = 'importe'): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} debe ser un entero en centavos (recibido ${value})`);
  }
  return value;
}

/** Cantidad a milésimas enteras (0.755 kg -> 755). */
export function qtyToMilli(qty: number): number {
  if (!Number.isFinite(qty)) throw new MoneyError(`Cantidad inválida: ${qty}`);
  return Math.round(qty * QTY_SCALE);
}

/** División entera con redondeo bancario (half-even). Exacta con BigInt. */
export function divRoundHalfEven(numerator: number | bigint, denominator: number | bigint): number {
  let n = BigInt(numerator);
  let d = BigInt(denominator);
  if (d === 0n) throw new MoneyError('División por cero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n;
  const absN = negative ? -n : n;
  let q = absN / d;
  const r = absN % d;
  const twice = r * 2n;
  if (twice > d || (twice === d && q % 2n === 1n)) q += 1n;
  const result = negative ? -q : q;
  return Number(result);
}

/** Redondeo bancario de un número (para entradas ya calculadas). */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  const EPS = 1e-9;
  if (diff > 0.5 + EPS) return floor + 1;
  if (diff < 0.5 - EPS) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** precio unitario (centavos) × cantidad (posiblemente decimal) -> centavos. */
export function multiplyQty(unitCents: Cents, qty: number): Cents {
  assertCents(unitCents, 'precio unitario');
  return divRoundHalfEven(BigInt(unitCents) * BigInt(qtyToMilli(qty)), QTY_SCALE);
}

/** amount × bp / 10000 (bp = puntos básicos, 1900 = 19 %). */
export function percentBp(amountCents: Cents, bp: number): Cents {
  assertCents(amountCents);
  if (!Number.isInteger(bp)) throw new MoneyError(`Puntos básicos inválidos: ${bp}`);
  return divRoundHalfEven(BigInt(amountCents) * BigInt(bp), 10000);
}

/**
 * Reparte `total` proporcionalmente a `weights` (método del mayor residuo).
 * La suma del resultado es exactamente `total`.
 */
export function allocateProportionally(total: Cents, weights: number[]): Cents[] {
  assertCents(total);
  if (weights.length === 0) return [];
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) {
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  const raw = weights.map((w) => (total * w) / sumW);
  const floored = raw.map((r) => Math.floor(r));
  let remainder = total - floored.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) {
    floored[order[k].i] += 1;
  }
  return floored;
}

export function sumCents(values: Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Formato para mostrar. COP no usa decimales en la práctica: se ocultan
 * si el importe es entero en pesos.
 */
export function formatMoney(cents: Cents, currency = 'COP', locale = 'es-CO'): string {
  const showDecimals = cents % 100 !== 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: showDecimals ? 2 : 0,
  }).format(cents / 100);
}

/**
 * Convierte texto escrito por el cajero (formato es-CO) a centavos.
 * "3.500" -> 350000, "3500" -> 350000, "3.500,50" -> 350050, "12,5" -> 1250.
 */
export function parseMoney(input: string): Cents | null {
  const clean = input.replace(/[$\s]/g, '').replace(/COP/i, '');
  if (!clean) return null;
  if (!/^-?[\d.,]+$/.test(clean)) return null;
  const [intPartRaw, decPartRaw = ''] = clean.split(',');
  const intPart = intPartRaw.replace(/\./g, '');
  if (clean.split(',').length > 2 || !/^-?\d*$/.test(intPart)) return null;
  const decPart = (decPartRaw + '00').slice(0, 2);
  if (!/^\d{2}$/.test(decPart)) return null;
  const negative = intPart.startsWith('-');
  const pesos = Number(intPart.replace('-', '') || '0');
  const cents = pesos * 100 + Number(decPart);
  return negative ? -cents : cents;
}

export function pesos(value: number): Cents {
  return Math.round(value * 100);
}
