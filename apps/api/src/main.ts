import { DEMO_OWNER, DEMO_PAIRING_CODE } from '@pos/contracts';
import { createApp } from './app.factory';
import { ConfigError, loadConfig } from './config';

async function bootstrap() {
  const config = loadConfig();
  const { app, db } = await createApp(config);
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`API POS escuchando en http://localhost:${config.port} (base: ${db.kind}${db.kind === 'pglite' ? ` en ${config.pgliteDir}` : ''})`);
  if (config.demoMode) {
    console.log(`DEMO_MODE activo: panel ${DEMO_OWNER.email} / ${DEMO_OWNER.password} · código de emparejamiento ${DEMO_PAIRING_CODE}`);
  }
}

bootstrap().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
