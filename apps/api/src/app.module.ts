import { Controller, Get, Inject, Module, type DynamicModule } from '@nestjs/common';
import type { Database } from '@pos/db';
import { AuthController } from './auth/auth.controller';
import { DeviceGuard, OwnerGuard } from './auth/guards';
import { CatalogController } from './catalog/catalog.controller';
import { CONFIG, DB, type AppConfig } from './config';
import { DevicesController } from './devices/devices.controller';
import { ReportsController } from './reports/reports.controller';
import { SyncController } from './sync/sync.controller';

@Controller()
class HealthController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get('health')
  async health() {
    await this.db.query('SELECT 1');
    return { ok: true, db: this.db.kind, serverTime: new Date().toISOString() };
  }
}

@Module({})
export class AppModule {
  static register(config: AppConfig, db: Database): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, DevicesController, SyncController, CatalogController, ReportsController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DB, useValue: db },
        DeviceGuard,
        OwnerGuard,
      ],
    };
  }
}
