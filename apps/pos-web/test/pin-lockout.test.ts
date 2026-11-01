import { describe, expect, it } from 'vitest';
import { BASE_LOCK_MS, lockRemainingMs, MAX_ATTEMPTS, MAX_LOCK_MS, registerFailure, registerSuccess, type LockoutState } from '@/lib/pin-lockout';

describe('bloqueo de PIN', () => {
  it('bloquea tras el máximo de intentos y la espera crece', () => {
    let s: LockoutState = {};
    let t = 0;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = registerFailure(s, 'user:ana', t);
      expect(r.lockedMs).toBe(0);
      s = r.state;
    }
    const first = registerFailure(s, 'user:ana', t);
    expect(first.lockedMs).toBe(BASE_LOCK_MS);
    s = first.state;
    expect(lockRemainingMs(s, 'user:ana', t + 1000)).toBe(BASE_LOCK_MS - 1000);
    expect(lockRemainingMs(s, 'user:luis', t)).toBe(0);

    t += BASE_LOCK_MS;
    expect(lockRemainingMs(s, 'user:ana', t)).toBe(0);
    for (let i = 1; i < MAX_ATTEMPTS; i++) s = registerFailure(s, 'user:ana', t).state;
    expect(registerFailure(s, 'user:ana', t).lockedMs).toBe(BASE_LOCK_MS * 2);
  });

  it('limita la espera máxima y un acierto reinicia', () => {
    let s: LockoutState = { k: { failures: MAX_ATTEMPTS - 1, lockouts: 20, lockedUntil: null } };
    expect(registerFailure(s, 'k', 0).lockedMs).toBe(MAX_LOCK_MS);
    s = registerSuccess(registerFailure(s, 'k', 0).state, 'k');
    expect(s.k).toBeUndefined();
  });
});
