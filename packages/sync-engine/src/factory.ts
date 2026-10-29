import type { EventPayload, EventType, PosEventOf } from '@pos/contracts';
import type { HybridLogicalClock } from './hlc';
import { uuidv7 } from './uuid';

export interface DeviceContext {
  tenantId: string;
  storeId: string;
  deviceId: string;
}

/**
 * Crea eventos inmutables con device_id + seq local monotónico + HLC.
 * La app debe persistir el evento en la misma transacción que sus proyecciones.
 */
export class EventFactory {
  constructor(
    private readonly ctx: DeviceContext,
    private readonly clock: HybridLogicalClock,
    private seq: number = 0,
  ) {}

  get lastSeq(): number {
    return this.seq;
  }

  create<K extends EventType>(type: K, payload: EventPayload<K>, now: Date = new Date()): PosEventOf<K> {
    this.seq += 1;
    return {
      id: uuidv7(now.getTime()),
      tenantId: this.ctx.tenantId,
      storeId: this.ctx.storeId,
      deviceId: this.ctx.deviceId,
      seq: this.seq,
      hlc: this.clock.now(),
      type,
      payload,
      occurredAt: now.toISOString(),
    } as PosEventOf<K>;
  }
}
