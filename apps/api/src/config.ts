import { join } from 'node:path';

export interface AppConfig {
  port: number;
  databaseUrl: string | null;
  pgliteDir: string | null;
  jwtSecret: string;
  corsOrigins: string[] | true;
  seedDemo: boolean;
  timezone: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cors = (env.CORS_ORIGINS ?? '*').trim();
  return {
    port: Number(env.PORT ?? 4000),
    databaseUrl: env.DATABASE_URL?.trim() || null,
    pgliteDir: env.PGLITE_DIR === 'memory' ? null : env.PGLITE_DIR || join(process.cwd(), 'data', 'pglite'),
    jwtSecret: env.JWT_SECRET || 'dev-secret-cambiar-en-produccion',
    corsOrigins: cors === '*' ? true : cors.split(',').map((s) => s.trim()),
    seedDemo: (env.SEED_DEMO ?? 'true') !== 'false',
    timezone: env.BUSINESS_TZ || 'America/Bogota',
  };
}

export const CONFIG = Symbol('CONFIG');
export const DB = Symbol('DB');
