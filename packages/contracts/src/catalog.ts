import { z } from 'zod';

export const cents = z.number().int().safe();
export const positiveQty = z.number().finite().positive();

export const UnitSchema = z.enum(['unit', 'kg', 'l', 'm', 'box']);
export type Unit = z.infer<typeof UnitSchema>;

export const UNIT_LABELS: Record<Unit, string> = { unit: 'und', kg: 'kg', l: 'l', m: 'm', box: 'caja' };

export const TaxCodeSchema = z.enum(['IVA19', 'IVA5', 'INC8', 'EXENTO', 'EXCLUIDO']);
export type TaxCode = z.infer<typeof TaxCodeSchema>;

export const TAX_RATES_BP: Record<TaxCode, number> = {
  IVA19: 1900,
  IVA5: 500,
  INC8: 800,
  EXENTO: 0,
  EXCLUIDO: 0,
};

export const PriceEntrySchema = z.object({
  priceListId: z.string().min(1),
  priceCents: cents.nonnegative(),
  minQty: z.number().positive().default(1),
  packId: z.string().nullable().optional(),
  validFrom: z.string().nullable().optional(),
  validTo: z.string().nullable().optional(),
});

export const PackSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  unitsPerPack: z.number().positive(),
  barcode: z.string().nullable().optional(),
});

export const ProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  sku: z.string().nullable().default(null),
  category: z.string().default('General'),
  brand: z.string().nullable().default(null),
  unit: UnitSchema.default('unit'),
  taxCode: TaxCodeSchema.default('IVA19'),
  taxRateBp: z.number().int().min(0).max(10000),
  taxIncluded: z.boolean().default(true),
  priceCents: cents.nonnegative(),
  costAvgCents: cents.nonnegative().default(0),
  minStock: z.number().nullable().default(null),
  active: z.boolean().default(true),
  tracksLots: z.boolean().default(false),
  barcodes: z.array(z.string().min(1)).default([]),
  prices: z.array(PriceEntrySchema).default([]),
  packs: z.array(PackSchema).default([]),
  color: z.string().nullable().default(null),
  quick: z.boolean().default(false),
});
export type Product = z.infer<typeof ProductSchema>;
export type ProductInput = z.input<typeof ProductSchema>;

export const CustomerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  docId: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  priceListId: z.string().nullable().default(null),
  creditLimitCents: cents.nonnegative().nullable().default(null),
  active: z.boolean().default(true),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const PriceListSchema = z.object({ id: z.string(), name: z.string() });
export type PriceList = z.infer<typeof PriceListSchema>;

export const RoleSchema = z.enum(['cashier', 'supervisor', 'owner']);
export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: RoleSchema,
  /** sha256(hex) de `${tenantId}:${pin}` para validar PIN sin conexión. */
  pinHash: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export function pinHashInput(tenantId: string, pin: string): string {
  return `${tenantId}:${pin}`;
}
