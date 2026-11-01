import { createDatabase, migrate, seedDemo } from '@pos/db';
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  if (!config.databaseUrl && config.pgliteDir) mkdirSync(config.pgliteDir, { recursive: true });
  const db = await createDatabase({ url: config.databaseUrl, dataDir: config.databaseUrl ? null : config.pgliteDir });
  const applied = await migrate(db);
  if (!config.demoMode) {
    console.log(`Migraciones aplicadas: ${applied.join(', ') || 'ninguna'}. DEMO_MODE=false: no se crea la tienda demo.`);
    await db.close();
    return;
  }
  const r = await seedDemo(db);
  console.log(`Migraciones aplicadas: ${applied.join(', ') || 'ninguna'}`);
  console.log(r.created ? `Seed MiniMarket Demo: ${r.products} productos, ${r.historicalSales} ventas históricas` : 'Seed ya existía');
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
