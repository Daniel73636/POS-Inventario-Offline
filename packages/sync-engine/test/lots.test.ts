import { describe, expect, it } from 'vitest';
import type { Product } from '@pos/contracts';
import { EventFactory, HybridLogicalClock, applyEvent, emptyState, listNearExpiry, productLots } from '../src';

function product(tracksLots: boolean): Product {
  return {
    id: 'p1',
    name: 'Leche',
    sku: 'MM-0001',
    category: 'Lácteos',
    brand: null,
    unit: 'unit',
    taxCode: 'EXENTO',
    taxRateBp: 0,
    taxIncluded: true,
    priceCents: 420000,
    costAvgCents: 330000,
    minStock: null,
    active: true,
    tracksLots,
    barcodes: ['770'],
    prices: [],
    packs: [],
    color: null,
    quick: false,
  };
}

function sale(f: EventFactory, qty: number, lots?: Array<{ lotId: string; qty: number; expiresOn: string | null }>) {
  return f.create('SaleCompleted', {
    saleId: `sale-${qty}-${lots?.map((l) => l.lotId).join('.') ?? 'fefo'}`,
    localNumber: 1,
    cashSessionId: 'cs',
    userId: 'u',
    customerId: null,
    subtotalCents: 100,
    discountCents: 0,
    taxCents: 0,
    totalCents: 100,
    changeCents: 0,
    items: [
      {
        productId: 'p1',
        name: 'Leche',
        packId: null,
        qty,
        baseQty: qty,
        unitPriceCents: 100,
        unitCostCents: 50,
        discountCents: 0,
        taxRateBp: 0,
        taxCents: 0,
        lineTotalCents: 100,
        ...(lots ? { lots } : {}),
      },
    ],
    payments: [{ method: 'cash', amountCents: 100 }],
  }, new Date('2026-11-01T15:00:00Z'));
}

describe('FEFO en la proyección de ventas', () => {
  const now = new Date('2026-11-01T15:00:00Z').getTime();

  function base() {
    const state = emptyState();
    const f = new EventFactory({ tenantId: 't', storeId: 's', deviceId: 'd' }, new HybridLogicalClock('d', () => now));
    applyEvent(state, f.create('ProductUpserted', { product: product(true) }, new Date(now)));
    applyEvent(state, f.create('StockReceived', { productId: 'p1', qty: 4, unitCostCents: 100, lotCode: 'tarde', expiresOn: '2026-12-01', userId: 'u' }, new Date(now)));
    applyEvent(state, f.create('StockReceived', { productId: 'p1', qty: 3, unitCostCents: 100, lotCode: 'pronto', expiresOn: '2026-11-05', userId: 'u' }, new Date(now)));
    applyEvent(state, f.create('StockReceived', { productId: 'p1', qty: 2, unitCostCents: 100, lotCode: 'viejo', expiresOn: '2026-10-01', userId: 'u' }, new Date(now)));
    return { state, f };
  }

  it('sin lotes en el evento consume primero lo que vence y no toca el vencido', () => {
    const { state, f } = base();
    const before = listNearExpiry(state, '2026-11-01');
    expect(before.map((a) => a.lotId)).toEqual(['viejo', 'pronto']);
    expect(before[0].daysLeft).toBeLessThan(0);
    const event = sale(f, 5);
    applyEvent(state, event);
    const saved = state.sales[event.payload.saleId].items[0].lots;
    expect(saved).toEqual([
      { lotId: 'pronto', qty: 3, expiresOn: '2026-11-05' },
      { lotId: 'tarde', qty: 2, expiresOn: '2026-12-01' },
    ]);
    expect(productLots(state, 'p1').find((l) => l.id === 'pronto')?.qty).toBe(0);
    expect(productLots(state, 'p1').find((l) => l.id === 'tarde')?.qty).toBe(2);
    expect(productLots(state, 'p1').find((l) => l.id === 'viejo')?.qty).toBe(2);
    expect(state.stock.p1).toBe(4);
    expect(listNearExpiry(state, '2026-11-01').map((a) => a.lotId)).toEqual(['viejo']);
  });

  it('respeta los lotes del evento y la anulación los devuelve', () => {
    const { state, f } = base();
    const event = sale(f, 1, [{ lotId: 'tarde', qty: 1, expiresOn: '2026-12-01' }]);
    applyEvent(state, event);
    expect(productLots(state, 'p1').find((l) => l.id === 'tarde')?.qty).toBe(3);
    expect(productLots(state, 'p1').find((l) => l.id === 'pronto')?.qty).toBe(3);
    applyEvent(state, f.create('SaleVoided', { saleId: event.payload.saleId, reason: 'Error', userId: 'u', authorizedBy: 'sup' }, new Date(now)));
    expect(productLots(state, 'p1').find((l) => l.id === 'tarde')?.qty).toBe(4);
    expect(state.stock.p1).toBe(9);
  });
});
