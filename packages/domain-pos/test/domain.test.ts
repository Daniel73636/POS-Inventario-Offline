import { describe, expect, it } from 'vitest';
import {
  addToCart,
  allocateLots,
  allocateProportionally,
  applyDiscount,
  averageCost,
  cashExpected,
  computeCartTotals,
  computeTaxes,
  countDenominations,
  divRoundHalfEven,
  emptyCart,
  finalizeSale,
  formatMoney,
  multiplyQty,
  parseMoney,
  priceLine,
  profitOfSale,
  quickCashOptions,
  removeLine,
  setCustomer,
  setLineQty,
  splitPayments,
  splitTax,
  stockLevels,
  type CartProduct,
} from '../src';

describe('money', () => {
  it('redondeo bancario exacto', () => {
    expect(divRoundHalfEven(5, 2)).toBe(2);
    expect(divRoundHalfEven(7, 2)).toBe(4);
    expect(divRoundHalfEven(-5, 2)).toBe(-2);
    expect(divRoundHalfEven(10, 3)).toBe(3);
    expect(divRoundHalfEven(11, 3)).toBe(4);
  });

  it('multiplica precio por cantidad decimal sin floats', () => {
    expect(multiplyQty(1290000, 0.755)).toBe(973950);
    expect(multiplyQty(333, 0.5)).toBe(166);
    expect(multiplyQty(335, 0.5)).toBe(168);
    expect(multiplyQty(250000, 3)).toBe(750000);
    // 0.1 + 0.2 no rompe nada
    expect(multiplyQty(100, 0.1 + 0.2)).toBe(30);
  });

  it('rechaza importes no enteros', () => {
    expect(() => multiplyQty(10.5, 1)).toThrow();
  });

  it('reparte proporcionalmente conservando la suma', () => {
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
    const parts = allocateProportionally(120000, [700000, 500000]);
    expect(parts).toEqual([70000, 50000]);
    expect(allocateProportionally(7, [0, 0])).toEqual([7, 0]);
  });

  it('parsea y formatea pesos colombianos', () => {
    expect(parseMoney('3.500')).toBe(350000);
    expect(parseMoney('3500')).toBe(350000);
    expect(parseMoney('$ 3.500,50')).toBe(350050);
    expect(parseMoney('12,5')).toBe(1250);
    expect(parseMoney('abc')).toBeNull();
    expect(formatMoney(350000).replace(/\s/g, ' ')).toMatch(/3\.500/);
  });
});

const arroz: CartProduct = {
  id: 'p-arroz',
  name: 'Arroz 500 g',
  priceCents: 250000,
  costAvgCents: 180000,
  taxRateBp: 0,
  taxIncluded: true,
  prices: [
    { priceListId: 'general', minQty: 1, priceCents: 250000 },
    { priceListId: 'general', minQty: 12, priceCents: 220000 },
    { priceListId: 'mayorista', minQty: 1, priceCents: 210000 },
    { priceListId: 'general', minQty: 1, priceCents: 1350000, packId: 'six' },
    { priceListId: 'general', minQty: 1, priceCents: 100, validTo: '2020-01-01T00:00:00Z' },
  ],
  packs: [
    { id: 'six', name: 'Paca x6', unitsPerPack: 6 },
    { id: 'box', name: 'Caja x24', unitsPerPack: 24 },
  ],
};

describe('priceLine', () => {
  it('precio base, volumen, lista y presentación', () => {
    expect(priceLine(arroz, 1).unitPriceCents).toBe(250000);
    const vol = priceLine(arroz, 12);
    expect(vol.unitPriceCents).toBe(220000);
    expect(vol.lineTotalCents).toBe(2640000);
    expect(priceLine(arroz, 1, { customer: { priceListId: 'mayorista' } }).unitPriceCents).toBe(210000);
    expect(priceLine(arroz, 1, { priceListId: 'vip' }).priceListId).toBe('general');
    expect(priceLine(arroz, 2, { packId: 'six' }).lineTotalCents).toBe(2700000);
    const box = priceLine(arroz, 1, { packId: 'box' });
    expect(box.unitPriceCents).toBe(6000000);
    expect(box.source).toBe('pack-derived');
  });

  it('ignora promociones vencidas y cantidades inválidas', () => {
    expect(priceLine(arroz, 1, { now: new Date('2026-10-29') }).unitPriceCents).toBe(250000);
    expect(() => priceLine(arroz, 0)).toThrow();
  });
});

