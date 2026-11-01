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
  {
    version: 2,
    name: 'aislamiento_tenant_y_auditoria',
    // Los ids de proyecciones los generan los clientes: la PK debe incluir tenant_id
    // para que un dispositivo de otra empresa no pueda pisar filas ajenas.
    sql: `
ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS sale_items_sale_id_fkey;
ALTER TABLE sale_payments DROP CONSTRAINT IF EXISTS sale_payments_sale_id_fkey;

ALTER TABLE sale_items ADD COLUMN tenant_id TEXT;
UPDATE sale_items i SET tenant_id = s.tenant_id FROM sales s WHERE s.id = i.sale_id;
ALTER TABLE sale_items ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sale_payments ADD COLUMN tenant_id TEXT;
UPDATE sale_payments p SET tenant_id = s.tenant_id FROM sales s WHERE s.id = p.sale_id;
ALTER TABLE sale_payments ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE cash_movements ADD COLUMN tenant_id TEXT;
UPDATE cash_movements m SET tenant_id = e.tenant_id FROM events e WHERE e.type = 'CashMovement' AND e.payload->>'movementId' = m.id;
ALTER TABLE cash_movements ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE products DROP CONSTRAINT products_pkey;
ALTER TABLE products ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE customers DROP CONSTRAINT customers_pkey;
ALTER TABLE customers ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE sales DROP CONSTRAINT sales_pkey;
ALTER TABLE sales ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE sale_items DROP CONSTRAINT sale_items_pkey;
ALTER TABLE sale_items ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE sale_items ADD FOREIGN KEY (tenant_id, sale_id) REFERENCES sales (tenant_id, id);
ALTER TABLE sale_payments DROP CONSTRAINT sale_payments_pkey;
ALTER TABLE sale_payments ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE sale_payments ADD FOREIGN KEY (tenant_id, sale_id) REFERENCES sales (tenant_id, id);
ALTER TABLE cash_sessions DROP CONSTRAINT cash_sessions_pkey;
ALTER TABLE cash_sessions ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_pkey;
ALTER TABLE cash_movements ADD PRIMARY KEY (tenant_id, id);
CREATE INDEX sale_items_sale ON sale_items (tenant_id, sale_id);
CREATE INDEX sale_payments_sale ON sale_payments (tenant_id, sale_id);

-- Registro de auditoría: sólo inserción, encadenado por hash por tenant.
CREATE TABLE audit_log (
  seq BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurred_at TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT,
  authorized_by TEXT,
  device_id TEXT,
  event_id TEXT,
  ref_id TEXT,
  data JSONB NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX audit_log_tenant ON audit_log (tenant_id, seq);
CREATE UNIQUE INDEX audit_log_event_action ON audit_log (event_id, action);
CREATE FUNCTION audit_log_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_log es de solo insercion'; END $$;
CREATE TRIGGER audit_log_sin_cambios BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_inmutable();
CREATE TRIGGER audit_log_sin_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_inmutable();
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
