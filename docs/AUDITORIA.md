# Auditoría de endurecimiento para producción — POSInventario

Fecha: 2026-11-01 · Rama: `feat/mejora-produccion-ux` · Base: `feat/pos-complete-mvp` (e547586)

## Línea base

| Comando | Resultado |
|---|---|
| `pnpm install` | OK |
| `pnpm build:packages` | OK (5 tareas) |
| `pnpm typecheck` | OK (13 tareas) |
| `pnpm test` | **79 pruebas en verde**: domain-pos 24, sync-engine 45, contracts 3, db 3, API e2e 4 |

Alcance revisado: `README.md`, `packages/domain-pos`, `packages/sync-engine`, `packages/db`
(ingesta, proyector, seed, seguridad), `apps/pos-web/src/lib/local-db.ts` y `pos-context.tsx`,
`apps/api/src/auth` y `devices`, `apps/pos-android/src/store.ts`.

## Hallazgos

Severidad: **P0** = riesgo de pérdida de datos, fuga entre clientes o acceso no autorizado; bloquea
producción. **P1** = debe resolverse antes del primer cliente pagando. **P2** = mejora planificada.

### P0

| # | Hallazgo | Evidencia | Acción |
|---|---|---|---|
| P0-1 | **Escrituras entre tenants en el proyector.** `products`, `customers`, `sales`, `cash_sessions`, `cash_movements` usan `id` global como PK y el proyector actualiza por `id` sin filtrar `tenant_id`. Un dispositivo del tenant B puede enviar `SaleVoided`/`CashSessionClosed` con un id del tenant A, o un `ProductUpserted` con `prd_001` (ids deterministas del demo) y sobrescribir datos ajenos. | `packages/db/src/projector.ts` (`UPDATE sales ... WHERE id = $1`, `ON CONFLICT (id) DO UPDATE` en products/customers) | Migración 2: PK compuestas `(tenant_id, id)` y `tenant_id` en todas las consultas del proyector. Pruebas de aislamiento. |
| P0-2 | **PIN con SHA-256 sin sal** de `tenant:pin` y distribuido a todas las cajas en el snapshot. Con PIN de 4 dígitos se invierte en milisegundos. Sin bloqueo por intentos fallidos. | `packages/db/src/security.ts` `hashPin`, `pos-context.tsx` `login`/`verifyPin` | PBKDF2-SHA256 (WebCrypto, 120 000 iteraciones, sal por usuario), verificación compatible con hashes antiguos, bloqueo tras 5 intentos con espera creciente y registro de auditoría local. |
| P0-3 | **Secretos de demo activos por defecto.** `SEED_DEMO` es `true` salvo que se desactive: en producción quedan `DEMO-2026` (100 usos, sin vencimiento), `dueno@minimarket.demo / demo1234` y PINs conocidos. `JWT_SECRET` tiene valor por defecto. | `apps/api/src/config.ts`, `packages/db/src/seed.ts` | `DEMO_MODE` explícito: `true` por defecto sólo fuera de `NODE_ENV=production`. En producción: sin seed demo, `DEMO-2026` rechazado, códigos de un solo uso con vencimiento obligatorio y `JWT_SECRET` ≥ 32 caracteres o la API no arranca. |
| P0-4 | **Caja web sobre `localStorage`**: ~5 MB, escritura síncrona de todo el registro en cada venta, sin `navigator.storage.persist()` (el navegador puede desalojar los datos) y sin respaldo. Si se excede la cuota, `setItem` lanza excepción después de consumir el `seq`. | `apps/pos-web/src/lib/local-db.ts` | Dexie/IndexedDB con esquema versionado, migración automática desde `localStorage`, almacenamiento persistente, exportar/importar respaldo JSON. Mismo adaptador `SyncStore`. |

### P1

