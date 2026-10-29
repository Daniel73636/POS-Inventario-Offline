import { TAX_RATES_BP, type Customer, type PriceList, type Product, type TaxCode, type Unit } from './catalog';

/** IDs deterministas: el servidor y el modo demo offline comparten el mismo catálogo. */
export const DEMO_TENANT = { id: 'tnt_minimarket_demo', name: 'MiniMarket Demo' } as const;
export const DEMO_STORE = { id: 'str_principal', name: 'Sede Principal' } as const;
export const DEMO_PAIRING_CODE = 'DEMO-2026';
export const DEMO_OWNER = { email: 'dueno@minimarket.demo', password: 'demo1234', name: 'Dueña Demo' } as const;

export const DEMO_USERS = [
  { id: 'usr_owner', name: 'Dueña Demo', role: 'owner' as const, pin: '0000' },
  { id: 'usr_ana', name: 'Ana (cajera)', role: 'cashier' as const, pin: '1234' },
  { id: 'usr_luis', name: 'Luis (supervisor)', role: 'supervisor' as const, pin: '9999' },
];

export const DEMO_PRICE_LISTS: PriceList[] = [
  { id: 'general', name: 'General' },
  { id: 'mayorista', name: 'Mayorista' },
];

/** Dígito de control EAN-13 para los 12 primeros dígitos. */
export function ean13(base12: string): string {
  if (!/^\d{12}$/.test(base12)) throw new Error('EAN-13 requiere 12 dígitos base');
  const sum = base12
    .split('')
    .reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return base12 + ((10 - (sum % 10)) % 10);
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13(code.slice(0, 12)) === code;
}

interface Row {
  name: string;
  category: string;
  brand: string | null;
  unit: Unit;
  tax: TaxCode;
  price: number; // pesos
  cost: number; // pesos
  stock: number;
  minStock: number;
  quick?: boolean;
  color?: string;
  wholesale?: number; // pesos, lista mayorista
  tier?: { minQty: number; price: number };
  pack?: { id: string; name: string; units: number; price: number };
  expiresInDays?: number;
}

