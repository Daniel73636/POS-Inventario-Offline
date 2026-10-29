import type { Customer, PosEvent, Product, SaleItem, SnapshotResponse } from '@pos/contracts';
import { addQty, averageCost, type Cents, type PaymentMethod } from '@pos/domain-pos';

export interface ProductState extends Product {
  updatedHlc: string;
}

export interface SaleRecord {
  id: string;
  deviceId: string;
  localNumber: number;
  cashSessionId: string;
  userId: string;
  customerId: string | null;
  status: 'completed' | 'voided';
  subtotalCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  changeCents: Cents;
  items: SaleItem[];
  payments: Array<{ method: PaymentMethod; amountCents: Cents; reference?: string | null }>;
  occurredAt: string;
  hlc: string;
}

export interface CashSessionRecord {
  id: string;
  deviceId: string;
  userId: string;
  openingCents: Cents;
  openedAt: string;
  closedAt: string | null;
  countedCents: Cents | null;
  expectedCents: Cents | null;
  differenceCents: Cents | null;
  movements: Array<{ id: string; kind: 'in' | 'out'; amountCents: Cents; reason: string; at: string }>;
}

export interface StockAlert {
  productId: string;
  qty: number;
  eventId: string;
  at: string;
}

/** Estado derivado de eventos. Se puede reconstruir desde cero en cualquier momento. */
export interface PosState {
  products: Record<string, ProductState>;
  barcodeIndex: Record<string, { productId: string; packId: string | null }>;
  customers: Record<string, Customer & { updatedHlc: string }>;
  stock: Record<string, number>;
  sales: Record<string, SaleRecord>;
  cashSessions: Record<string, CashSessionRecord>;
  alerts: StockAlert[];
  /** Último seq aplicado por dispositivo: hace idempotente la aplicación. */
  applied: Record<string, number>;
}

export function emptyState(): PosState {
  return { products: {}, barcodeIndex: {}, customers: {}, stock: {}, sales: {}, cashSessions: {}, alerts: [], applied: {} };
}

const SNAPSHOT_HLC = '000000000000000:00000:snapshot';

/** Estado inicial a partir del snapshot del servidor. */
export function stateFromSnapshot(snapshot: Pick<SnapshotResponse, 'products' | 'customers' | 'stock'>): PosState {
  const state = emptyState();
  for (const p of snapshot.products) upsertProduct(state, p, (p as Partial<ProductState>).updatedHlc ?? SNAPSHOT_HLC);
  for (const c of snapshot.customers) state.customers[c.id] = { ...c, updatedHlc: SNAPSHOT_HLC };
  for (const s of snapshot.stock) state.stock[s.productId] = s.qty;
  return state;
}

function upsertProduct(state: PosState, product: Product, hlc: string): void {
  const prev = state.products[product.id];
  if (prev) {
    for (const code of prev.barcodes) delete state.barcodeIndex[code];
    for (const pack of prev.packs) if (pack.barcode) delete state.barcodeIndex[pack.barcode];
  }
  state.products[product.id] = { ...product, updatedHlc: hlc };
  for (const code of product.barcodes) state.barcodeIndex[code] = { productId: product.id, packId: null };
  for (const pack of product.packs) if (pack.barcode) state.barcodeIndex[pack.barcode] = { productId: product.id, packId: pack.id };
  if (state.stock[product.id] === undefined) state.stock[product.id] = 0;
}

function moveStock(state: PosState, productId: string, delta: number, event: PosEvent): void {
  const next = addQty(state.stock[productId] ?? 0, delta);
  state.stock[productId] = next;
  if (delta < 0 && next < 0) {
    state.alerts.push({ productId, qty: next, eventId: event.id, at: event.occurredAt });
  }
}

/**
 * Aplica un evento al estado (mutando). Devuelve false si ya estaba aplicado.
 * Reglas de convergencia:
 *  - Catálogo/clientes: última escritura gana por HLC.
 *  - Inventario: suma de movimientos (conmutativa) → stock negativo válido + alerta.
 *  - Ventas, caja: sólo añadir.
 */
