# POS Inventario — POS liviano con inventario offline-first (PC + Android)

Punto de venta para tiendas de barrio y minimercados que **vende sin internet, sin perder un solo dato**.
Cada caja escribe primero en su base local un registro de **eventos inmutables** (`SaleCompleted`,
`StockReceived`, `CashMovement`…) con `device_id + seq + HLC`, y los sincroniza de forma
**idempotente** con el servidor central cuando hay conexión.

| Superficie | App | Tecnología | Puerto |
|---|---|---|---|
| Caja PC (navegador / PWA) | `apps/pos-web` | Next.js 15 (100 % cliente) + base local IndexedDB (Dexie) + service worker | 3001 |
| App Android | `apps/pos-android` | Expo SDK 54 (React Native 0.81) + `expo-sqlite` + `expo-camera` | Metro |
| Panel del dueño | `apps/web` | Next.js 15 | 3000 |
| API central y sincronización | `apps/api` | NestJS 11 + Fastify + PostgreSQL (o PGlite embebido) | 4000 |

## Estructura

```
POSInventario/
├── apps/
│   ├── api/            NestJS + Fastify: dispositivos, sync push/pull/snapshot, catálogo, reportes, fiscal (stub)
│   ├── pos-web/        Caja PC offline-first: venta por teclado, inventario, caja, ventas, ajustes
│   ├── pos-android/    Expo: venta móvil, escaneo con cámara, consulta de precio/stock, tablero del día
│   └── web/            Panel del dueño: tablero, productos, inventario, clientes, cierres, dispositivos, alertas
├── packages/
│   ├── domain-pos/     Funciones puras de dominio (dinero en centavos enteros) + pruebas
│   ├── contracts/      Esquemas Zod de eventos y API + catálogo "MiniMarket Demo" (30 productos EAN-13)
│   ├── sync-engine/    HLC, UUIDv7, fábrica de eventos, proyecciones, cliente push/pull + simulación
│   ├── db/             Adaptador PostgreSQL/PGlite, migraciones, proyector SQL, ingesta idempotente, seed
│   └── ui/             Utilidades de presentación compartidas
├── docker-compose.yml  PostgreSQL 16 opcional
└── .env.example
```

## Requisitos

