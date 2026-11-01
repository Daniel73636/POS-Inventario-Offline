/**
 * Bloqueo por intentos fallidos de PIN (por clave: usuario o "supervisor").
 * Tras MAX_ATTEMPTS fallos seguidos se bloquea con espera creciente:
 * 30 s, 60 s, 120 s… hasta 15 min. Un acierto reinicia el contador.
 */
export const MAX_ATTEMPTS = 5;
export const BASE_LOCK_MS = 30_000;
export const MAX_LOCK_MS = 15 * 60_000;

export interface LockoutEntry {
  failures: number;
  lockouts: number;
  lockedUntil: number | null;
}

export type LockoutState = Record<string, LockoutEntry>;

const EMPTY: LockoutEntry = { failures: 0, lockouts: 0, lockedUntil: null };

export function lockRemainingMs(state: LockoutState, key: string, now: number): number {
  const until = state[key]?.lockedUntil;
  return until && until > now ? until - now : 0;
}

export function registerFailure(state: LockoutState, key: string, now: number): { state: LockoutState; lockedMs: number } {
  const prev = state[key] ?? EMPTY;
  const failures = prev.failures + 1;
  if (failures < MAX_ATTEMPTS) return { state: { ...state, [key]: { ...prev, failures, lockedUntil: null } }, lockedMs: 0 };
  const lockouts = prev.lockouts + 1;
  const lockedMs = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (lockouts - 1));
  return { state: { ...state, [key]: { failures: 0, lockouts, lockedUntil: now + lockedMs } }, lockedMs };
}

export function registerSuccess(state: LockoutState, key: string): LockoutState {
  if (!state[key]) return state;
  const next = { ...state };
  delete next[key];
  return next;
}

export function formatWait(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`;
}
