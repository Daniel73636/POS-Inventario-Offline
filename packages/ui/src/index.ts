export const colors = {
  brand: '#0f766e',
  brandDark: '#115e59',
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
  info: '#2563eb',
  ink: '#0f172a',
  muted: '#64748b',
  line: '#e2e8f0',
  surface: '#ffffff',
  background: '#f1f5f9',
  dark: {
    surface: '#111827',
    background: '#030712',
    ink: '#f8fafc',
    muted: '#94a3b8',
    line: '#1f2937',
  },
} as const;

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

export type SyncStateLike = 'idle' | 'syncing' | 'synced' | 'pending' | 'offline' | 'error' | 'revoked' | 'local';

/** Indicador de sincronización: Sincronizado | Pendiente (n) | Sin conexión. */
export function syncStatusLabel(state: SyncStateLike, pending: number): { label: string; tone: Tone } {
  switch (state) {
    case 'synced':
      return pending > 0 ? { label: `Pendiente (${pending})`, tone: 'warning' } : { label: 'Sincronizado', tone: 'success' };
    case 'pending':
      return { label: `Pendiente (${pending})`, tone: 'warning' };
    case 'syncing':
      return { label: pending > 0 ? `Sincronizando (${pending})…` : 'Sincronizando…', tone: 'info' };
    case 'offline':
      return { label: pending > 0 ? `Sin conexión · ${pending} pendientes` : 'Sin conexión', tone: 'danger' };
    case 'error':
      return { label: `Error de sincronización (${pending})`, tone: 'danger' };
    case 'revoked':
      return { label: 'Dispositivo revocado', tone: 'danger' };
    case 'local':
      return { label: pending > 0 ? `Modo demo local · ${pending} eventos` : 'Modo demo local', tone: 'muted' };
    default:
      return { label: pending > 0 ? `Pendiente (${pending})` : 'Iniciando…', tone: 'muted' };
  }
}

export function toneColor(tone: Tone): string {
  return tone === 'muted' ? colors.muted : colors[tone];
}

export function formatQty(qty: number, unit = 'unit'): string {
  const n = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 }).format(qty);
  return unit === 'unit' ? n : `${n} ${unit}`;
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

export function formatPercentBp(bp: number): string {
  return `${(bp / 100).toLocaleString('es-CO', { maximumFractionDigits: 1 })} %`;
}