- Node.js 20+ (probado con 24) y **pnpm 9.15.0** (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- Opcional: Docker (PostgreSQL). Sin Docker la API usa **PGlite** (PostgreSQL real compilado a WASM) en `apps/api/data/pglite`.
- Android: app **Expo Go** (SDK 54) en el celular, o un emulador Android.

## Puesta en marcha (PC)

```bash
pnpm install
pnpm build:packages          # compila domain-pos, contracts, sync-engine, db (los usa la API)
cp .env.example .env         # opcional

pnpm dev:api                 # API en http://localhost:4000 (migra y crea el seed automáticamente)
pnpm dev:pos                 # Caja en http://localhost:3001
pnpm dev:web                 # Panel en http://localhost:3000
```

Con PostgreSQL en Docker:

```bash
docker compose up -d postgres
DATABASE_URL=postgres://pos:pos@localhost:5432/pos pnpm dev:api     # PowerShell: $env:DATABASE_URL="..."; pnpm dev:api
```

### Credenciales demo (seed "MiniMarket Demo")

Sólo existen con `DEMO_MODE=true` (por defecto fuera de `NODE_ENV=production`). En producción la API no
siembra la tienda demo, rechaza `DEMO-2026` y exige códigos de un solo uso con vencimiento; además
valida el entorno al arrancar (`JWT_SECRET` ≥ 32 caracteres, `DATABASE_URL`, `CORS_ORIGINS` explícito).
Ver `docs/AUDITORIA.md`, `docs/SYNC.md`, `docs/FACTURACION_DIAN.md` y `docs/DECISIONES.md`.

| Qué | Valor |
|---|---|
| Código de vinculación de cajas | `DEMO-2026` (100 usos) |
| Panel del dueño | `dueno@minimarket.demo` / `demo1234` |
| PIN cajera Ana | `1234` |
| PIN supervisor Luis | `9999` |
| PIN dueña | `0000` |

El seed crea 30 productos con códigos **EAN-13 válidos** (prefijo 770; pesables con prefijo 2),
listas de precios *general* y *mayorista*, precios por volumen, un six-pack como presentación,
lotes con vencimiento, 3 clientes y una semana de ventas históricas para que el panel tenga datos.

Códigos para probar: `7701234000011` gaseosa · `7701234009014` six-pack · `12*7701234000066` 12 arroz (precio por volumen) · escribe `leche`.

## Caja PC (`apps/pos-web`)

1. Abre http://localhost:3001 → **Registrar caja y descargar catálogo** (o **Modo demo sin servidor**).
2. Entra con el PIN, abre el turno con la base de efectivo y vende.

Pantalla de venta (objetivo: 3 productos en < 10 s sin mouse): columna izquierda 65 % con
`ScanInput` siempre enfocado y `CartTable`; derecha 35 % con `TotalPanel` (total enorme) y acciones;
abajo `QuickGrid`; barra de estado con usuario, turno, impresora, conexión e indicador
**Sincronizado | Pendiente (n) | Sin conexión**.

| Tecla | Acción |
|---|---|
| Escanear / escribir + `Enter` | Agrega por código; texto = búsqueda sin tildes (↑↓ + Enter) |
| `3*código` | Cantidad antes del código (sirve para kg: `0,75*2000000000275` = 0,75 kg de banano) |
| `Enter` con campo vacío / `F12` | Cobrar |
| `F2` | Buscar (enfocar campo) |
| `F3` | Cantidad exacta de la línea activa |
| `F4` | Cliente (aplica su lista de precios) |
| `F6` | Descuento (límite por rol; si lo excede pide PIN de supervisor) |
| `F9` / `F10` | Suspender venta / recuperar ventas en espera |
| `↑ ↓`, `+ −`, `Supr` | Línea activa, cantidad, eliminar |
| `Alt+1…5` | Venta · Inventario · Caja · Ventas · Ajustes |

`PaymentDialog`: `E` efectivo, `T` tarjeta, `R` transferencia, `C` crédito; teclado numérico,
billetes rápidos, pagos mixtos, **cambio en verde y grande**, `Enter` confirma.
Código inexistente → crear producto al vuelo sin salir de la venta. Sonidos distintos para
escaneo correcto, no encontrado y stock insuficiente (la venta se permite y el stock queda negativo).

Otras pantallas: **Inventario** (entradas con costo → costo promedio ponderado; conteo físico con PIN),
**Caja** (ingresos/retiros, cierre con efectivo esperado vs. contado), **Ventas** (anulación con PIN de
supervisor, devuelve stock), **Ajustes** (estado de sync, desfase de reloj, registro de eventos).

**Offline:** la red nunca está en el camino de una venta. Corta la API o el Wi-Fi y sigue vendiendo:
el indicador pasa a *Sin conexión · Pendiente (n)* y al volver la red sube los eventos en lotes con
reintentos exponenciales + jitter. En `pnpm --filter @pos/pos-web build && pnpm --filter @pos/pos-web start`
el service worker permite incluso **recargar la página sin conexión**. La venta en curso se guarda
para recuperarla tras un corte, y al arrancar se re-aplican eventos que no alcanzaron a proyectarse.

**Ruta futura — Tauri 2:** en este entorno no hay Rust, así que la caja de escritorio se entrega como
web/PWA. La migración a Tauri reutiliza intacta esta UI y `domain-pos`/`sync-engine`; sólo cambia la
implementación de `SyncStore` (`apps/pos-web/src/lib/local-db.ts`) por comandos Rust `db_*` sobre
SQLite + SQLCipher, y se agregan `print_*` (ESC/POS), `drawer_open`, `scale_read` y el updater firmado.

## App Android (`apps/pos-android`)

```bash
pnpm dev:android             # expo start → escanea el QR con Expo Go (SDK 54)
pnpm --filter @pos/pos-android export      # verificación: genera el bundle Hermes de Android en dist/
pnpm --filter @pos/pos-android build:apk   # APK con EAS (requiere cuenta Expo)
```

- **Venta móvil** con carrito rápido y cobro (efectivo con cambio, tarjeta, transferencia).
- **Escaneo con cámara** (`expo-camera`: EAN-13/8, UPC, Code 128, QR) con vibración y modo ráfaga.
- **Consulta de precio y stock**, con precios por volumen, lista mayorista y presentaciones.
- **Tablero del día**: ventas, total, utilidad, medios de pago, productos bajo mínimo.
- Base local **SQLite** (`expo-sqlite`): evento y proyección en la misma transacción.
- Usa los mismos paquetes `@pos/domain-pos`, `@pos/contracts` y `@pos/sync-engine` que la caja PC.
- En **Ajustes**: URL de la API (`http://10.0.2.2:4000` en emulador; en celular físico la IP del PC en la red Wi-Fi) + código `DEMO-2026`, o modo demo.

## Panel del dueño (`apps/web`)

Tablero (ventas, ticket promedio, utilidad real con costos congelados, margen, medios de pago, cajas en
línea), ventas por día y utilidad por producto, **Productos** (editar precio/nombre, activar/desactivar,
entrada de mercancía — los cambios llegan a las cajas como eventos), **Inventario** (valor a costo y a
precio, bajo mínimo, negativos), **Clientes** (cupo y ventas a crédito), **Cierres de caja**,
**Dispositivos** (códigos de vinculación de un solo uso, revocación remota) y **Alertas**
(stock negativo, diferencia de precio, anulaciones, diferencias de caja, códigos duplicados).

## Sincronización

| Ruta | Descripción |
|---|---|
| `POST /v1/devices/register` | Registro con código; devuelve token del dispositivo (en la base sólo se guarda su hash) |
| `POST /v1/sync/push` | Lote ≤ 200 eventos ordenados por `seq`; `(device_id, seq)` único → reenviar nunca duplica |
| `GET /v1/sync/pull?cursor=N` | Eventos de otros dispositivos desde el cursor global `server_seq` |
| `GET /v1/sync/snapshot` | Catálogo, clientes, usuarios (hash de PIN), stock y cursor coherente |
| `POST /v1/fiscal/ranges` | Stub: reserva de rangos de numeración por caja |
| `POST /v1/devices/:id/revoke` | Bloqueo remoto |

Reglas de convergencia: ventas/caja **sólo añadir**; inventario = **suma de movimientos** (dos cajas que
venden la última unidad sin conexión dejan el stock en −1 y generan alerta: nunca se rechaza una venta
hecha); catálogo y clientes **última escritura gana por HLC**; el servidor bloquea la fila del tenant
al ingerir, así el cursor avanza en orden de commit y un pull nunca se salta eventos. La venta guarda el
precio y el **costo congelados**; si el precio cambió mientras la caja estaba desconectada se genera una
alerta de diferencia, sin bloquear. El cliente compara la hora del servidor y avisa si el reloj del
equipo se desfasa más de 5 minutos.

## Dominio (`packages/domain-pos`)

Funciones puras: `priceLine` (presentación, volumen, lista, vigencia), `applyDiscount` (límites por rol),
`computeTaxes` (IVA incluido/excluido, INC, exentos; redondeo por línea o por total), `allocateLots`
(FEFO, bloquea vencidos), `averageCost`, `cashExpected`, `splitPayments` (pago mixto y cambio),
`profitOfSale`, más carrito (`addToCart`, `computeCartTotals`, `finalizeSale`).
**Dinero siempre en centavos enteros**; multiplicaciones por cantidades decimales (kg) en milésimas
con `BigInt` y **redondeo bancario**; nunca `float` para dinero.

## Pruebas

```bash
pnpm test                                    # todo el monorepo (turbo)
pnpm --filter @pos/domain-pos test           # 24 pruebas de dominio con casos numéricos conocidos
pnpm --filter @pos/sync-engine test          # 45: HLC, UUIDv7, idempotencia, última unidad, LWW y
                                             #     simulación determinista de 5 cajas × 40 semillas con
                                             #     desconexiones, respuestas perdidas y duplicados
pnpm --filter @pos/api test                  # e2e de la API sobre PGlite en memoria (incluye aislamiento entre tenants)
pnpm --filter @pos/pos-web test              # base local IndexedDB (fake-indexeddb) y bloqueo de PIN
```

Resultado actual: **109 pruebas en verde** (domain 24, sync 45, contracts 9, db 3, pos-web 8, API e2e 20).

Salud de la API: `GET /health` (proceso vivo) y `GET /ready` (base accesible y migraciones al día).
Errores: `{ statusCode, code, message, details? }` en español.

## Limitaciones conocidas (MVP)

- La caja PC guarda en IndexedDB con almacenamiento persistente y respaldo JSON (Ajustes → Base local y respaldo). Para escritorio: Tauri + SQLite/SQLCipher.
- Sin cifrado de la base local. El registro de auditoría del servidor (`audit_log`) es sólo-inserción y encadenado por hash.
- Impresión: ticket por el diálogo del navegador (`window.print`); sin ESC/POS, cajón ni balanza.
- Fiscal: interfaz `FacturacionProvider` con simulador **sin validez legal**; sin proveedor DIAN real ni notas crédito (ver `docs/FACTURACION_DIAN.md`).
- Android: un usuario vendedor fijo (sin PIN), turno abierto automáticamente con base 0, sin conteo físico ni impresión Bluetooth; sincroniza mientras la app está abierta (sin WorkManager).
- El costo promedio se recalcula en cada dispositivo al recibir entradas; puede diferir levemente entre cajas hasta el próximo snapshot (el servidor es la referencia en reportes).
- Sin licenciamiento, borrado remoto de la base local ni Sentry.