describe('computeTaxes', () => {
  it('IVA incluido y excluido', () => {
    expect(splitTax(119000, 1900, true)).toEqual({ baseCents: 100000, taxCents: 19000, totalCents: 119000 });
    expect(splitTax(350000, 1900, true)).toEqual({ baseCents: 294118, taxCents: 55882, totalCents: 350000 });
    expect(splitTax(100000, 1900, false)).toEqual({ baseCents: 100000, taxCents: 19000, totalCents: 119000 });
    expect(splitTax(500000, 0, true).taxCents).toBe(0);
  });

  it('redondeo por línea vs por total', () => {
    const lines = [105, 105, 105].map((a) => ({ amountCents: a, taxRateBp: 1900, taxIncluded: true }));
    expect(computeTaxes(lines, { rounding: 'line' }).taxCents).toBe(51);
    const total = computeTaxes(lines, { rounding: 'total' });
    expect(total.taxCents).toBe(50);
    expect(total.lines.reduce((s, l) => s + l.taxCents, 0)).toBe(50);
    expect(total.totalCents).toBe(315);
  });

  it('agrupa por tarifa (IVA, INC, exento)', () => {
    const r = computeTaxes([
      { amountCents: 119000, taxRateBp: 1900, taxIncluded: true },
      { amountCents: 108000, taxRateBp: 800, taxIncluded: true },
      { amountCents: 50000, taxRateBp: 0, taxIncluded: true },
    ]);
    expect(r.byRate).toEqual([
      { taxRateBp: 0, baseCents: 50000, taxCents: 0 },
      { taxRateBp: 800, baseCents: 100000, taxCents: 8000 },
      { taxRateBp: 1900, baseCents: 100000, taxCents: 19000 },
    ]);
    expect(r.totalCents).toBe(277000);
  });
});

describe('allocateLots (FEFO)', () => {
  const lots = [
    { id: 'a', qty: 3, expiresOn: '2026-12-01' },
    { id: 'b', qty: 10, expiresOn: '2026-11-15' },
    { id: 'c', qty: 4, expiresOn: '2026-10-01' },
    { id: 'd', qty: 2, expiresOn: null },
  ];
  it('consume primero lo que vence primero y bloquea vencidos', () => {
    expect(allocateLots(5, lots, '2026-10-29').allocations).toEqual([{ lotId: 'b', qty: 5 }]);
    expect(allocateLots(12, lots, '2026-10-29').allocations).toEqual([
      { lotId: 'b', qty: 10 },
      { lotId: 'a', qty: 2 },
    ]);
    const r = allocateLots(20, lots, '2026-10-29');
    expect(r.allocations.map((a) => a.lotId)).toEqual(['b', 'a', 'd']);
    expect(r.shortfall).toBe(5);
    expect(r.blockedLotIds).toEqual(['c']);
  });
});

describe('averageCost', () => {
  it('promedio ponderado', () => {
    expect(averageCost(10, 1000, 10, 2000)).toBe(1500);
    expect(averageCost(3, 1000, 1, 2000)).toBe(1250);
    expect(averageCost(3, 100, 7, 101)).toBe(101);
    expect(averageCost(0, 1000, 5, 1500)).toBe(1500);
    expect(averageCost(-2, 1000, 5, 1500)).toBe(1500);
    expect(averageCost(5, 1000, 0, 9999)).toBe(1000);
  });

  it('inventario como suma de movimientos', () => {
    expect(
      stockLevels([
        { productId: 'x', qty: 10 },
        { productId: 'x', qty: -0.1 },
        { productId: 'x', qty: -0.2 },
        { productId: 'y', qty: -1 },
      ]),
    ).toEqual({ x: 9.7, y: -1 });
  });
});

