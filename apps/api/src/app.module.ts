import { Controller, Get, Inject, Module, ServiceUnavailableException, type DynamicModule } from '@nestjs/common';
import { MIGRATIONS, type Database } from '@pos/db';
import { AuditController } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { DeviceGuard, OwnerGuard } from './auth/guards';
import { CatalogController } from './catalog/catalog.controller';
import { RateLimitGuard } from './common/rate-limit';
import { CONFIG, DB, type AppConfig } from './config';
import { DevicesController } from './devices/devices.controller';
import { FACTURACION, MockFacturacionProvider } from './fiscal/facturacion';
import { ReportsController } from './reports/reports.controller';
import { SyncController } from './sync/sync.controller';

@Controller()
class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: el proceso responde. No toca la base para no reiniciar por una caída de PostgreSQL. */
  @Get('health')
  health() {
    return { ok: true, serverTime: new Date().toISOString() };
  }

  /** Readiness: base accesible y migraciones al día. */
  @Get('ready')
  async ready() {
    const latest = Math.max(...MIGRATIONS.map((m) => m.version));
    try {
      const [row] = await this.db.query<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations');
      const version = Number(row?.version ?? 0);
      if (version < latest) throw new Error(`migraciones pendientes (${version}/${latest})`);
      return { ok: true, db: this.db.kind, schemaVersion: version, demoMode: this.config.demoMode, serverTime: new Date().toISOString() };
    } catch (err) {
      throw new ServiceUnavailableException({
        message: 'La base de datos no está lista',
        code: 'no_listo',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

@Module({})
export class AppModule {
  static register(config: AppConfig, db: Database): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, DevicesController, SyncController, CatalogController, ReportsController, AuditController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DB, useValue: db },
        { provide: FACTURACION, useValue: new MockFacturacionProvider() },
        DeviceGuard,
        OwnerGuard,
        RateLimitGuard,
      ],
    };
  }
}
