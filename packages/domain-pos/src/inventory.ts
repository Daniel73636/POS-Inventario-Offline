import { divRoundHalfEven, qtyToMilli, QTY_SCALE, type Cents } from './money';

export interface Lot {
  id: string;
  qty: number;
  /** YYYY-MM-DD; null = no vence. */
  expiresOn?: string | null;
}

export interface LotAllocation {
  lotId: string;
  qty: number;
}

export interface LotAllocationResult {
  allocations: LotAllocation[];
  /** Cantidad que no se pudo cubrir con lotes vigentes (se vende igual: stock negativo). */
  shortfall: number;
  blockedLotIds: string[];
}

/**
 * Asigna cantidad a lotes por FEFO (primero en vencer, primero en salir).
 * Los lotes vencidos (expiresOn < hoy) quedan bloqueados.
 */
export function allocateLots(qty: number, lots: Lot[], today: string): LotAllocationResult {
  if (!(qty > 0)) throw new Error('La cantidad a asignar debe ser positiva');
  const blockedLotIds = lots
    .filter((l) => l.expiresOn && l.expiresOn < today && l.qty > 0)
    .map((l) => l.id);
  const usable = lots
    .filter((l) => l.qty > 0 && !blockedLotIds.includes(l.id))
    .sort((a, b) => {
      const ea = a.expiresOn ?? '9999-12-31';
      const eb = b.expiresOn ?? '9999-12-31';
      return ea < eb ? -1 : ea > eb ? 1 : a.id < b.id ? -1 : 1;
    });

  let remainingMilli = qtyToMilli(qty);
  const allocations: LotAllocation[] = [];
  for (const lot of usable) {
    if (remainingMilli <= 0) break;
    const take = Math.min(remainingMilli, qtyToMilli(lot.qty));
    allocations.push({ lotId: lot.id, qty: take / QTY_SCALE });
    remainingMilli -= take;
  }
  return { allocations, shortfall: remainingMilli / QTY_SCALE, blockedLotIds };
}

/**
 * Costo promedio ponderado tras una entrada de mercancía.
 * Si el stock previo es <= 0 (p. ej. negativo por ventas offline) el nuevo
 * costo es el de la entrada.
 */
export function averageCost(
  previousQty: number,
  previousCostCents: Cents,
  receivedQty: number,
  receivedCostCents: Cents,
): Cents {
  if (!(receivedQty > 0)) return previousCostCents;
  if (previousQty <= 0) return receivedCostCents;
  const pq = BigInt(qtyToMilli(previousQty));
  const rq = BigInt(qtyToMilli(receivedQty));
  return divRoundHalfEven(
    pq * BigInt(previousCostCents) + rq * BigInt(receivedCostCents),
    pq + rq,
  );
}

export interface StockMovementLike {
  productId: string;
  qty: number;
}

/** Inventario = suma de movimientos (contador tipo CRDT). */
export function stockLevels(movements: StockMovementLike[]): Record<string, number> {
  const milli: Record<string, number> = {};
  for (const m of movements) milli[m.productId] = (milli[m.productId] ?? 0) + qtyToMilli(m.qty);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(milli)) out[k] = v / QTY_SCALE;
  return out;
}

export function addQty(a: number, b: number): number {
  return (qtyToMilli(a) + qtyToMilli(b)) / QTY_SCALE;
}
