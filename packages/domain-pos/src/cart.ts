import { allocateProportionally, multiplyQty, percentBp, type Cents } from './money';
import { DEFAULT_PRICE_LIST, priceLine, type PricedProduct } from './pricing';
import { quotePromotion, type Promotion } from './promotions';
import { computeTaxes, DEFAULT_TAX_CONFIG, type TaxConfig } from './taxes';

export type Role = 'cashier' | 'supervisor' | 'owner';

/** Descuento máximo permitido por rol, en puntos básicos sobre el bruto. */
export const ROLE_DISCOUNT_LIMIT_BP: Record<Role, number> = {
  cashier: 1000,
  supervisor: 3000,
  owner: 10000,
};

export interface CartProduct extends PricedProduct {
  name: string;
  unit?: string;
  costAvgCents: Cents;
  taxRateBp: number;
  taxIncluded: boolean;
}

export interface CartLine {
  lineId: string;
  productId: string;
  name: string;
  unit: string;
  qty: number;
  packId: string | null;
  unitPriceCents: Cents;
  /** Costo congelado al momento de vender (utilidad exacta). */
  unitCostCents: Cents;
  taxRateBp: number;
  taxIncluded: boolean;
  discountCents: Cents;
  priceListId: string;
  manualPrice: boolean;
  pricing: PricedProduct;
  /** 2x1 elegido en la caja. Ausente = ninguna. El precio por volumen sigue en `priceLine`. */
  promotion?: Promotion | null;
}

export interface Cart {
  lines: CartLine[];
  cartDiscountCents: Cents;
  customerId: string | null;
  priceListId: string;
}

export function emptyCart(priceListId: string = DEFAULT_PRICE_LIST): Cart {
  return { lines: [], cartDiscountCents: 0, customerId: null, priceListId };
}

export function lineIdFor(productId: string, packId?: string | null): string {
  return `${productId}|${packId ?? ''}`;
}

function reprice(line: CartLine, priceListId: string, now?: Date): CartLine {
  if (line.manualPrice) return line;
  const p = priceLine(line.pricing, line.qty, { priceListId, packId: line.packId, now });
  return { ...line, unitPriceCents: p.unitPriceCents, priceListId: p.priceListId };
}

export function addToCart(
  cart: Cart,
  product: CartProduct,
  qty = 1,
  opts: { packId?: string | null; now?: Date } = {},
): Cart {
  const packId = opts.packId ?? null;
  const lineId = lineIdFor(product.id, packId);
  const existing = cart.lines.find((l) => l.lineId === lineId);
  if (existing) {
    return setLineQty(cart, lineId, existing.qty + qty, opts.now);
  }
  const unitsPerPack = packId ? product.packs?.find((p) => p.id === packId)?.unitsPerPack ?? 1 : 1;
  const line: CartLine = reprice(
    {
      lineId,
      productId: product.id,
      name: product.name,
      unit: product.unit ?? 'unit',
      qty,
      packId,
      unitPriceCents: 0,
      unitCostCents: multiplyQty(product.costAvgCents, unitsPerPack),
      taxRateBp: product.taxRateBp,
      taxIncluded: product.taxIncluded,
      discountCents: 0,
      priceListId: cart.priceListId,
      manualPrice: false,
      pricing: { id: product.id, priceCents: product.priceCents, prices: product.prices, packs: product.packs },
    },
    cart.priceListId,
    opts.now,
  );
  return { ...cart, lines: [...cart.lines, line] };
}

export function setLineQty(cart: Cart, lineId: string, qty: number, now?: Date): Cart {
  if (!(qty > 0)) return removeLine(cart, lineId);
  return {
    ...cart,
    lines: cart.lines.map((l) => {
      if (l.lineId !== lineId) return l;
      const next = reprice({ ...l, qty }, cart.priceListId, now);
      return { ...next, discountCents: Math.min(next.discountCents, lineGross(next)) };
    }),
  };
}

export function removeLine(cart: Cart, lineId: string): Cart {
  return { ...cart, lines: cart.lines.filter((l) => l.lineId !== lineId) };
}

/** Activa o quita un 2x1 en la línea. Otras promociones no se aplican aquí. */
export function setLinePromotion(cart: Cart, lineId: string, promotion: Promotion | null): Cart {
  return {
    ...cart,
    lines: cart.lines.map((l) => {
      if (l.lineId !== lineId) return l;
      if (!promotion || promotion.kind !== 'bogo' || promotion.productId !== l.productId) return { ...l, promotion: null };
      return { ...l, promotion };
    }),
  };
}

function bogoDiscount(line: CartLine): Cents {
  const promo = line.promotion;
  if (!promo || promo.kind !== 'bogo' || promo.productId !== line.productId) return 0;
  try {
    return quotePromotion(line.productId, line.qty, line.unitPriceCents, [promo]).discountCents;
  } catch {
    return 0;
  }
}

export function setLinePrice(cart: Cart, lineId: string, unitPriceCents: Cents): Cart {
  return {
    ...cart,
    lines: cart.lines.map((l) => (l.lineId === lineId ? { ...l, unitPriceCents, manualPrice: true } : l)),
  };
}

export function setCustomer(
  cart: Cart,
  customer: { id: string; priceListId?: string | null } | null,
  now?: Date,
): Cart {
  const priceListId = customer?.priceListId ?? DEFAULT_PRICE_LIST;
  return {
    ...cart,
    customerId: customer?.id ?? null,
    priceListId,
    lines: cart.lines.map((l) => reprice(l, priceListId, now)),
  };
}

