import { z } from 'zod';
import { cents, CustomerSchema, positiveQty, ProductSchema } from './catalog';

export const PaymentMethodSchema = z.enum(['cash', 'card', 'transfer', 'credit']);

export const SaleItemSchema = z.object({
  productId: z.string(),
  name: z.string(),
  packId: z.string().nullable(),
  qty: positiveQty,
  /** Unidades base descontadas del inventario (qty × unidades por presentación). */
  baseQty: positiveQty,
  unitPriceCents: cents,
  unitCostCents: cents,
  discountCents: cents,
  taxRateBp: z.number().int(),
  taxCents: cents,
  lineTotalCents: cents,
});
export type SaleItem = z.infer<typeof SaleItemSchema>;

export const SalePaymentSchema = z.object({
  method: PaymentMethodSchema,
  amountCents: cents.positive(),
  reference: z.string().nullable().optional(),
});

export const payloads = {
  ProductUpserted: z.object({ product: ProductSchema }),
  CustomerUpserted: z.object({ customer: CustomerSchema }),
  StockReceived: z.object({
    productId: z.string(),
    qty: positiveQty,
    unitCostCents: cents.nonnegative(),
    lotCode: z.string().nullable().optional(),
    expiresOn: z.string().nullable().optional(),
    supplier: z.string().nullable().optional(),
    userId: z.string(),
  }),
  StockAdjusted: z.object({
    productId: z.string(),
    /** Delta con signo. */
    qty: z.number().finite(),
    reason: z.enum(['count', 'damage', 'adjust', 'initial', 'return']),
    countedQty: z.number().nullable().optional(),
    note: z.string().nullable().optional(),
    userId: z.string(),
  }),
  SaleCompleted: z.object({
    saleId: z.string(),
    localNumber: z.number().int().positive(),
    cashSessionId: z.string(),
    userId: z.string(),
    customerId: z.string().nullable(),
    subtotalCents: cents,
    discountCents: cents,
    taxCents: cents,
    totalCents: cents,
    changeCents: cents,
    fiscalNumber: z.string().nullable().optional(),
    /** Usuario que autorizó con su PIN un descuento por encima del límite del cajero. */
    discountAuthorizedBy: z.string().nullable().optional(),
    items: z.array(SaleItemSchema).min(1),
    payments: z.array(SalePaymentSchema),
  }),
  SaleVoided: z.object({
    saleId: z.string(),
    reason: z.string().min(1),
    userId: z.string(),
    authorizedBy: z.string(),
  }),
  CashSessionOpened: z.object({
    sessionId: z.string(),
    userId: z.string(),
    openingCents: cents.nonnegative(),
  }),
  CashMovement: z.object({
    sessionId: z.string(),
    movementId: z.string(),
    kind: z.enum(['in', 'out']),
    amountCents: cents.positive(),
    reason: z.string().min(1),
    userId: z.string(),
  }),
  CashSessionClosed: z.object({
    sessionId: z.string(),
    userId: z.string(),
    countedCents: cents,
    expectedCents: cents,
    differenceCents: cents,
  }),
} as const;

export type EventType = keyof typeof payloads;
export const EVENT_TYPES = Object.keys(payloads) as EventType[];
export type EventPayload<T extends EventType> = z.infer<(typeof payloads)[T]>;

export const EnvelopeBaseSchema = z.object({
  id: z.string().min(10).max(64),
  tenantId: z.string(),
  storeId: z.string(),
  deviceId: z.string(),
  seq: z.number().int().positive(),
  hlc: z.string().regex(/^\d{15}:\d{5}:.+$/),
  occurredAt: z.string(),
});

const variants = EVENT_TYPES.map((type) =>
  EnvelopeBaseSchema.extend({ type: z.literal(type), payload: payloads[type] }),
);

export const PosEventSchema = z.discriminatedUnion(
  'type',
  variants as unknown as [
    (typeof variants)[number],
    (typeof variants)[number],
    ...(typeof variants)[number][],
  ],
);

type Envelope = z.infer<typeof EnvelopeBaseSchema>;
export type PosEvent = {
  [K in EventType]: Envelope & { type: K; payload: EventPayload<K> };
}[EventType];
export type PosEventOf<K extends EventType> = Extract<PosEvent, { type: K }>;

/** Evento tal como lo distribuye el servidor (con cursor global). */
export type ServerEvent = PosEvent & { serverSeq: number };

export function parseEvent(input: unknown): { ok: true; event: PosEvent } | { ok: false; error: string } {
  const r = PosEventSchema.safeParse(input);
  if (r.success) return { ok: true, event: r.data as PosEvent };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

export const EVENT_LABELS: Record<EventType, string> = {
  ProductUpserted: 'Producto actualizado',
  CustomerUpserted: 'Cliente actualizado',
  StockReceived: 'Entrada de mercancía',
  StockAdjusted: 'Ajuste de inventario',
  SaleCompleted: 'Venta',
  SaleVoided: 'Venta anulada',
  CashSessionOpened: 'Apertura de caja',
  CashMovement: 'Movimiento de caja',
  CashSessionClosed: 'Cierre de caja',
};
