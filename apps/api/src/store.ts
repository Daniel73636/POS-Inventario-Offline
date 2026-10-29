import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, "../../../data/pos-store.json");

export type Product = {
  id: string;
  name: string;
  barcode: string;
  priceCents: number;
  costCents: number;
  taxRateBp: number;
  stock: number;
  unit: string;
  active: boolean;
};

export type Device = {
  id: string;
  tenantId: string;
  storeId: string;
  name: string;
  token: string;
  cursor: number;
};

export type ServerEvent = {
  id: string;
  tenantId: string;
  storeId: string;
  deviceId: string;
  seq: number;
  type: string;
  payload: unknown;
  occurredAt: string;
  serverSeq: number;
};

export type Store = {
  tenantId: string;
  storeId: string;
  products: Product[];
  devices: Device[];
  events: ServerEvent[];
  serverSeq: number;
  sales: unknown[];
};

function empty(): Store {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    storeId: "22222222-2222-4222-8222-222222222222",
    products: [],
    devices: [],
    events: [],
    serverSeq: 0,
    sales: [],
  };
}

let mem: Store | null = null;

export function load(): Store {
  if (mem) return mem;
  try {
    if (fs.existsSync(FILE)) mem = JSON.parse(fs.readFileSync(FILE, "utf8")) as Store;
  } catch {
    /* ignore */
  }
  if (!mem) mem = empty();
  return mem;
}

export function save(): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(mem, null, 2));
}

export function uid(): string {
  return randomUUID();
}
