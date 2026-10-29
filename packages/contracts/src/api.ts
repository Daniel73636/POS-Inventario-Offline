import { z } from 'zod';
import { CustomerSchema, PriceListSchema, ProductSchema, UserSchema } from './catalog';

export const MAX_PUSH_BATCH = 200;
export const MAX_PULL_BATCH = 500;
/** Desfase máximo de reloj tolerado antes de advertir (5 min). */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const PlatformSchema = z.enum(['web', 'android', 'desktop']);

export const RegisterDeviceRequestSchema = z.object({
  pairingCode: z.string().min(4).max(32),
  name: z.string().min(1).max(60),
  platform: PlatformSchema,
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

export interface RegisterDeviceResponse {
  deviceId: string;
  deviceToken: string;
  tenantId: string;
  tenantName: string;
  storeId: string;
  storeName: string;
  serverTime: string;
}

export const PushRequestSchema = z.object({
  /** Se valida cada evento individualmente para rechazar sólo los inválidos. */
  events: z.array(z.unknown()).max(MAX_PUSH_BATCH),
});
export type PushRequest = { events: unknown[] };

export interface PushResponse {
  accepted: string[];
  duplicates: string[];
  rejected: Array<{ id: string | null; reason: string }>;
  serverTime: string;
  cursor: number;
}

export interface PullResponse<E = unknown> {
  events: E[];
  cursor: number;
  hasMore: boolean;
  serverTime: string;
}

export interface SnapshotResponse {
  tenant: { id: string; name: string };
  store: { id: string; name: string };
  priceLists: z.infer<typeof PriceListSchema>[];
  products: z.infer<typeof ProductSchema>[];
  customers: z.infer<typeof CustomerSchema>[];
  users: z.infer<typeof UserSchema>[];
  stock: Array<{ productId: string; qty: number }>;
  cursor: number;
  serverTime: string;
}

export const FiscalRangeRequestSchema = z.object({
  size: z.number().int().min(10).max(5000).default(200),
});

export interface FiscalRange {
  id: string;
  prefix: string;
  from: number;
  to: number;
  resolution: string;
  validUntil: string;
}

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(4),
});

export const CreatePairingCodeSchema = z.object({
  uses: z.number().int().min(1).max(100).default(1),
});

export const StockAdjustRequestSchema = z.object({
  productId: z.string(),
  qty: z.number().finite(),
  reason: z.enum(['count', 'damage', 'adjust', 'initial', 'return']),
  note: z.string().nullable().optional(),
});

export const StockReceiveRequestSchema = z.object({
  productId: z.string(),
  qty: z.number().positive(),
  unitCostCents: z.number().int().nonnegative(),
  supplier: z.string().nullable().optional(),
  lotCode: z.string().nullable().optional(),
  expiresOn: z.string().nullable().optional(),
});
