# Changelog de mejoras — POSInventario

Rama: `feat/mejora-produccion-ux`. Base: `feat/pos-complete-mvp` (`e547586`).
Fecha: 2026-11-01.

## Fase 1 — endurecimiento para producción

Hecha antes de esta entrega. Detalle en `docs/AUDITORIA.md` y `docs/DECISIONES.md`.

- **Caja web en IndexedDB (Dexie).** Esquema versionado, migración desde `localStorage`, `navigator.storage.persist()` y respaldo JSON (exportar / restaurar).
- **PIN con PBKDF2-SHA256** (120 000 iteraciones, sal por usuario) y bloqueo tras intentos fallidos. Los hashes SHA-256 antiguos siguen verificando.
- **`DEMO_MODE`.** En producción no se siembra la tienda demo, se rechaza `DEMO-2026`, los códigos de emparejamiento son de un solo uso con caducidad y `JWT_SECRET` debe tener al menos 32 caracteres.
- **Aislamiento por tenant.** Migración 2: clave primaria `(tenant_id, id)` en las proyecciones y filtro de tenant en el proyector.
- **Límites de intentos** en registro de dispositivos y login del dueño (`429`, mensaje en español).
- **Errores HTTP** con `{ statusCode, code, message, details? }` en español. `GET /health` sin dependencias y `GET /ready` con base y migraciones.
- **Auditoría inmutable** (`audit_log`, sólo inserción, encadenada por hash) para anulaciones, descuentos autorizados, ajustes y diferencias de caja. `GET /v1/audit`.
- **Sincronización documentada** en `docs/SYNC.md` (lotes, reintentos, stock negativo, última escritura por HLC).
- **Facturación:** interfaz `FacturacionProvider` y simulador marcado **sin validez legal** (`docs/FACTURACION_DIAN.md`).
- **Atajos** `?` y `F1` en la caja.
- **CI** con typecheck y build de las apps web, además de las pruebas.

## Fase 2 — operación de caja

- **Arqueo ciego.** En Caja, las ventas en efectivo y el efectivo esperado no se muestran hasta que el cajero registra el conteo por denominación (COP). Después se ven esperado, contado y diferencia, y hay que confirmar el cierre. Corregir el conteo vuelve a ocultar el esperado.
- **FEFO en la venta.** `allocateLots` / `allocateSaleLine` asignan cada línea al lote que vence primero. Los vencidos quedan bloqueados. La asignación viaja en `SaleCompleted.items[].lots` (opcional, compatible con ventas viejas). La proyección local, el proyector y el snapshot guardan el saldo por lote. Anular la venta devuelve esas cantidades al lote.
- **Avisos de vencimiento.** La caja lista lotes vencidos o a 7 días o menos. Al escanear o cobrar, avisa si el lote está vencido, si no alcanza la existencia del lote o si la salida es de un lote próximo a vencer. El panel del dueño muestra la misma ventana en Inventario y una alerta `near_expiry` al recibir mercancía que ya está en esa ventana.
- **Ticket térmico en el navegador.** La última venta se imprime a **58 mm** o **80 mm** (`window.print`, `@page`). El ancho se guarda en la caja y en Ajustes. Sigue siendo el diálogo del navegador: no hay ESC/POS ni apertura de cajón.
- **Panel del dueño.** Cada sección distingue carga, error con reintento y lista vacía. Al actualizar se conserva el dato anterior y se indica que está actualizando.

## Fase 3 — reportes y crecimiento

- **CSV del dueño.** `GET /v1/reports/export.csv?kind=hour|rotation|margin` descarga ventas por hora (24 filas), productos con stock y sin ventas en el rango, y margen por producto (centavos). El tablero muestra la hora y la lista corta de baja rotación, con botones de descarga.
- **Panel en el teléfono.** Por debajo de 900 px la navegación queda fija arriba, en fila, y las tablas siguen pudiendo desplazarse.
- **Promociones (esqueleto).** `quotePromotion` calcula 2x1 (`buy`/`pay`) y precio por volumen, y se queda con el mayor descuento. **No entra en el carrito ni en el evento de venta.** El precio por volumen de lista sigue en `priceLine`.
- **Android.** El indicador distingue sincronizando, error, sin conexión y la hora del último intento. El modo demo ahora carga lotes. `background-sync.ts` describe el `WorkManager` de 15 min; el proceso nativo no está enlazado, así que sólo sincroniza con la app abierta.
- **Checklist.** `docs/CHECKLIST_LANZAMIENTO.md`.

## Pendiente

- Comandos ESC/POS, cajón monedero y balanza.
- El conteo físico y los ajustes de inventario no eligen lote.
- Android no imprime ni hace arqueo. WorkManager sigue sin módulo nativo.
- `quotePromotion` no está cableado a la venta.
- Sesión del dueño no revocable, base local sin cifrar y sin telemetría de errores (Sentry).
- Una caja ya instalada en modo demo no tiene lotes hasta que se vuelve a configurar.
