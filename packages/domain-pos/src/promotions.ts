import { multiplyQty, type Cents } from './money';

/** 2x1 y similares: cada `buy` unidades se cobran `pay` (2x1 = buy 2, pay 1). */
export interface BogoPromotion {
  id: string;
  kind: 'bogo';
  productId: string;
  buy: number;
  pay: number;
}

/** Precio unitario a partir de una cantidad. El precio por volumen de lista sigue en `priceLine`. */
export interface VolumePromotion {
  id: string;
  kind: 'volume';
  productId: string;
  minQty: number;
  unitPriceCents: Cents;
}

export type Promotion = BogoPromotion | VolumePromotion;

export interface PromotionQuote {
  promotionId: string | null;
  kind: 'bogo' | 'volume' | null;
  unitPriceCents: Cents;
  discountCents: Cents;
  /** Unidades que no se cobran. */
  freeQty: number;
  payableQty: number;
}

/**
 * Elige la promoción de este producto que más descuenta.
 * En la caja, un 2x1 elegido en la línea entra por `setLinePromotion`.
 * El precio por volumen de catálogo sigue en `priceLine` y no se vuelve a aplicar aquí.
 */
export function quotePromotion(productId: string, qty: number, unitPriceCents: Cents, promotions: Promotion[]): PromotionQuote {
  if (!(qty > 0)) throw new Error('La cantidad de la promoción debe ser positiva');
  let best = emptyQuote(unitPriceCents, qty);
  for (const promo of promotions) {
    if (promo.productId !== productId) continue;
    const quote = promo.kind === 'bogo' ? quoteBogo(qty, unitPriceCents, promo) : quoteVolume(qty, unitPriceCents, promo);
    if (quote.discountCents > best.discountCents) best = quote;
  }
  return best;
}

function emptyQuote(unitPriceCents: Cents, qty: number): PromotionQuote {
  return { promotionId: null, kind: null, unitPriceCents, discountCents: 0, freeQty: 0, payableQty: qty };
}

function quoteBogo(qty: number, unitPriceCents: Cents, promo: BogoPromotion): PromotionQuote {
  if (!Number.isInteger(promo.buy) || !Number.isInteger(promo.pay) || !(promo.buy > promo.pay) || promo.pay < 0) {
    throw new Error('Una promoción NxM exige buy y pay enteros con buy > pay');
  }
  const groups = Math.floor(qty / promo.buy);
  const freeQty = groups * (promo.buy - promo.pay);
  return {
    promotionId: promo.id,
    kind: 'bogo',
    unitPriceCents,
    discountCents: multiplyQty(unitPriceCents, freeQty),
    freeQty,
    payableQty: qty - freeQty,
  };
}

function quoteVolume(qty: number, unitPriceCents: Cents, promo: VolumePromotion): PromotionQuote {
  if (!(promo.minQty > 0)) throw new Error('La cantidad mínima de la promoción por volumen debe ser positiva');
  if (qty < promo.minQty || promo.unitPriceCents >= unitPriceCents) return emptyQuote(unitPriceCents, qty);
  return {
    promotionId: promo.id,
    kind: 'volume',
    unitPriceCents: promo.unitPriceCents,
    discountCents: multiplyQty(unitPriceCents - promo.unitPriceCents, qty),
    freeQty: 0,
    payableQty: qty,
  };
}
