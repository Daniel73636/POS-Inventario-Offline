/**
 * Reloj lógico híbrido (HLC). Formato ordenable lexicográficamente:
 *   "<millis 15 dígitos>:<contador 5 dígitos>:<nodo>"
 * Permite reconstruir el orden causal sin confiar en la hora del equipo.
 */
export interface HlcParts {
  millis: number;
  counter: number;
  node: string;
}

const MAX_COUNTER = 99999;

export function formatHlc(p: HlcParts): string {
  return `${String(p.millis).padStart(15, '0')}:${String(p.counter).padStart(5, '0')}:${p.node}`;
}

export function parseHlc(value: string): HlcParts {
  const first = value.indexOf(':');
  const second = value.indexOf(':', first + 1);
  if (first !== 15 || second !== 21) throw new Error(`HLC inválido: ${value}`);
  return {
    millis: Number(value.slice(0, first)),
    counter: Number(value.slice(first + 1, second)),
    node: value.slice(second + 1),
  };
}

export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class HybridLogicalClock {
  private millis = 0;
  private counter = 0;

  constructor(
    readonly node: string,
    private readonly physicalNow: () => number = () => Date.now(),
    last?: string | null,
  ) {
    if (last) {
      const p = parseHlc(last);
      this.millis = p.millis;
      this.counter = p.counter;
    }
  }

  /** Marca para un evento local. */
  now(): string {
    const pt = this.physicalNow();
    if (pt > this.millis) {
      this.millis = pt;
      this.counter = 0;
    } else {
      this.bump();
    }
    return this.current();
  }

  /** Fusiona una marca remota (al recibir eventos de otros dispositivos). */
  receive(remote: string): string {
    const r = parseHlc(remote);
    const pt = this.physicalNow();
    const max = Math.max(this.millis, r.millis, pt);
    if (max === this.millis && max === r.millis) {
      this.counter = Math.max(this.counter, r.counter) + 1;
    } else if (max === this.millis) {
      this.counter += 1;
    } else if (max === r.millis) {
      this.counter = r.counter + 1;
    } else {
      this.counter = 0;
    }
    this.millis = max;
    if (this.counter > MAX_COUNTER) this.bump();
    return this.current();
  }

  current(): string {
    return formatHlc({ millis: this.millis, counter: this.counter, node: this.node });
  }

  private bump(): void {
    this.counter += 1;
    if (this.counter > MAX_COUNTER) {
      this.millis += 1;
      this.counter = 0;
    }
  }
}
