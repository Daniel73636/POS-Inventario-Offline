# Checklist de lanzamiento — POSInventario

Lista para el primer local. Marca cada ítem en una copia de la base real, no en la demo.

## Servidor

- [ ] `NODE_ENV=production` y `DEMO_MODE=false`. La API no debe sembrar `DEMO-2026` ni aceptar ese código.
- [ ] `JWT_SECRET` de al menos 32 caracteres, distinto al de desarrollo. `DATABASE_URL` apunta a PostgreSQL del local.
- [ ] `CORS_ORIGINS` lista sólo el panel y, si aplica, el origen de la caja web.
- [ ] `GET /health` responde sin base. `GET /ready` responde con las migraciones al día (versión 2: aislamiento por tenant y `audit_log`).
- [ ] La migración 2 se probó contra una copia de la base antes de aplicarla en producción.
- [ ] Respaldo diario de PostgreSQL y prueba de restauración.
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

- [ ] Factura electrónica DIAN: el simulador **no tiene validez legal**. No se entrega al cliente como factura.
- [ ] Promociones 2x1 y por volumen (`quotePromotion`) no están conectadas a la venta. El precio por volumen de lista sí (`priceLine`).
- [ ] Sesión del dueño no se puede revocar antes de las 12 h. La base local no está cifrada. No hay Sentry.
- [ ] Ajustes de inventario no eligen lote.