export function applyEvent(state: PosState, event: PosEvent): boolean {
  const last = state.applied[event.deviceId] ?? 0;
  if (event.seq <= last) return false;
  state.applied[event.deviceId] = event.seq;

  switch (event.type) {
    case 'ProductUpserted': {
      const current = state.products[event.payload.product.id];
      if (!current || event.hlc > current.updatedHlc) upsertProduct(state, event.payload.product, event.hlc);
      break;
    }
    case 'CustomerUpserted': {
      const current = state.customers[event.payload.customer.id];
      if (!current || event.hlc > current.updatedHlc) {
        state.customers[event.payload.customer.id] = { ...event.payload.customer, updatedHlc: event.hlc };
      }
      break;
    }
    case 'StockReceived': {
      const { productId, qty, unitCostCents } = event.payload;
      const product = state.products[productId];
      if (product) {
        product.costAvgCents = averageCost(state.stock[productId] ?? 0, product.costAvgCents, qty, unitCostCents);
      }
      moveStock(state, productId, qty, event);
      break;
    }
    case 'StockAdjusted':
      moveStock(state, event.payload.productId, event.payload.qty, event);
      break;
    case 'SaleCompleted': {
      const p = event.payload;
      if (state.sales[p.saleId]) break;
      state.sales[p.saleId] = {
        id: p.saleId,
        deviceId: event.deviceId,
        localNumber: p.localNumber,
        cashSessionId: p.cashSessionId,
        userId: p.userId,
        customerId: p.customerId,
        status: 'completed',
        subtotalCents: p.subtotalCents,
        discountCents: p.discountCents,
        taxCents: p.taxCents,
        totalCents: p.totalCents,
        changeCents: p.changeCents,
        items: p.items,
        payments: p.payments,
        occurredAt: event.occurredAt,
        hlc: event.hlc,
      };
      for (const item of p.items) moveStock(state, item.productId, -item.baseQty, event);
      break;
    }
    case 'SaleVoided': {
      const sale = state.sales[event.payload.saleId];
      if (!sale || sale.status === 'voided') break;
      sale.status = 'voided';
      for (const item of sale.items) moveStock(state, item.productId, item.baseQty, event);
      break;
    }
    case 'CashSessionOpened':
      state.cashSessions[event.payload.sessionId] ??= {
        id: event.payload.sessionId,
        deviceId: event.deviceId,
        userId: event.payload.userId,
        openingCents: event.payload.openingCents,
        openedAt: event.occurredAt,
        closedAt: null,
        countedCents: null,
        expectedCents: null,
        differenceCents: null,
        movements: [],
      };
      break;
    case 'CashMovement': {
      const s = state.cashSessions[event.payload.sessionId];
      if (s && !s.movements.some((m) => m.id === event.payload.movementId)) {
        s.movements.push({
          id: event.payload.movementId,
          kind: event.payload.kind,
          amountCents: event.payload.amountCents,
          reason: event.payload.reason,
          at: event.occurredAt,
        });
      }
      break;
    }
    case 'CashSessionClosed': {
      const s = state.cashSessions[event.payload.sessionId];
      if (s) {
        s.closedAt = event.occurredAt;
        s.countedCents = event.payload.countedCents;
        s.expectedCents = event.payload.expectedCents;
        s.differenceCents = event.payload.differenceCents;
      }
      break;
    }
  }
  return true;
}

export function applyEvents(state: PosState, events: PosEvent[]): number {
  let n = 0;
  for (const e of events) if (applyEvent(state, e)) n++;
  return n;
}

export function findByBarcode(state: PosState, code: string): { product: ProductState; packId: string | null } | null {
  const hit = state.barcodeIndex[code.trim()];
  if (!hit) return null;
  const product = state.products[hit.productId];
  return product ? { product, packId: hit.packId } : null;
}

/** Búsqueda por nombre/SKU sin tildes. */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function searchProducts(state: PosState, query: string, limit = 20): ProductState[] {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return Object.values(state.products)
    .filter((p) => p.active)
    .filter((p) => {
      const hay = normalizeText(`${p.name} ${p.sku ?? ''} ${p.brand ?? ''} ${p.category} ${p.barcodes.join(' ')}`);
      return terms.every((t) => hay.includes(t));
    })
    .slice(0, limit);
}
