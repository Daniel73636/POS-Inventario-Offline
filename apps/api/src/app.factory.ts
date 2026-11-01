import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createDatabase, migrate, seedDemo, type Database } from '@pos/db';
import { mkdirSync } from 'node:fs';
import { AppModule } from './app.module';
import { SpanishErrorFilter } from './common/errors';
import type { AppConfig } from './config';

export async function openDatabase(config: AppConfig): Promise<Database> {
  if (!config.databaseUrl && config.pgliteDir) mkdirSync(config.pgliteDir, { recursive: true });
  const db = await createDatabase({ url: config.databaseUrl, dataDir: config.databaseUrl ? null : config.pgliteDir });
  await migrate(db);
  if (config.seedDemo) await seedDemo(db);
  return db;
}

export async function createApp(config: AppConfig, db?: Database): Promise<{ app: NestFastifyApplication; db: Database }> {
  const database = db ?? (await openDatabase(config));
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config, database),
    new FastifyAdapter({ bodyLimit: 5 * 1024 * 1024, trustProxy: config.production }),
    { logger: process.env.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'] },
  );
  app.useGlobalFilters(new SpanishErrorFilter());
  app.enableCors({ origin: config.corsOrigins, credentials: false });
  app.enableShutdownHooks();
  return { app, db: database };
}
