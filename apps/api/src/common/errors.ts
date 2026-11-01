import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Cuerpo de error común: las cajas leen `message`; `code` es estable para programas. */
export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

const DEFAULTS: Record<number, { code: string; message: string }> = {
  400: { code: 'datos_invalidos', message: 'Datos inválidos' },
  401: { code: 'no_autenticado', message: 'Credencial inválida o ausente' },
  403: { code: 'prohibido', message: 'No tienes permiso para esta acción' },
  404: { code: 'no_encontrado', message: 'Recurso no encontrado' },
  405: { code: 'metodo_no_permitido', message: 'Método no permitido' },
  409: { code: 'conflicto', message: 'El recurso entra en conflicto con otro existente' },
  413: { code: 'demasiado_grande', message: 'La petición es demasiado grande' },
  415: { code: 'tipo_no_soportado', message: 'Tipo de contenido no soportado' },
  429: { code: 'demasiados_intentos', message: 'Demasiados intentos; espera un momento' },
  500: { code: 'error_interno', message: 'Error interno del servidor' },
  503: { code: 'no_disponible', message: 'Servicio no disponible' },
};

/** Mensajes en inglés que producen Nest/Fastify por defecto. */
function isFrameworkMessage(msg: string): boolean {
  return /^(Cannot (GET|POST|PUT|DELETE|PATCH)|Not Found|Unauthorized|Forbidden|Bad Request|Internal server error|Too Many Requests|Conflict|Body cannot be empty|Unsupported Media Type|Request body is too large)/i.test(msg);
}

export function toErrorBody(status: number, response: unknown): ApiErrorBody {
  const def = DEFAULTS[status] ?? (status >= 500 ? DEFAULTS[500] : { code: 'error', message: 'No se pudo completar la petición' });
  const r = (typeof response === 'string' ? { message: response } : (response ?? {})) as Record<string, unknown>;
  const raw = Array.isArray(r.message) ? r.message.join('; ') : typeof r.message === 'string' ? r.message : '';
  const message = raw && !isFrameworkMessage(raw) ? raw : def.message;
  const { message: _m, statusCode: _s, error: _e, code, ...rest } = r;
  const details = Object.keys(rest).length ? rest : undefined;
  return { statusCode: status, code: typeof code === 'string' ? code : def.code, message, ...(details ? { details } : {}) };
}

@Catch()
export class SpanishErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('API');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();
    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let response: unknown = null;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      response = exception.getResponse();
    } else if (typeof (exception as { statusCode?: unknown })?.statusCode === 'number') {
      // Errores de Fastify (cuerpo JSON mal formado, límite de tamaño...).
      status = (exception as { statusCode: number }).statusCode;
    }
    if (status >= 500) {
      this.logger.error(`${req.method} ${req.url}: ${exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)}`);
    }
    const body = toErrorBody(status, response);
    if (status === 429 && body.details && typeof (body.details as { retryAfterSeconds?: number }).retryAfterSeconds === 'number') {
      void reply.header('retry-after', String((body.details as { retryAfterSeconds: number }).retryAfterSeconds));
    }
    void reply.status(status).send(body);
  }
}
