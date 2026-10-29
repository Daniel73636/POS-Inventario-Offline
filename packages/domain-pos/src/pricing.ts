import { assertCents, multiplyQty, type Cents } from './money';

export const DEFAULT_PRICE_LIST = 'general';

export interface PriceEntry {
  priceListId: string;
  priceCents: Cents;
  /** Cantidad mínima para aplicar este precio (precio por volumen). */
  minQty: number;
  /** Presentación (caja x12...). null/undefined = unidad base. */
  packId?: string | null;
  /** Vigencia opcional (promociones), ISO-8601. */
  validFrom?: string | null;
  validTo?: string | null;
}

export interface Pack {
  id: string;
  name: string;
  unitsPerPack: number;
}

export interface PricedProduct {
  id: string;
  /** Precio base de la lista general por unidad. */
  priceCents: Cents;
  prices?: PriceEntry[];
  packs?: Pack[];
}

export interface PriceLineOptions {
  priceListId?: string | null;
  packId?: string | null;
  customer?: { priceListId?: string | null } | null;
  now?: Date;
}

export interface PricedLine {
  unitPriceCents: Cents;
  lineTotalCents: Cents;
  priceListId: string;
  appliedMinQty: number;
  source: 'list' | 'base' | 'pack-derived';
}

function isActive(entry: PriceEntry, now: Date): boolean {
  const t = now.getTime();
  if (entry.validFrom && Date.parse(entry.validFrom) > t) return false;
  if (entry.validTo && Date.parse(entry.validTo) < t) return false;
  return true;
}

function bestTier(entries: PriceEntry[], qty: number): PriceEntry | undefined {
  return entries
    .filter((e) => e.minQty <= qty)
    .sort((a, b) => b.minQty - a.minQty || a.priceCents - b.priceCents)[0];
}

/**
 * Precio de una línea: por presentación, por volumen y por lista.
 * Prioridad de lista: explícita > lista del cliente > general.
 * Si la lista elegida no tiene precio para el producto se usa la general.
 */
export function priceLine(
  product: PricedProduct,
  qty: number,
  options: PriceLineOptions = {},
): PricedLine {
  assertCents(product.priceCents, 'precio base');
  if (!(qty > 0)) throw new Error(`Cantidad debe ser positiva (recibido ${qty})`);
  const now = options.now ?? new Date();
  const packId = options.packId ?? null;
  const requestedList =
    options.priceListId ?? options.customer?.priceListId ?? DEFAULT_PRICE_LIST;
  const entries = (product.prices ?? []).filter(
    (p) => (p.packId ?? null) === packId && isActive(p, now),
  );

  for (const listId of unique([requestedList, DEFAULT_PRICE_LIST])) {
    const tier = bestTier(
      entries.filter((e) => e.priceListId === listId),
      qty,
    );
    if (tier) {
      return {
        unitPriceCents: tier.priceCents,
        lineTotalCents: multiplyQty(tier.priceCents, qty),
        priceListId: listId,
        appliedMinQty: tier.minQty,
        source: 'list',
      };
    }
  }

  if (packId) {
    const pack = product.packs?.find((p) => p.id === packId);
    if (!pack) throw new Error(`Presentación ${packId} no existe para ${product.id}`);
    const unit = multiplyQty(product.priceCents, pack.unitsPerPack);
    return {
      unitPriceCents: unit,
      lineTotalCents: multiplyQty(unit, qty),
      priceListId: DEFAULT_PRICE_LIST,
      appliedMinQty: 1,
      source: 'pack-derived',
    };
  }

  return {
    unitPriceCents: product.priceCents,
    lineTotalCents: multiplyQty(product.priceCents, qty),
    priceListId: DEFAULT_PRICE_LIST,
    appliedMinQty: 1,
    source: 'base',
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
