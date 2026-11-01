import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Database } from '@pos/db';
import type { FetchLike } from '@pos/sync-engine';
import { createApp } from '../src/app.factory';
import { loadConfig } from '../src/config';

process.env.NODE_ENV = 'test';

export interface TestApi {
  app: NestFastifyApplication;
  db: Database;
  call<T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, token?: string): Promise<{ status: number; body: T; headers: Record<string, unknown> }>;
  /** fetch → app.inject, para probar el SyncClient real contra la API real. */
  fetch: FetchLike;
}

export async function startApi(env: Record<string, string> = {}, db?: Database): Promise<TestApi> {
  const config = { ...loadConfig({ PGLITE_DIR: 'memory', JWT_SECRET: 'test', RATE_LIMIT_MAX: '1000', ...env }), pgliteDir: null };
  const { app, db: database } = await createApp(config, db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return {
    app,
    db: database,
    async call(method, url, body, token) {
      const res = await app.inject({
        method,
        url,
        payload: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
    },
    fetch: async (url, init) => {
      const u = new URL(url);
      const res = await app.inject({ method: (init?.method ?? 'GET') as 'GET', url: u.pathname + u.search, payload: init?.body, headers: init?.headers });
      return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body), text: async () => res.body };
    },
  };
}
