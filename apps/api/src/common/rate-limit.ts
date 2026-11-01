import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config';
import type { AuthedRequest } from './http';

/**
 * Ventana fija en memoria por IP + ruta. Suficiente para una sola instancia;
 * con varias réplicas se debe mover a Redis o al balanceador.
 */
export class FixedWindowLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Devuelve los ms a esperar si se excede el límite; 0 si se permite. */
  take(key: string): number {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 10_000) this.prune(t);
      return 0;
    }
    entry.count += 1;
    return entry.count > this.max ? entry.resetAt - t : 0;
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter: FixedWindowLimiter;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.limiter = new FixedWindowLimiter(config.rateLimit.max, config.rateLimit.windowMs);
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const route = req.routeOptions?.url ?? req.url;
    const waitMs = this.limiter.take(`${req.ip}|${route}`);
    if (waitMs > 0) {
      throw new HttpException(
        { message: `Demasiados intentos. Espera ${Math.ceil(waitMs / 1000)} s e inténtalo de nuevo.`, code: 'demasiados_intentos', retryAfterSeconds: Math.ceil(waitMs / 1000) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
