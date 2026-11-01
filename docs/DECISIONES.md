# Decisiones de ingeniería — POSInventario

Formato: fecha — tema. **Decisión**, motivo y consecuencias.

## 2026-11-01 — Almacenamiento local web

**Decisión:** Migrar de `localStorage` a **Dexie (IndexedDB)** con esquema versionado, `navigator.storage.persist()` y exportación JSON de respaldo. Mantener adaptador `SyncStore` para no romper `sync-engine`. Tauri + SQLCipher queda documentado, no bloqueante.

**Detalle:** `LocalDb` conserva su API síncrona de lectura (caché en memoria cargada con `LocalDb.open()`) y escribe en IndexedDB por una cola serializada. El evento y el meta se escriben juntos en una transacción; la proyección se guarda en la misma cola con coalescencia y, si se pierde, al arrancar se re-aplican los eventos locales cuyo `seq` supere `state.applied[deviceId]`. Las operaciones de `SyncStore` esperan a que la cola esté vacía: nunca se sube un evento que aún no es durable localmente (si se subiera y luego se perdiera, el siguiente evento reutilizaría el `seq` y el servidor lo rechazaría).

## 2026-11-01 — Demo secrets

**Decisión:** Código `DEMO-2026` y PINs fijos solo activos si `DEMO_MODE=true` (default en desarrollo). En producción el emparejamiento exige códigos de un solo uso con caducidad.

**Detalle:** `DEMO_MODE` vale `true` por defecto sólo si `NODE_ENV !== 'production'`. Con `DEMO_MODE=false` la API no siembra la tienda demo, rechaza `DEMO-2026`, ignora códigos sin `expires_at` y fuerza `uses = 1`. En la caja web el botón *Modo demo* y las pistas de PIN dependen de `NEXT_PUBLIC_DEMO_MODE` con el mismo criterio.

## 2026-11-01 — Hash de PIN

**Decisión:** **PBKDF2-SHA256** con sal aleatoria por usuario y 120 000 iteraciones, formato `pbkdf2$<iter>$<sal-b64url>$<hash-b64url>`, en lugar de bcrypt/argon2.

**Motivo:** el PIN debe validarse sin conexión en la caja (navegador) y en el servidor. PBKDF2 está en WebCrypto (nativo en navegador y Node ≥ 20) sin dependencias ni WASM; bcrypt/argon2 en JS puro serían lentos en cajas modestas. Un PIN de 4 dígitos sigue siendo débil frente a un atacante con el hash, por eso el control principal es el **bloqueo por intentos** (5 fallos → espera creciente desde 30 s) y se recomienda PIN de 6 dígitos. Los hashes SHA-256 antiguos se siguen aceptando para no dejar cajas sin acceso; deben rotarse.

## 2026-11-01 — Aislamiento entre tenants

**Decisión:** Migración 2 cambia las PK de proyecciones a `(tenant_id, id)` y todo el proyector filtra por `tenant_id`.

**Motivo:** los ids los generan los clientes (y el catálogo demo usa ids deterministas `prd_001`). Con PK global, un dispositivo de otro tenant podía anular ventas o sobrescribir productos ajenos.

## 2026-11-01 — Registro de auditoría

**Decisión:** Tabla `audit_log` sólo-inserción con encadenamiento SHA-256 (`prev_hash` → `hash`) y triggers que rechazan `UPDATE`/`DELETE`. Se alimenta desde el proyector (anulaciones, descuentos autorizados, ajustes de inventario) dentro de la misma transacción que la ingesta.

**Motivo:** los eventos ya son inmutables, pero el dueño necesita una vista legible de acciones sensibles y una forma de detectar manipulación directa en la base.

## 2026-11-01 — Facturación DIAN

**Decisión:** Interfaz `FacturacionProvider` + mock sin pretender validez legal. Documentar trámites reales en docs.

**Detalle:** el mock devuelve `validezLegal: false` y CUFE con prefijo `MOCK-`; nunca debe imprimirse como factura electrónica. Ver `docs/FACTURACION_DIAN.md`.

## 2026-11-01 — Errores de la API

**Decisión:** Filtro global con cuerpo `{ statusCode, code, message, details? }` y mensajes en español. Se mantiene `message` en la raíz porque las cajas ya lo leen.
