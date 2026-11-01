'use client';

import { DEMO_PAIRING_CODE } from '@pos/contracts';
import { formatMoney, parseMoney } from '@pos/domain-pos';
import { uuidv7 } from '@pos/sync-engine';
import { useState } from 'react';
import { DEMO_MODE } from '@/lib/env';
import { usePos, type PinResult } from '@/lib/pos-context';
import { formatWait } from '@/lib/pin-lockout';

export function pinErrorMessage(r: Extract<PinResult, { ok: false }>): string {
  if (r.locked) return `Demasiados intentos. Espera ${formatWait(r.waitMs)} antes de volver a intentar.`;
  return `PIN incorrecto. Te quedan ${r.attemptsLeft} intento${r.attemptsLeft === 1 ? '' : 's'}.`;
}

export function SetupScreen() {
  const { setupDemo, setupServer } = usePos();
  const [apiUrl, setApiUrl] = useState(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000');
  const [code, setCode] = useState(DEMO_MODE ? DEMO_PAIRING_CODE : '');
  const [name, setName] = useState('Caja 1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      await setupServer(apiUrl, code, name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <div className="card setup">
        <h1>POS MiniMarket</h1>
        <p className="muted">Configura esta caja. Después funciona sin internet: las ventas se guardan localmente y se sincronizan al volver la conexión.</p>
        <h2>Conectar al servidor</h2>
        <label className="field"><span>URL de la API</span><input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} /></label>
        <label className="field"><span>Código de vinculación</span><input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></label>
        <label className="field"><span>Nombre de la caja</span><input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && connect()} /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy} onClick={connect}>{busy ? 'Conectando…' : 'Registrar caja y descargar catálogo'}</button>
        {DEMO_MODE && (
          <>
            <div className="divider">o</div>
            <button onClick={() => setupDemo()}>Modo demo sin servidor (sólo local)</button>
          </>
        )}
      </div>
    </div>
  );
}

export function LoginScreen() {
  const { db, login, config } = usePos();
  const users = db.getUsers();
  const [userId, setUserId] = useState(users.find((u) => u.role === 'cashier')?.id ?? users[0]?.id ?? '');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (busy) return;
    setBusy(true);
    const r = await login(userId, pin);
    setBusy(false);
    if (!r.ok) {
      setError(pinErrorMessage(r));
      setPin('');
    }
  }
  return (
    <div className="center-screen">
      <div className="card setup">
        <h1>{config?.storeName}</h1>
        <p className="muted">{config?.tenantName} · {config?.deviceName}</p>
        <label className="field">
          <span>Usuario</span>
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>PIN</span>
          <input autoFocus className="big-input" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </label>
        {error && <div className="error">{error}</div>}
        {DEMO_MODE && config?.mode === 'demo' && <p className="hint">Demo: Ana 1234 · Luis 9999 · Dueña 0000</p>}
        <button className="primary" disabled={busy} onClick={submit}>{busy ? 'Verificando…' : 'Entrar'} <kbd>Enter</kbd></button>
      </div>
    </div>
  );
}

export function OpenSessionScreen() {
  const { emit, user, db } = usePos();
  const [amount, setAmount] = useState('100.000');
  function open() {
    const cents = parseMoney(amount);
    if (cents === null || cents < 0 || !user) return;
    const sessionId = uuidv7();
    emit('CashSessionOpened', { sessionId, userId: user.id, openingCents: cents }, { sessionId });
    db.setMeta({ sessionId });
  }
  return (
    <div className="center-screen">
      <div className="card setup">
        <h1>Abrir caja</h1>
        <p className="muted">Hola {user?.name}. Ingresa la base de efectivo del turno.</p>
        <input autoFocus className="big-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && open()} />
        <p className="hint">{formatMoney(parseMoney(amount) ?? 0)}</p>
        <button className="primary" onClick={open}>Abrir turno <kbd>Enter</kbd></button>
      </div>
    </div>
  );
}
