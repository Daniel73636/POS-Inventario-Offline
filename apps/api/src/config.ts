import { join } from 'node:path';
import { z } from 'zod';

export interface AppConfig {
  port: number;
  production: boolean;
  /** Tienda demo, código DEMO-2026 y PINs conocidos. Nunca en producción salvo que se pida explícitamente. */
  demoMode: boolean;
  databaseUrl: string | null;
  pgliteDir: string | null;
  jwtSecret: string;
  corsOrigins: string[] | true;
  seedDemo: boolean;
  timezone: string;
  /** Intentos por ventana para login y registro de dispositivos. */
  rateLimit: { max: number; windowMs: number };
}

const DEV_JWT_SECRET = 'dev-secret-cambiar-en-produccion';

const bool = z
  .enum(['true', 'false', '1', '0'], { message: 'debe ser true o false' })
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    PORT: z.coerce.number({ message: 'debe ser un número' }).int().min(1).max(65535).default(4000),
    DEMO_MODE: bool.optional(),
    SEED_DEMO: bool.optional(),
    DATABASE_URL: z
      .string()
      .trim()
      .regex(/^postgres(ql)?:\/\//, 'debe empezar por postgres://')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    PGLITE_DIR: z.string().optional(),
    JWT_SECRET: z.string().optional(),
    CORS_ORIGINS: z.string().optional(),
    BUSINESS_TZ: z
      .string()
      .default('America/Bogota')
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('es-CO', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'zona horaria IANA inválida'),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || env.JWT_SECRET === DEV_JWT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'obligatorio en producción, mínimo 32 caracteres aleatorios' });
    }
    if (!env.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'obligatorio en producción (PGlite es sólo para desarrollo)' });
    }
    if ((env.CORS_ORIGINS ?? '*').trim() === '*') {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'en producción lista los orígenes permitidos separados por coma' });
    }
  });

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Configuración inválida:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const demoMode = e.DEMO_MODE ?? !production;
  const cors = (e.CORS_ORIGINS ?? '*').trim();
  return {
    port: e.PORT,
    production,
    demoMode,
    databaseUrl: e.DATABASE_URL ?? null,
    pgliteDir: e.PGLITE_DIR === 'memory' ? null : e.PGLITE_DIR || join(process.cwd(), 'data', 'pglite'),
    jwtSecret: e.JWT_SECRET || DEV_JWT_SECRET,
    corsOrigins: cors === '*' ? true : cors.split(',').map((s) => s.trim()).filter(Boolean),
    seedDemo: demoMode && (e.SEED_DEMO ?? true),
    timezone: e.BUSINESS_TZ,
    rateLimit: { max: e.RATE_LIMIT_MAX, windowMs: e.RATE_LIMIT_WINDOW_MS },
  };
}

export const CONFIG = Symbol('CONFIG');
export const DB = Symbol('DB');
