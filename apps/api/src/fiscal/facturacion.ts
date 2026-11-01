import { createHash } from 'node:crypto';

/**
 * Adaptador de facturación electrónica (DIAN, Colombia).
 * La implementación real debe ser un proveedor tecnológico autorizado o el
 * software propio habilitado ante la DIAN: ver docs/FACTURACION_DIAN.md.
 */
export const FACTURACION = Symbol('FACTURACION');

export interface ResolucionNumeracion {
  prefijo: string;
  numeroResolucion: string;
  desde: number;
  hasta: number;
  vigenteHasta: string;
}

export interface DocumentoVenta {
  saleId: string;
  numero: number;
  fechaEmision: string;
  cliente: { documento: string | null; nombre: string } | null;
  subtotalCents: number;
  impuestosCents: number;
  totalCents: number;
  lineas: Array<{ descripcion: string; cantidad: number; valorUnitarioCents: number; tarifaImpuestoBp: number; totalCents: number }>;
}

export type EstadoFacturacion = 'aceptada' | 'rechazada' | 'pendiente';

export interface ResultadoFacturacion {
  proveedor: string;
  estado: EstadoFacturacion;
  numero: string;
  /** Código Único de Factura Electrónica. En el mock lleva prefijo MOCK- y no es un CUFE real. */
  cufe: string | null;
  /** Sólo un proveedor habilitado ante la DIAN puede devolver `true`. */
  validezLegal: boolean;
  mensajes: string[];
}

export interface FacturacionProvider {
  readonly nombre: string;
  readonly validezLegal: boolean;
  resolucion(tenantId: string): Promise<ResolucionNumeracion>;
  emitirFactura(tenantId: string, doc: DocumentoVenta): Promise<ResultadoFacturacion>;
  emitirNotaCredito(tenantId: string, facturaNumero: string, motivo: string): Promise<ResultadoFacturacion>;
}

export const AVISO_SIN_VALIDEZ = 'Documento de prueba generado por un simulador: NO es una factura electrónica y no tiene validez ante la DIAN.';

/** Simulador para desarrollo y pruebas. Nunca debe usarse para documentos que se entreguen a clientes como factura. */
export class MockFacturacionProvider implements FacturacionProvider {
  readonly nombre = 'simulador-local';
  readonly validezLegal = false;

  async resolucion(): Promise<ResolucionNumeracion> {
    return {
      prefijo: 'PRUE',
      numeroResolucion: 'SIMULADA-SIN-VALIDEZ',
      desde: 1,
      hasta: 999_999,
      vigenteHasta: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
    };
  }

  async emitirFactura(tenantId: string, doc: DocumentoVenta): Promise<ResultadoFacturacion> {
    const errores = validarDocumento(doc);
    const numero = `PRUE${doc.numero}`;
    if (errores.length) return { proveedor: this.nombre, estado: 'rechazada', numero, cufe: null, validezLegal: false, mensajes: errores };
    const digest = createHash('sha384').update(`${tenantId}|${doc.saleId}|${numero}|${doc.fechaEmision}|${doc.totalCents}`).digest('hex');
    return { proveedor: this.nombre, estado: 'aceptada', numero, cufe: `MOCK-${digest.slice(0, 48)}`, validezLegal: false, mensajes: [AVISO_SIN_VALIDEZ] };
  }

  async emitirNotaCredito(_tenantId: string, facturaNumero: string, motivo: string): Promise<ResultadoFacturacion> {
    return { proveedor: this.nombre, estado: 'aceptada', numero: `NC-${facturaNumero}`, cufe: null, validezLegal: false, mensajes: [AVISO_SIN_VALIDEZ, `Motivo: ${motivo}`] };
  }
}

/** Validaciones de consistencia previas a enviar a cualquier proveedor. */
export function validarDocumento(doc: DocumentoVenta): string[] {
  const errores: string[] = [];
  if (!doc.lineas.length) errores.push('La factura no tiene líneas');
  const suma = doc.lineas.reduce((s, l) => s + l.totalCents, 0);
  if (suma !== doc.totalCents) errores.push(`La suma de líneas (${suma}) no coincide con el total (${doc.totalCents})`);
  if (doc.subtotalCents + doc.impuestosCents !== doc.totalCents) errores.push('Subtotal + impuestos no coincide con el total');
  if (doc.totalCents <= 0) errores.push('El total debe ser mayor que cero');
  return errores;
}