| # | Hallazgo | Acción |
|---|---|---|
| P1-1 | Sin límite de intentos en `POST /v1/devices/register` ni `POST /v1/auth/login` (fuerza bruta de códigos de emparejamiento y contraseñas). | Limitador en memoria por IP + clave, `429` con mensaje en español. |
| P1-2 | El dueño puede crear códigos de hasta 100 usos; los códigos son 2×4 dígitos. | En producción `uses = 1` forzado y caducidad ≤ 24 h. |
| P1-3 | Revocación remota existe y la caja pasa a `revoked`, pero sólo había una prueba indirecta. Falta cubrir pull/snapshot con token revocado y revocación desde otro tenant. | Pruebas e2e dedicadas. |
| P1-4 | `/health` consulta la base (mezcla *liveness* con *readiness*); no hay `/ready`, ni validación de variables de entorno. | `/health` sin dependencias, `/ready` con base + migraciones; `loadConfig` valida con Zod. |
| P1-5 | Errores HTTP con mensajes por defecto de Nest en inglés (`Not Found`, `Cannot GET`) y formato inconsistente. | Filtro global: `{ statusCode, code, message, details? }` en español; se conserva `message` (lo usan las cajas). |
| P1-6 | No hay registro de auditoría explícito: el descuento autorizado por supervisor no guarda quién autorizó; los eventos sólo viven en la tabla `events`. | Campo opcional `discountAuthorizedBy` en `SaleCompleted`; tabla `audit_log` sólo-inserción (triggers que impiden `UPDATE`/`DELETE`) con encadenamiento por hash; `GET /v1/audit` para el dueño. |
| P1-7 | `GET /v1/products/:id` suma stock sin filtrar `tenant_id`. | Filtrar por tenant (parte de P0-1). |
| P1-8 | CI no versionado (`.github/workflows/ci.yml` sin commit) y sin `typecheck`. | CI con build, typecheck y pruebas. |
| P1-9 | La política de conflictos (stock negativo + alerta, LWW por HLC) está sólo en el README. | `docs/SYNC.md`. |

### P2

| # | Hallazgo | Acción |
|---|---|---|
| P2-1 | Facturación electrónica DIAN: sólo stub de rangos. | Interfaz `FacturacionProvider` + mock explícitamente **sin validez legal** + `docs/FACTURACION_DIAN.md`. |
| P2-2 | Atajos de teclado sólo documentados en el README. | Ayuda `?` / `F1` en la caja. |
| P2-3 | Token de dispositivo en texto plano en el almacenamiento del navegador (robable con XSS). | Documentado; mitigación futura: CSP estricta y Tauri con almacén del SO. |
| P2-4 | Sesión del dueño (JWT 12 h) no revocable. | Lista de revocación o sesiones en base (fase 2). |
| P2-5 | Cierre de caja muestra el esperado antes de contar (no es arqueo ciego). | Arqueo ciego en fase 2 (iniciado en esta rama si alcanza el tiempo). |
| P2-6 | FEFO existe en `domain-pos` (`allocateLots`) pero la venta no descuenta lotes; plantillas de impresión ESC/POS; cajón monedero; sincronización Android en segundo plano (WorkManager). | Fase 2. |
| P2-7 | Sin telemetría de errores (Sentry) ni cifrado de la base local. | Fase 2. |

## Lo que ya está bien (verificado)

- Registro de eventos inmutable con `(device_id, seq)` único: reenviar nunca duplica (prueba e2e).
- `SyncClient`: lotes de 200 eventos por `seq`, reintentos exponenciales con *jitter* (`nextDelayMs`), llamadas concurrentes coalescidas, estado `revoked` en 401/403.
- Indicador de estado en la caja: *Sincronizado · Pendiente (n) · Sin conexión*.
- La ingesta rechaza eventos cuyo `deviceId`/`tenantId`/`storeId` no coincide con la credencial.
- Tokens de dispositivo: sólo se guarda su hash; la revocación borra el hash.
- Contraseña del dueño con `scrypt` y sal; comparación en tiempo constante.
- Pantalla de alertas del dueño en `apps/web` (stock negativo, diferencias de precio y de caja, anulaciones, códigos duplicados) con acción *resolver*.

## Plan

**Fase 1 (esta rama), en orden:**

1. Almacenamiento web: Dexie + migración + `persist()` + respaldo JSON (P0-4).
2. Seguridad: PBKDF2 + bloqueo; `DEMO_MODE`; códigos de un solo uso; pruebas de revocación (P0-2, P0-3, P1-1, P1-2, P1-3).
3. Aislamiento tenant/dispositivo: migración 2 + pruebas e2e (P0-1, P1-7).
4. UX de sincronización y `docs/SYNC.md` (P1-9). El indicador, el *backoff* con *jitter*, los lotes y la pantalla de alertas ya existían.
5. `/health`, `/ready`, validación de entorno, CI, errores estructurados en español (P1-4, P1-5, P1-8).
6. `FacturacionProvider` + mock + documentación (P2-1).
7. Registro de auditoría inmutable (P1-6).
8. Ayuda de atajos `?` (P2-2).

**Fase 2:** arqueo ciego con apertura/cierre, FEFO en venta, plantillas de impresión, cajón monedero,
sincronización Android en segundo plano, sesiones del dueño revocables, cifrado local, Sentry.
