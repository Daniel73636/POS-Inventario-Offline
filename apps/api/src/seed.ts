import { load, save, uid, type Product } from "./store.js";

const catalog: Array<Omit<Product, "id">> = [
  { name: "Agua 600ml", barcode: "7701001001001", priceCents: 2500, costCents: 1200, taxRateBp: 1900, stock: 120, unit: "unit", active: true },
  { name: "Gaseosa 1.5L", barcode: "7701001001002", priceCents: 5500, costCents: 3200, taxRateBp: 1900, stock: 80, unit: "unit", active: true },
  { name: "Pan tajado", barcode: "7701001001003", priceCents: 4800, costCents: 2800, taxRateBp: 0, stock: 40, unit: "unit", active: true },
  { name: "Huevos x12", barcode: "7701001001004", priceCents: 9500, costCents: 7000, taxRateBp: 0, stock: 35, unit: "unit", active: true },
  { name: "Leche 1L", barcode: "7701001001005", priceCents: 4200, costCents: 3000, taxRateBp: 0, stock: 50, unit: "unit", active: true },
  { name: "Arroz 1kg", barcode: "7701001001006", priceCents: 3800, costCents: 2500, taxRateBp: 0, stock: 60, unit: "unit", active: true },
  { name: "Aceite 1L", barcode: "7701001001007", priceCents: 12000, costCents: 9000, taxRateBp: 1900, stock: 25, unit: "unit", active: true },
  { name: "Café 250g", barcode: "7701001001008", priceCents: 14500, costCents: 10000, taxRateBp: 1900, stock: 20, unit: "unit", active: true },
  { name: "Azúcar 1kg", barcode: "7701001001009", priceCents: 4200, costCents: 2800, taxRateBp: 0, stock: 45, unit: "unit", active: true },
  { name: "Sal 500g", barcode: "7701001001010", priceCents: 1800, costCents: 900, taxRateBp: 0, stock: 70, unit: "unit", active: true },
  { name: "Jabón barra", barcode: "7701001001011", priceCents: 2200, costCents: 1200, taxRateBp: 1900, stock: 90, unit: "unit", active: true },
  { name: "Papel higiénico x4", barcode: "7701001001012", priceCents: 8900, costCents: 6000, taxRateBp: 1900, stock: 30, unit: "unit", active: true },
  { name: "Detergente 1kg", barcode: "7701001001013", priceCents: 11000, costCents: 7500, taxRateBp: 1900, stock: 22, unit: "unit", active: true },
  { name: "Galletas", barcode: "7701001001014", priceCents: 3200, costCents: 1800, taxRateBp: 1900, stock: 55, unit: "unit", active: true },
  { name: "Chocolate", barcode: "7701001001015", priceCents: 2800, costCents: 1500, taxRateBp: 1900, stock: 48, unit: "unit", active: true },
  { name: "Atún lata", barcode: "7701001001016", priceCents: 6500, costCents: 4200, taxRateBp: 1900, stock: 40, unit: "unit", active: true },
  { name: "Pasta 500g", barcode: "7701001001017", priceCents: 3500, costCents: 2000, taxRateBp: 0, stock: 65, unit: "unit", active: true },
  { name: "Tomate kg", barcode: "7701001001018", priceCents: 4000, costCents: 2500, taxRateBp: 0, stock: 18, unit: "kg", active: true },
  { name: "Cebolla kg", barcode: "7701001001019", priceCents: 3200, costCents: 1800, taxRateBp: 0, stock: 22, unit: "kg", active: true },
  { name: "Plátano und", barcode: "7701001001020", priceCents: 800, costCents: 400, taxRateBp: 0, stock: 100, unit: "unit", active: true },
  { name: "Manzana und", barcode: "7701001001021", priceCents: 1500, costCents: 900, taxRateBp: 0, stock: 60, unit: "unit", active: true },
  { name: "Yogur", barcode: "7701001001022", priceCents: 2800, costCents: 1700, taxRateBp: 0, stock: 36, unit: "unit", active: true },
  { name: "Queso 250g", barcode: "7701001001023", priceCents: 9800, costCents: 7000, taxRateBp: 0, stock: 15, unit: "unit", active: true },
  { name: "Jamón 250g", barcode: "7701001001024", priceCents: 8900, costCents: 6200, taxRateBp: 1900, stock: 18, unit: "unit", active: true },
  { name: "Cerveza", barcode: "7701001001025", priceCents: 3500, costCents: 2200, taxRateBp: 1900, stock: 72, unit: "unit", active: true },
  { name: "Cigarrillos", barcode: "7701001001026", priceCents: 12000, costCents: 9000, taxRateBp: 1900, stock: 40, unit: "unit", active: true },
  { name: "Pilas AA x2", barcode: "7701001001027", priceCents: 6500, costCents: 4000, taxRateBp: 1900, stock: 28, unit: "unit", active: true },
  { name: "Fósforos", barcode: "7701001001028", priceCents: 1000, costCents: 400, taxRateBp: 1900, stock: 80, unit: "unit", active: true },
  { name: "Bolsa basura", barcode: "7701001001029", priceCents: 4500, costCents: 2800, taxRateBp: 1900, stock: 25, unit: "unit", active: true },
  { name: "Encendedor", barcode: "7701001001030", priceCents: 2000, costCents: 800, taxRateBp: 1900, stock: 50, unit: "unit", active: true },
];

const s = load();
s.products = catalog.map((p) => ({ ...p, id: uid() }));
s.events = [];
s.sales = [];
s.devices = [];
s.serverSeq = 0;
save();
console.log(`Seed MiniMarket Demo: ${s.products.length} productos`);
