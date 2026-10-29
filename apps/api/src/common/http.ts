import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { ZodType, ZodTypeDef } from 'zod';

export function parseBody<T>(schema: ZodType<T, ZodTypeDef, unknown>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({
      message: 'Datos inválidos',
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export interface DeviceAuth {
  id: string;
  tenantId: string;
  storeId: string;
  name: string;
}

export interface OwnerAuth {
  ownerId: string;
  tenantId: string;
  email: string;
}

export type AuthedRequest = FastifyRequest & { device?: DeviceAuth; owner?: OwnerAuth };
