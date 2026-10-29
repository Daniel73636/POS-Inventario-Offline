import { PGlite } from '@electric-sql/pglite';
import { Pool, types } from 'pg';

/** Interfaz mínima común para PostgreSQL real (pg) y PGlite embebido. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Database extends Queryable {
  readonly kind: 'postgres' | 'pglite';
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** int8 y numeric llegan como string/bigint: se normalizan a number. */
function normalizeRow<T>(row: Record<string, unknown>): T {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === 'bigint') row[k] = Number(v);
  }
  return row as T;
}

const INT8 = 20;
const NUMERIC = 1700;
const PGLITE_PARSERS = { [INT8]: (v: string) => Number(v), [NUMERIC]: (v: string) => Number(v) };

class PgDatabase implements Database {
  readonly kind = 'postgres' as const;
  private pool: Pool;

  constructor(url: string) {
    types.setTypeParser(INT8, (v) => Number(v));
    types.setTypeParser(NUMERIC, (v) => Number(v));
    this.pool = new Pool({ connectionString: url, max: 10 });
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(sql, params as unknown[]);
    return r.rows.map((row) => normalizeRow<T>(row));
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const q: Queryable = {
        query: async <R>(sql: string, params: unknown[] = []) =>
          (await client.query(sql, params as unknown[])).rows.map((row) => normalizeRow<R>(row)),
      };
      const out = await fn(q);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgliteDatabase implements Database {
  readonly kind = 'pglite' as const;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PGlite) {}

  /** PGlite es de una sola conexión: se serializan las transacciones. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.enqueue(async () => {
      const r = await this.db.query<Record<string, unknown>>(sql, params as unknown[], { parsers: PGLITE_PARSERS });
      return r.rows.map((row) => normalizeRow<T>(row));
    });
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.enqueue(() =>
      this.db.transaction(async (tx) => {
        const q: Queryable = {
          query: async <R>(sql: string, params: unknown[] = []) =>
            (await tx.query<Record<string, unknown>>(sql, params as unknown[], { parsers: PGLITE_PARSERS })).rows.map((row) => normalizeRow<R>(row)),
        };
        return fn(q);
      }),
    ) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export interface CreateDatabaseOptions {
  /** postgres://... Si se omite se usa PGlite (PostgreSQL embebido en WASM). */
  url?: string | null;
  /** Carpeta de datos PGlite; omitir = en memoria. */
  dataDir?: string | null;
}

export async function createDatabase(opts: CreateDatabaseOptions = {}): Promise<Database> {
  if (opts.url) return new PgDatabase(opts.url);
  const pglite = new PGlite(opts.dataDir ?? undefined, { parsers: PGLITE_PARSERS });
  await pglite.waitReady;
  return new PgliteDatabase(pglite);
}
