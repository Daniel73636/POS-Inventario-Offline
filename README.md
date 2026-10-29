# POS Inventario — offline-first (PC + Android)

POS liviano con inventario, sincronización por eventos e interfaz de caja rápida.

Repo: https://github.com/Daniel73636/POS-Inventario-Offline

## Multiplataforma

| Superficie | App | Cómo correr |
|------------|-----|-------------|
| PC caja | `apps/pos-web` | PWA / navegador (offline localStorage + sync) |
| Panel dueño | `apps/web` | Next.js |
| Android | `apps/pos-android` | Expo (venta móvil) |
| API sync | `apps/api` | Fastify `:4003` |

> Tauri 2 (instalador nativo ~10MB) queda documentado en la arquitectura; en este entorno se entrega **pos-web** offline-first como caja PC equivalente.

## Arranque

```bash
pnpm install
pnpm --filter @pos/domain-pos test
pnpm --filter @pos/sync-engine test
pnpm --filter @pos/api seed
pnpm --filter @pos/api dev
# otra terminal
pnpm --filter @pos/pos-web dev
pnpm --filter @pos/web dev
# Android
pnpm --filter @pos/pos-android start
```

- Caja: http://localhost:3003  
- Panel: http://localhost:3004  
- API: http://localhost:4003/health  

Atajos caja: **F12** cobrar, **F9** limpiar.

## Dominio

- `@pos/domain-pos`: precios, impuestos, pagos, ventas (centavos enteros)
- `@pos/sync-engine`: HLC, push/pull idempotente, proyecciones

Seed: **MiniMarket Demo** con 30 productos y códigos de barras.
