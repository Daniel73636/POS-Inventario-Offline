# Checklist de lanzamiento — POSInventario

Lista para el primer local. Marca cada ítem en una copia de la base real, no en la demo.
Los valores de ejemplo viven en `.env.example`. En producción no copies el `JWT_SECRET` de desarrollo: tiene menos de 32 caracteres a propósito.

## Pasos manuales (Daniel)

Hazlos en este orden, en una máquina que no sea la caja del local todavía.

1. **Respaldo antes de la migración 2.** Si la base ya tiene datos:
   ```bash
   pg_dump --format=custom --file=pos-antes-migracion-2.dump "$DATABASE_URL"
   pg_restore --list pos-antes-migracion-2.dump
   ```
   Guarda el archivo fuera del servidor. No arranques la API nueva contra esa base hasta tener el dump.
2. **Entorno de producción** (archivo `.env` del servidor, no el del repo):
   ```bash
   NODE_ENV=production
   DEMO_MODE=false
   SEED_DEMO=false
   DATABASE_URL=postgres://USUARIO:CLAVE@HOST:5432/pos
   JWT_SECRET=$(openssl rand -base64 48)
   CORS_ORIGINS=https://panel.tudominio,https://caja.tudominio
   BUSINESS_TZ=America/Bogota
   ```
   `JWT_SECRET` debe ser distinto del de desarrollo y de al menos 32 caracteres. Anótalo en el gestor de secretos, no en el chat ni en el README.
3. **Arranque.** `pnpm --filter @pos/api start`. Tiene que fallar si falta `DATABASE_URL`, si `JWT_SECRET` es corto o si `CORS_ORIGINS=*`.
4. **Comprobar que la demo está apagada.** `POST /v1/devices/register` con `DEMO-2026` debe responder error. `GET /health` en 200. `GET /ready` en 200 y `schemaVersion` 2 (`aislamiento_tenant_y_auditoria`).
5. **Vinculación.** Entra al panel con el dueño real (no `dueno@minimarket.demo`). Dispositivos → generar código. Úsalo una vez en la caja antes de 24 h. No reutilices `DEMO-2026`.
6. **DIAN, cuentas aparte del código.** El producto no tiene variables de proveedor: sigue en el simulador (`validezLegal: false`). Antes de cobrar con factura:
   - RUT con responsabilidad de facturador electrónico.
   - Cuenta en un proveedor tecnológico autorizado (o software propio habilitado).
   - Habilitación y set de pruebas en el portal DIAN.
   - Resolución de numeración y certificado de firma, normalmente los da el proveedor.
   - Recién entonces se reemplaza `MockFacturacionProvider` en `AppModule`. Hasta eso, el ticket es documento interno. Guía: `docs/FACTURACION_DIAN.md`.
7. **Restauración de prueba.** Restaura el dump del paso 1 en una base vacía de ensayo y confirma que abre. El respaldo diario del local repite ese `pg_dump`.

## Servidor

- [ ] `NODE_ENV=production` y `DEMO_MODE=false`. La API no siembra `DEMO-2026` ni acepta ese código.
- [ ] `JWT_SECRET` de al menos 32 caracteres, generado con `openssl rand -base64 48`, distinto al de desarrollo. `DATABASE_URL` apunta a PostgreSQL del local.
- [ ] `CORS_ORIGINS` lista sólo el panel y, si aplica, el origen de la caja web. No uses `*`.
- [ ] `GET /health` responde sin base. `GET /ready` responde con las migraciones al día (versión 2: aislamiento por tenant y `audit_log`).
- [ ] El dump del paso 1 existe y se probó `pg_restore --list` antes de migrar.
- [ ] Respaldo diario de PostgreSQL y una restauración de prueba al mes.
- [ ] Reloj del servidor en `America/Bogota` (o la zona configurada). Los reportes agrupan por esa zona.

## Dueño y cajas

- [ ] Contraseña del dueño cambiada. Los PIN de cajero y supervisor no son `1234` / `0000`. Quien aún tenga hash SHA-256 debe entrar una vez y rotar el PIN (el sistema no puede re-hashearlo solo).
- [ ] Códigos de vinculación de un solo uso, caducidad 24 h. No se comparte el respaldo JSON: incluye el token de la caja.
- [ ] Cada caja pidió almacenamiento persistente del navegador (Ajustes → Base local). Hay una copia JSON fuera del equipo.
- [ ] El cajero practicó el arqueo ciego: el esperado no se ve hasta registrar el conteo por denominación.
- [ ] Impresión del ticket a 58 mm u 80 mm desde el diálogo del navegador. No hay ESC/POS ni cajón.
- [ ] Productos con vencimiento tienen lote y fecha en la entrada. La venta descuenta por FEFO. Una caja demo vieja hay que reconfigurarla para que traiga lotes.

## Reportes

- [ ] El panel abre en el teléfono: la barra de secciones queda arriba y las tablas se desplazan de lado.
- [ ] CSV de ventas por hora, baja rotación (stock sin ventas en el rango) y margen descargan y abren en Excel. Importes en centavos.
- [ ] Las alertas de stock negativo, diferencia de caja y por vencer tienen dueño que las resuelve.

## Android

- [ ] El celular muestra estado (sincronizado, pendiente, sin conexión, error) y la hora del último intento.
- [ ] Se entiende que **no hay WorkManager**: si se cierra la app, los eventos esperan en SQLite hasta volver a abrirla. El contrato del trabajo periódico está en `apps/pos-android/src/background-sync.ts`.
- [ ] La venta móvil asigna lotes, pero no imprime ni hace arqueo.

## Fuera de este lanzamiento

- [ ] Factura electrónica DIAN: el simulador **no tiene validez legal**. No se entrega al cliente como factura. Las cuentas del proveedor y de la DIAN son el paso 6 de arriba; no hay `.env` de proveedor todavía.
- [ ] El 2×1 de la caja PC se aplica sólo si el cajero lo marca en la línea. No hay catálogo de promociones ni el precio por volumen de `quotePromotion` en la venta (el de lista sigue en `priceLine`). Android no tiene el botón 2×1.
- [ ] Sesión del dueño no se puede revocar antes de las 12 h. La base local no está cifrada. No hay Sentry.
- [ ] Ajustes de inventario no eligen lote.