describe('splitPayments', () => {
  it('efectivo con cambio', () => {
    const r = splitPayments(1250000, [{ method: 'cash', amountCents: 2000000 }]);
    expect(r.ok).toBe(true);
    expect(r.changeCents).toBe(750000);
    expect(r.applied).toEqual([{ method: 'cash', amountCents: 1250000 }]);
  });

  it('pago mixto', () => {
    const r = splitPayments(1000000, [
      { method: 'card', amountCents: 400000 },
      { method: 'cash', amountCents: 1000000 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.changeCents).toBe(400000);
    expect(r.applied).toEqual([
      { method: 'card', amountCents: 400000 },
      { method: 'cash', amountCents: 600000 },
    ]);
  });

  it('pagos incompletos o tarjeta mayor al total', () => {
    expect(splitPayments(1000000, [{ method: 'cash', amountCents: 500000 }]).remainingCents).toBe(500000);
    const r = splitPayments(1000000, [{ method: 'card', amountCents: 1200000 }]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/superan/);
  });

  it('billetes rápidos', () => {
    expect(quickCashOptions(1250000)).toEqual([1250000, 1400000, 1500000, 2000000, 5000000, 10000000]);
  });
});

describe('cashExpected', () => {
  it('base + efectivo + ingresos − retiros', () => {
    const r = cashExpected({
      openingCents: 10000000,
      salePayments: [
        { method: 'cash', amountCents: 1250000 },
        { method: 'card', amountCents: 500000 },
      ],
      movements: [
        { kind: 'in', amountCents: 200000 },
        { kind: 'out', amountCents: 1000000 },
      ],
    });
    expect(r.expectedCents).toBe(10450000);
    expect(r.byMethod.card).toBe(500000);
    expect(countDenominations({ '5000000': 2, '1000000': 3, '50000': 4 })).toBe(13200000);
  });
});

const gaseosa: CartProduct = {
  id: 'p-gaseosa',
  name: 'Gaseosa 1.5 L',
  priceCents: 350000,
  costAvgCents: 200000,
  taxRateBp: 1900,
  taxIncluded: true,
};
const huevos: CartProduct = {
  id: 'p-huevos',
  name: 'Huevos x30',
  priceCents: 500000,
  costAvgCents: 300000,
  taxRateBp: 0,
  taxIncluded: true,
};

describe('carrito, descuentos y venta', () => {
  it('agrega, fusiona líneas, cambia cantidad y elimina', () => {
    let cart = addToCart(emptyCart(), gaseosa);
    cart = addToCart(cart, gaseosa);
    cart = addToCart(cart, huevos);
    expect(cart.lines).toHaveLength(2);
    expect(cart.lines[0].qty).toBe(2);
    cart = setLineQty(cart, cart.lines[1].lineId, 0);
    expect(cart.lines).toHaveLength(1);
    cart = removeLine(cart, cart.lines[0].lineId);
    expect(cart.lines).toHaveLength(0);
  });

  it('precio por volumen se recalcula al cambiar cantidad y por cliente', () => {
    let cart = addToCart(emptyCart(), arroz, 11);
    expect(cart.lines[0].unitPriceCents).toBe(250000);
    cart = addToCart(cart, arroz, 1);
    expect(cart.lines[0].unitPriceCents).toBe(220000);
    cart = setCustomer(cart, { id: 'c1', priceListId: 'mayorista' });
    expect(cart.lines[0].unitPriceCents).toBe(210000);
  });

  it('valida límites de descuento por rol', () => {
    const cart = addToCart(addToCart(emptyCart(), gaseosa, 2), huevos);
    expect(applyDiscount(cart, { type: 'percent', bp: 500, scope: 'cart' }, 'cashier').ok).toBe(true);
    const denied = applyDiscount(cart, { type: 'percent', bp: 2000, scope: 'cart' }, 'cashier');
    expect(denied).toMatchObject({ ok: false, reason: 'exceeds_role_limit', requiredRole: 'supervisor' });
    expect(applyDiscount(cart, { type: 'percent', bp: 2000, scope: 'cart' }, 'supervisor').ok).toBe(true);
    expect(applyDiscount(cart, { type: 'percent', bp: 5000, scope: 'cart' }, 'owner').ok).toBe(true);
    const line = applyDiscount(cart, { type: 'amount', cents: 50000, scope: 'line', lineId: cart.lines[1].lineId }, 'cashier');
    expect(line.ok).toBe(true);
    expect(applyDiscount(cart, { type: 'amount', cents: 99999999, scope: 'cart' }, 'owner')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('totales con descuento prorrateado e impuestos', () => {
    let cart = addToCart(addToCart(emptyCart(), gaseosa, 2), huevos);
    const d = applyDiscount(cart, { type: 'amount', cents: 120000, scope: 'cart' }, 'cashier');
    if (!d.ok) throw new Error('descuento rechazado');
    cart = d.cart;
    const t = computeCartTotals(cart);
    expect(t.grossCents).toBe(1200000);
    expect(t.discountCents).toBe(120000);
    expect(t.lines.map((l) => l.netCents)).toEqual([630000, 450000]);
    expect(t.taxCents).toBe(100588);
    expect(t.totalCents).toBe(1080000);
    expect(t.itemCount).toBe(3);
  });

  it('finaliza venta y calcula utilidad con costos congelados', () => {
    let cart = addToCart(addToCart(emptyCart(), gaseosa, 2), huevos);
    const d = applyDiscount(cart, { type: 'amount', cents: 120000, scope: 'cart' }, 'cashier');
    if (!d.ok) throw new Error();
    cart = d.cart;
    const r = finalizeSale(cart, [{ method: 'cash', amountCents: 2000000 }]);
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.sale.totalCents).toBe(1080000);
    expect(r.sale.changeCents).toBe(920000);
    expect(r.sale.payments).toEqual([{ method: 'cash', amountCents: 1080000, reference: null }]);
    const p = profitOfSale(r.sale);
    expect(p.revenueCents).toBe(979412);
    expect(p.costCents).toBe(700000);
    expect(p.profitCents).toBe(279412);
    expect(p.marginBp).toBe(2853);
  });

  it('rechaza venta vacía, pago insuficiente y crédito sin cliente', () => {
    expect(finalizeSale(emptyCart(), []).ok).toBe(false);
    const cart = addToCart(emptyCart(), gaseosa);
    expect(finalizeSale(cart, [{ method: 'cash', amountCents: 100 }]).ok).toBe(false);
    const credit = finalizeSale(cart, [{ method: 'credit', amountCents: 350000 }]);
    expect(credit).toMatchObject({ ok: false });
    expect(finalizeSale(setCustomer(cart, { id: 'c1' }), [{ method: 'credit', amountCents: 350000 }]).ok).toBe(true);
  });
});
