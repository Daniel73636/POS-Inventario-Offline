# Sincronización y política de conflictos

La caja **nunca espera a la red para vender**. Cada acción se guarda primero como evento inmutable en la
base local y se sube después. Este documento fija las reglas que el servidor y las cajas aplican igual.

## Modelo

| Elemento | Regla |
|---|---|
| Evento | `id` (UUIDv7) + `deviceId` + `seq` local monotónico + `hlc` (reloj lógico híbrido) + `occurredAt` |
| Unicidad | `(device_id, seq)` único en el servidor. Reenviar un evento ya aceptado devuelve `duplicates`, nunca lo duplica |
| Cursor | `server_seq` por tenant, asignado con la fila del tenant bloqueada: avanza en orden de commit y un *pull* nunca se salta eventos |
| Credencial | El evento debe coincidir en `deviceId`, `tenantId` y `storeId` con el token; si no, se rechaza ese evento y el resto del lote sigue |
| Proyecciones | Todas las tablas derivadas llevan `tenant_id` en la clave primaria; el proyector filtra por el tenant del evento |

## Ciclo del cliente (`SyncClient`)

1. **Push**: pendientes ordenados por `seq`, en lotes de hasta 200 (`MAX_PUSH_BATCH`), repitiendo mientras haya.
2. **Pull**: eventos de otros dispositivos desde el cursor, en páginas de hasta 500.
3. Disparadores: sondeo cada 15–20 s, 0,8 s después de cada venta (`nudge`) y al recuperar la conexión (`online`).
4. **Reintentos**: tras un fallo la espera es exponencial `2 s · 2^(fallos−1)` con tope de 120 s y *jitter* del 50–100 %, para que varias cajas no reintenten a la vez al volver internet.
5. Llamadas concurrentes comparten la misma ejecución (no hay dos ciclos simultáneos).
6. La caja web espera a que el evento sea durable en IndexedDB antes de subirlo.

## Estados visibles en la caja

| Indicador | Significado |
|---|---|
| **Sincronizado** | No hay pendientes y el último ciclo fue exitoso |
| **Pendiente (n)** | Hay `n` eventos locales sin confirmar por el servidor |
| **Sincronizando…** | Ciclo en curso |
| **Sin conexión · Pendiente (n)** | El navegador está sin red o el servidor no responde; se sigue vendiendo |
| **Error de sincronización** | El servidor respondió con error (≠ 401/403); se reintenta con *backoff* |
| **Dispositivo revocado** | 401/403: el dueño revocó la caja. Se detiene la sincronización; los datos locales se conservan para exportar respaldo |
| ⚠ **Hora del equipo desfasada** | El reloj local difiere más de 5 min del servidor (las ventas siguen; los reportes usan la hora del evento) |

## Política de conflictos

| Dato | Regla | Ejemplo |
|---|---|---|
| Ventas, anulaciones, movimientos de caja | **Sólo añadir.** Nunca se rechaza una venta ya hecha | Dos cajas sin red venden lo mismo: ambas ventas existen |
| Inventario | **Suma de movimientos** (`stock = Σ qty`). No hay "último valor" | Quedaba 1 unidad, dos cajas la venden offline → stock **−1** |
| Stock negativo | Se acepta y genera alerta `negative_stock` para el dueño | El dueño revisa: conteo físico o venta mal registrada |
| Catálogo y clientes | **Última escritura gana por HLC** (`updated_hlc`), por fila | Precio cambiado en el panel y en una caja: queda el de HLC mayor |
| Precio distinto al vigente | La venta conserva el precio y costo **congelados** en el evento; se genera alerta `price_diff` | Caja offline vendió con el precio de ayer |
| Código de barras repetido | Se reasigna al producto más reciente y se genera alerta `barcode_conflict` | Dos cajas crean productos con el mismo EAN |
| Anulación | Sólo cambia una venta `completed` del mismo tenant; devuelve el stock y queda en `audit_log` | Anular dos veces no duplica la devolución |
| Cierre de caja | Sólo lo aplica el dispositivo que abrió el turno; diferencia ≠ 0 genera alerta y entrada de auditoría | |
| Costo promedio | Se recalcula en el servidor al recibir entradas; las cajas pueden diferir levemente hasta el próximo snapshot | Reportes de utilidad usan el costo congelado en cada venta |

Las alertas se ven y resuelven en el panel del dueño (**Alertas**). Las acciones sensibles se ven en
`GET /v1/audit` y la integridad de la cadena se comprueba con `GET /v1/audit/verify`.

## Durabilidad local

- **Caja web:** IndexedDB (Dexie) con `navigator.storage.persist()`. Evento + meta en una transacción;
  la proyección se reconstruye desde los eventos si no alcanzó a guardarse. Respaldo JSON desde **Ajustes**.
- **Android:** SQLite; evento y proyección en la misma transacción.

## Pruebas que respaldan estas reglas

- `packages/sync-engine/test`: idempotencia, última unidad (−1), LWW y simulación de 5 cajas × 40 semillas con desconexiones, respuestas perdidas y duplicados.
- `apps/pos-web/test/local-db.test.ts`: 250 eventos sincronizados en lotes desde IndexedDB, reenvío idempotente.
- `apps/api/test/security.e2e.test.ts`: aislamiento entre tenants, revocación, auditoría.