export function lineGross(line: Pick<CartLine, 'unitPriceCents' | 'qty'>): Cents {
  return multiplyQty(line.unitPriceCents, line.qty);
}

export function cartGross(cart: Cart): Cents {
  return cart.lines.reduce((s, l) => s + lineGross(l), 0);
}

export type DiscountRule =
  | { type: 'percent'; bp: number; scope: 'cart' }
  | { type: 'amount'; cents: Cents; scope: 'cart' }
  | { type: 'percent'; bp: number; scope: 'line'; lineId: string }
  | { type: 'amount'; cents: Cents; scope: 'line'; lineId: string };

export type DiscountResult =
  | { ok: true; cart: Cart; discountCents: Cents }
  | { ok: false; reason: 'exceeds_role_limit'; requiredRole: Role; discountCents: Cents }
  | { ok: false; reason: 'invalid'; message: string };

function requiredRoleFor(bp: number): Role {
  if (bp <= ROLE_DISCOUNT_LIMIT_BP.cashier) return 'cashier';
  if (bp <= ROLE_DISCOUNT_LIMIT_BP.supervisor) return 'supervisor';
  return 'owner';
}

const ROLE_RANK: Record<Role, number> = { cashier: 0, supervisor: 1, owner: 2 };

/**
 * Aplica un descuento validando el límite del rol. El límite se evalúa sobre
 * el descuento total resultante frente al bruto del alcance (línea o carrito).
 */
export function applyDiscount(cart: Cart, rule: DiscountRule, role: Role): DiscountResult {
  const value = rule.type === 'percent' ? rule.bp : rule.cents;
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, reason: 'invalid', message: 'Valor de descuento inválido' };
  }

  if (rule.scope === 'line') {
    const line = cart.lines.find((l) => l.lineId === rule.lineId);
    if (!line) return { ok: false, reason: 'invalid', message: 'Línea no existe' };
    const gross = lineGross(line);
    const discount = rule.type === 'percent' ? percentBp(gross, rule.bp) : rule.cents;
    if (discount > gross) return { ok: false, reason: 'invalid', message: 'El descuento supera el valor de la línea' };
    const bp = gross === 0 ? 0 : Math.ceil((discount * 10000) / gross);
    const needed = requiredRoleFor(bp);
    if (ROLE_RANK[needed] > ROLE_RANK[role]) {
      return { ok: false, reason: 'exceeds_role_limit', requiredRole: needed, discountCents: discount };
    }
    return {
      ok: true,
      discountCents: discount,
      cart: { ...cart, lines: cart.lines.map((l) => (l.lineId === line.lineId ? { ...l, discountCents: discount } : l)) },
    };
  }

  const gross = cartGross(cart);
  const lineDiscounts = cart.lines.reduce((s, l) => s + l.discountCents, 0);
  const base = gross - lineDiscounts;
  const discount = rule.type === 'percent' ? percentBp(base, rule.bp) : rule.cents;
  if (discount > base) return { ok: false, reason: 'invalid', message: 'El descuento supera el total' };
  const totalBp = gross === 0 ? 0 : Math.ceil(((discount + lineDiscounts) * 10000) / gross);
  const needed = requiredRoleFor(totalBp);
  if (ROLE_RANK[needed] > ROLE_RANK[role]) {
    return { ok: false, reason: 'exceeds_role_limit', requiredRole: needed, discountCents: discount };
  }
  return { ok: true, discountCents: discount, cart: { ...cart, cartDiscountCents: discount } };
}

export interface CartLineTotals {
  lineId: string;
  grossCents: Cents;
  discountCents: Cents;
  netCents: Cents;
  baseCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
}

export interface CartTotals {
  itemCount: number;
  grossCents: Cents;
  discountCents: Cents;
  baseCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  byRate: Array<{ taxRateBp: number; baseCents: Cents; taxCents: Cents }>;
  lines: CartLineTotals[];
}

/** Totales del carrito: bruto, descuentos (línea + carrito prorrateado), impuestos y total. */
export function computeCartTotals(cart: Cart, taxConfig: TaxConfig = DEFAULT_TAX_CONFIG): CartTotals {
  const gross = cart.lines.map(lineGross);
  const promo = cart.lines.map((l, i) => Math.min(bogoDiscount(l), gross[i]));
  const manual = cart.lines.map((l, i) => Math.min(l.discountCents, gross[i] - promo[i]));
  const afterLine = gross.map((g, i) => g - manual[i] - promo[i]);
  const cartShare = allocateProportionally(cart.cartDiscountCents, afterLine);
  const net = afterLine.map((v, i) => v - (cartShare[i] ?? 0));
  const taxes = computeTaxes(
    cart.lines.map((l, i) => ({ amountCents: net[i], taxRateBp: l.taxRateBp, taxIncluded: l.taxIncluded })),
    taxConfig,
  );
  const lines = cart.lines.map((l, i) => ({
    lineId: l.lineId,
    grossCents: gross[i],
    discountCents: manual[i] + promo[i] + (cartShare[i] ?? 0),
    netCents: net[i],
    baseCents: taxes.lines[i].baseCents,
    taxCents: taxes.lines[i].taxCents,
    totalCents: taxes.lines[i].totalCents,
  }));
  return {
    itemCount: cart.lines.reduce((s, l) => s + (l.unit === 'unit' ? l.qty : 1), 0),
    grossCents: gross.reduce((a, b) => a + b, 0),
    discountCents: lines.reduce((s, l) => s + l.discountCents, 0),
    baseCents: taxes.baseCents,
    taxCents: taxes.taxCents,
    totalCents: taxes.totalCents,
    byRate: taxes.byRate,
    lines,
  };
}