const ROWS: Row[] = [
  { name: 'Gaseosa Cola 1.5 L', category: 'Bebidas', brand: 'Postobón', unit: 'unit', tax: 'IVA19', price: 4500, cost: 3100, stock: 48, minStock: 12, quick: true, color: '#dc2626', wholesale: 4100, pack: { id: 'six', name: 'Six pack', units: 6, price: 25000 } },
  { name: 'Agua sin gas 600 ml', category: 'Bebidas', brand: 'Cristal', unit: 'unit', tax: 'IVA19', price: 2000, cost: 1100, stock: 60, minStock: 24, quick: true, color: '#0ea5e9' },
  { name: 'Jugo de naranja 1 L', category: 'Bebidas', brand: 'Hit', unit: 'unit', tax: 'IVA19', price: 5200, cost: 3600, stock: 20, minStock: 6 },
  { name: 'Cerveza lata 330 ml', category: 'Bebidas', brand: 'Águila', unit: 'unit', tax: 'IVA19', price: 3800, cost: 2600, stock: 72, minStock: 24, quick: true, color: '#f59e0b', tier: { minQty: 12, price: 3500 } },
  { name: 'Café molido 250 g', category: 'Despensa', brand: 'Sello Rojo', unit: 'unit', tax: 'IVA5', price: 9800, cost: 7200, stock: 18, minStock: 6 },
  { name: 'Arroz blanco 500 g', category: 'Despensa', brand: 'Diana', unit: 'unit', tax: 'EXENTO', price: 2900, cost: 2050, stock: 80, minStock: 20, quick: true, color: '#a3a3a3', wholesale: 2600, tier: { minQty: 12, price: 2700 } },
  { name: 'Fríjol rojo 500 g', category: 'Despensa', brand: 'La Muñeca', unit: 'unit', tax: 'EXENTO', price: 6500, cost: 4800, stock: 25, minStock: 8 },
  { name: 'Lenteja 500 g', category: 'Despensa', brand: 'La Muñeca', unit: 'unit', tax: 'EXENTO', price: 3900, cost: 2700, stock: 30, minStock: 8 },
  { name: 'Azúcar 1 kg', category: 'Despensa', brand: 'Manuelita', unit: 'unit', tax: 'IVA5', price: 4800, cost: 3700, stock: 40, minStock: 10, wholesale: 4400 },
  { name: 'Sal refinada 500 g', category: 'Despensa', brand: 'Refisal', unit: 'unit', tax: 'EXCLUIDO', price: 1500, cost: 900, stock: 35, minStock: 10 },
  { name: 'Aceite vegetal 1 L', category: 'Despensa', brand: 'Premier', unit: 'unit', tax: 'IVA5', price: 11900, cost: 9300, stock: 22, minStock: 6, wholesale: 11000 },
  { name: 'Leche entera 1 L', category: 'Lácteos', brand: 'Alpina', unit: 'unit', tax: 'EXENTO', price: 4200, cost: 3300, stock: 36, minStock: 12, quick: true, color: '#e5e7eb', expiresInDays: 10 },
  { name: 'Huevos AA x30', category: 'Lácteos', brand: 'Kikes', unit: 'unit', tax: 'EXENTO', price: 18500, cost: 14500, stock: 12, minStock: 4, quick: true, color: '#fbbf24' },
  { name: 'Queso campesino 500 g', category: 'Lácteos', brand: 'Colanta', unit: 'unit', tax: 'EXENTO', price: 12000, cost: 9000, stock: 10, minStock: 4, expiresInDays: 15 },
  { name: 'Yogurt fresa 1 L', category: 'Lácteos', brand: 'Alpina', unit: 'unit', tax: 'IVA19', price: 7900, cost: 5600, stock: 14, minStock: 4, expiresInDays: 20 },
  { name: 'Pan tajado 600 g', category: 'Panadería', brand: 'Bimbo', unit: 'unit', tax: 'IVA5', price: 8500, cost: 6200, stock: 15, minStock: 5, quick: true, color: '#d97706', expiresInDays: 7 },
  { name: 'Arepas de maíz x5', category: 'Panadería', brand: 'Doña Paisa', unit: 'unit', tax: 'EXENTO', price: 4000, cost: 2600, stock: 20, minStock: 6, expiresInDays: 8 },
  { name: 'Jabón de baño 3 und', category: 'Aseo', brand: 'Protex', unit: 'unit', tax: 'IVA19', price: 9900, cost: 7100, stock: 16, minStock: 5 },
  { name: 'Detergente polvo 1 kg', category: 'Aseo', brand: 'Fab', unit: 'unit', tax: 'IVA19', price: 12500, cost: 9400, stock: 14, minStock: 5 },
  { name: 'Papel higiénico x4', category: 'Aseo', brand: 'Familia', unit: 'unit', tax: 'IVA19', price: 7900, cost: 5800, stock: 30, minStock: 10, quick: true, color: '#60a5fa' },
  { name: 'Crema dental 100 ml', category: 'Aseo', brand: 'Colgate', unit: 'unit', tax: 'IVA19', price: 6300, cost: 4400, stock: 18, minStock: 6 },
  { name: 'Shampoo 400 ml', category: 'Aseo', brand: 'Sedal', unit: 'unit', tax: 'IVA19', price: 14900, cost: 10800, stock: 9, minStock: 3 },
  { name: 'Papas fritas 115 g', category: 'Snacks', brand: 'Margarita', unit: 'unit', tax: 'IVA19', price: 4200, cost: 2900, stock: 40, minStock: 12, quick: true, color: '#facc15' },
  { name: 'Galletas de soda x6', category: 'Snacks', brand: 'Noel', unit: 'unit', tax: 'IVA19', price: 3500, cost: 2400, stock: 30, minStock: 10 },
  { name: 'Chocolatina 30 g', category: 'Snacks', brand: 'Jet', unit: 'unit', tax: 'IVA19', price: 1800, cost: 1100, stock: 100, minStock: 30, quick: true, color: '#7c3aed', tier: { minQty: 24, price: 1500 } },
  { name: 'Maní salado 50 g', category: 'Snacks', brand: 'La Especial', unit: 'unit', tax: 'IVA19', price: 2200, cost: 1400, stock: 3, minStock: 10 },
  { name: 'Banano (kg)', category: 'Fruver', brand: null, unit: 'kg', tax: 'EXCLUIDO', price: 3200, cost: 2000, stock: 25, minStock: 5, quick: true, color: '#eab308' },
  { name: 'Tomate chonto (kg)', category: 'Fruver', brand: null, unit: 'kg', tax: 'EXCLUIDO', price: 4500, cost: 3000, stock: 18, minStock: 5, quick: true, color: '#ef4444' },
  { name: 'Papa pastusa (kg)', category: 'Fruver', brand: null, unit: 'kg', tax: 'EXCLUIDO', price: 2800, cost: 1800, stock: 40, minStock: 10 },
  { name: 'Cebolla cabezona (kg)', category: 'Fruver', brand: null, unit: 'kg', tax: 'EXCLUIDO', price: 3900, cost: 2500, stock: 15, minStock: 5 },
];

