import type { Database } from './adapter';

/** Migraciones versionadas (mismo diseño que el esquema local del dispositivo). */
export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'core',
    sql: `
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  server_seq BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'COP',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL
);
CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  pin_hash TEXT NOT NULL
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  last_seq BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE pairing_codes (
  code TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  uses_left INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

-- Registro de eventos inmutable (fuente de verdad) con cursor global por tenant.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  server_seq BIGINT NOT NULL,
  tenant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  hlc TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, seq),
  UNIQUE (tenant_id, server_seq)
);

CREATE TABLE price_lists (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sku TEXT,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  tax_rate_bp INT NOT NULL,
  price_cents BIGINT NOT NULL,
  cost_avg_cents BIGINT NOT NULL DEFAULT 0,
  min_stock NUMERIC,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  data JSONB NOT NULL,
  updated_hlc TEXT NOT NULL
);
CREATE INDEX products_tenant_name ON products (tenant_id, name);
CREATE TABLE barcodes (
  tenant_id TEXT NOT NULL,
  barcode TEXT NOT NULL,
  product_id TEXT NOT NULL,
  pack_id TEXT,
  PRIMARY KEY (tenant_id, barcode)
);
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_hlc TEXT NOT NULL
);
CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  lot_code TEXT,
  expires_on DATE,
  qty NUMERIC NOT NULL,
  unit_cost_cents BIGINT,
  reason TEXT NOT NULL,
  ref_id TEXT,
  device_id TEXT NOT NULL,
  user_id TEXT,
  hlc TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX stock_movements_product ON stock_movements (tenant_id, product_id);
CREATE VIEW stock_levels AS
  SELECT tenant_id, store_id, product_id, SUM(qty) AS qty FROM stock_movements GROUP BY 1, 2, 3;

CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  cash_session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  customer_id TEXT,
  status TEXT NOT NULL,
  local_number INT NOT NULL,
  fiscal_number TEXT,
  subtotal_cents BIGINT NOT NULL,
  discount_cents BIGINT NOT NULL,
  tax_cents BIGINT NOT NULL,
  total_cents BIGINT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  hlc TEXT NOT NULL,
  voided_at TIMESTAMPTZ,
  void_reason TEXT
);
CREATE INDEX sales_tenant_time ON sales (tenant_id, occurred_at);
CREATE TABLE sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  pack_id TEXT,
  qty NUMERIC NOT NULL,
  base_qty NUMERIC NOT NULL,
  unit_price_cents BIGINT NOT NULL,
  unit_cost_cents BIGINT NOT NULL,
  discount_cents BIGINT NOT NULL,
  tax_rate_bp INT NOT NULL,
  tax_cents BIGINT NOT NULL,
  line_total_cents BIGINT NOT NULL
);
CREATE TABLE sale_payments (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  method TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  reference TEXT
);
CREATE TABLE cash_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  opening_cents BIGINT NOT NULL,
  closed_at TIMESTAMPTZ,
  counted_cents BIGINT,
  expected_cents BIGINT,
  difference_cents BIGINT
);
CREATE TABLE cash_movements (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  reason TEXT NOT NULL,
  user_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  product_id TEXT,
  message TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE TABLE fiscal_ranges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  range_from BIGINT NOT NULL,
  range_to BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];

export async function migrate(db: Database): Promise<number[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const done = new Set((await db.query<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => r.version));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await db.tx(async (q) => {
      for (const stmt of splitSql(m.sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
    });
    applied.push(m.version);
  }
  return applied;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}
