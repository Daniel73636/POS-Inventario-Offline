# Facturación electrónica DIAN (Colombia)

> **Estado actual: simulador sin validez legal.** POS Inventario **no** emite hoy facturas electrónicas
> ni documentos equivalentes válidos ante la DIAN. El recibo que imprime la caja es un comprobante
> interno. No lo entregues como factura.

Esta guía resume lo que falta para operar legalmente. No es asesoría tributaria: valida cada punto con
tu contador y con la normativa vigente publicada por la DIAN (la regulación cambia con frecuencia).

## Qué hay en el código

| Pieza | Ubicación | Qué hace |
|---|---|---|
| `FacturacionProvider` | `apps/api/src/fiscal/facturacion.ts` | Interfaz: `resolucion`, `emitirFactura`, `emitirNotaCredito` |
| `MockFacturacionProvider` | mismo archivo | Simulador. Siempre `validezLegal: false`, CUFE con prefijo `MOCK-`, resolución `SIMULADA-SIN-VALIDEZ` |
| `validarDocumento` | mismo archivo | Consistencia previa: líneas suman el total, subtotal + impuestos = total |
| `POST /v1/fiscal/ranges` | `sync.controller.ts` | Reserva rangos de numeración por caja (el servidor evita solapes) |
| `POST /v1/fiscal/documents` | `sync.controller.ts` | Envía una venta sincronizada al proveedor configurado |

Para cambiar de proveedor se registra otra implementación en `AppModule` bajo el token `FACTURACION`.
Una implementación real **sólo** puede devolver `validezLegal: true` cuando el proveedor confirme la
validación previa de la DIAN.

## Pasos para operar en producción (resumen)

1. **RUT actualizado** con la responsabilidad de facturador electrónico.
2. **Elegir modalidad:** proveedor tecnológico autorizado (recomendado para un POS pequeño) o software propio habilitado.
3. **Habilitación** en el portal de la DIAN y set de pruebas superado.
4. **Resolución de numeración** (prefijo y rango autorizados, con vigencia). El rango se reparte entre cajas con `/v1/fiscal/ranges`.
5. **Firma digital** (certificado) — la gestiona normalmente el proveedor tecnológico.
6. **Documento equivalente POS electrónico / factura electrónica** según el caso del negocio y los topes vigentes.
7. **Notas crédito** para anulaciones y devoluciones de documentos ya validados (hoy la anulación sólo es un evento interno).
8. **Representación gráfica** con CUFE/CUDE y código QR en el ticket.
9. **Contingencia:** procedimiento cuando no hay internet (la caja vende offline; el envío al proveedor debe hacerse dentro del plazo que fije la norma).

## Pendiente en el producto

- Proveedor real (adaptador HTTP con reintentos e idempotencia por `saleId`).
- Persistir el resultado (`cufe`, estado, XML/PDF) por venta y mostrarlo en el panel.
- Nota crédito automática al anular una venta ya validada.
- Ticket con QR y leyendas obligatorias.
- Cola de envío y alertas por documentos rechazados o vencidos.