function pad(n: number, len: number): string {
  return String(n).padStart(len, '0');
}

export interface DemoProductRow {
  product: Product;
  initialStock: number;
  expiresOn: string | null;
}

/** 30 productos con códigos EAN-13 válidos (prefijo 770 Colombia; 2xx para pesables). */
export function demoCatalog(today: Date = new Date()): DemoProductRow[] {
  return ROWS.map((r, i) => {
    const n = i + 1;
    const id = `prd_${pad(n, 3)}`;
    const barcode = r.unit === 'kg' ? ean13(`2000000${pad(n, 5)}`) : ean13(`7701234${pad(n, 5)}`);
    const prices: Product['prices'] = [{ priceListId: 'general', priceCents: r.price * 100, minQty: 1 }];
    if (r.wholesale) prices.push({ priceListId: 'mayorista', priceCents: r.wholesale * 100, minQty: 1 });
    if (r.tier) prices.push({ priceListId: 'general', priceCents: r.tier.price * 100, minQty: r.tier.minQty });
    const packs: Product['packs'] = [];
    if (r.pack) {
      packs.push({ id: r.pack.id, name: r.pack.name, unitsPerPack: r.pack.units, barcode: ean13(`7701234${pad(900 + n, 5)}`) });
      prices.push({ priceListId: 'general', priceCents: r.pack.price * 100, minQty: 1, packId: r.pack.id });
    }
    const expiresOn = r.expiresInDays
      ? new Date(today.getTime() + r.expiresInDays * 86400000).toISOString().slice(0, 10)
      : null;
    return {
      initialStock: r.stock,
      expiresOn,
      product: {
        id,
        name: r.name,
        sku: `MM-${pad(n, 4)}`,
        category: r.category,
        brand: r.brand,
        unit: r.unit,
        taxCode: r.tax,
        taxRateBp: TAX_RATES_BP[r.tax],
        taxIncluded: true,
        priceCents: r.price * 100,
        costAvgCents: r.cost * 100,
        minStock: r.minStock,
        active: true,
        tracksLots: Boolean(r.expiresInDays),
        barcodes: [barcode],
        prices,
        packs,
        color: r.color ?? null,
        quick: Boolean(r.quick),
      },
    };
  });
}

export const DEMO_CUSTOMERS: Customer[] = [
  { id: 'cus_rosa', name: 'Tienda Doña Rosa', docId: '900123456-7', phone: '3001234567', priceListId: 'mayorista', creditLimitCents: 50000000, active: true },
  { id: 'cus_carlos', name: 'Carlos Pérez', docId: '1020304050', phone: '3109876543', priceListId: null, creditLimitCents: 20000000, active: true },
  { id: 'cus_restaurante', name: 'Restaurante El Fogón', docId: '901555222-1', phone: '6015551234', priceListId: 'mayorista', creditLimitCents: 100000000, active: true },
];
