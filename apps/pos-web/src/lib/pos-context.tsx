'use client';

import {
  DEMO_CUSTOMERS,
  DEMO_PRICE_LISTS,
  DEMO_STORE,
  DEMO_TENANT,
  DEMO_USERS,
  demoCatalog,
  hashPinPbkdf2,
  verifyPinHash,
  type EventPayload,
  type EventType,
  type Product,
  type RegisterDeviceResponse,
  type SnapshotResponse,
  type User,
} from '@pos/contracts';
import {
  EventFactory,
  HybridLogicalClock,
  stateFromSnapshot,
  SyncClient,
  uuidv7,
  type SyncStatus,
} from '@pos/sync-engine';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEMO_MODE } from './env';
import { LocalDb, type DeviceConfig } from './local-db';
import { lockRemainingMs, MAX_ATTEMPTS, registerFailure, registerSuccess, type LockoutState } from './pin-lockout';

type SyncView = SyncStatus & { mode: 'demo' | 'server' };

export type PinResult =
  | { ok: true; user: User }
  | { ok: false; locked: boolean; waitMs: number; attemptsLeft: number };

interface PosContextValue {
  db: LocalDb;
  version: number;
  config: DeviceConfig | null;
  user: User | null;
  sync: SyncView;
  online: boolean;
  emit: <K extends EventType>(type: K, payload: EventPayload<K>, meta?: { saleNumber?: number; sessionId?: string | null }) => void;
  login: (userId: string, pin: string) => Promise<PinResult>;
  logout: () => void;
  verifyPin: (pin: string, minRole: 'supervisor' | 'owner') => Promise<PinResult>;
  setupDemo: () => Promise<void>;
  setupServer: (apiUrl: string, pairingCode: string, deviceName: string) => Promise<void>;
  syncNow: () => Promise<void>;
  resetDevice: () => Promise<void>;
  restoreBackup: (file: unknown) => Promise<void>;
}

const PosContext = createContext<PosContextValue | null>(null);

const RANK = { cashier: 0, supervisor: 1, owner: 2 } as const;

const IDLE_SYNC: SyncStatus = { state: 'idle', pending: 0, lastSyncAt: null, lastError: null, clockSkewMs: 0, clockWarning: false };

/** Abre IndexedDB (migrando localStorage si hace falta) antes de montar la caja. */
export function PosProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<LocalDb | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    LocalDb.open()
      .then(async (opened) => {
        await opened.requestPersistence();
        if (!cancelled) setDb(opened);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, []);
  if (error) {
    return (
      <div className="center-screen">
        <div className="card setup">
          <h1>No se pudo abrir la base local</h1>
          <p className="error">{error}</p>
          <p className="muted">Revisa que el navegador permita almacenamiento (no uses modo incógnito) y recarga la página.</p>
        </div>
      </div>
    );
  }
  if (!db) return <div className="center-screen"><p className="muted">Abriendo base local…</p></div>;
  return <PosProviderReady db={db}>{children}</PosProviderReady>;
}

function PosProviderReady({ db, children }: { db: LocalDb; children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [config, setConfig] = useState<DeviceConfig | null>(() => db.getConfig());
  const [user, setUser] = useState<User | null>(() => {
    const raw = typeof window !== 'undefined' ? window.sessionStorage.getItem('pos:user') : null;
    return raw ? (JSON.parse(raw) as User) : null;
  });
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(IDLE_SYNC);
  const [online, setOnline] = useState(true);

  const clockRef = useRef<HybridLogicalClock | null>(null);
  const factoryRef = useRef<EventFactory | null>(null);
  const clientRef = useRef<SyncClient | null>(null);

  useEffect(() => db.onWriteError(() => bump()), [db, bump]);

  // Reloj, fábrica de eventos y cliente de sincronización por dispositivo.
  useEffect(() => {
    clientRef.current?.stop();
    clientRef.current = null;
    if (!config) return;
    const clock = new HybridLogicalClock(config.deviceId, () => Date.now(), db.meta.lastHlc);
    clockRef.current = clock;
    factoryRef.current = new EventFactory(
      { tenantId: config.tenantId, storeId: config.storeId, deviceId: config.deviceId },
      clock,
      db.meta.lastSeq,
    );
    if (config.mode === 'server' && config.apiUrl) {
      const client = new SyncClient({
        baseUrl: config.apiUrl,
        deviceId: config.deviceId,
        getToken: () => config.deviceToken,
        store: db,
        clock,
        intervalMs: 15000,
      });
      clientRef.current = client;
      const unsub = client.subscribe((s) => {
        setSyncStatus(s);
        bump();
      });
      client.start();
      return () => {
        unsub();
        client.stop();
      };
    }
    void db.countPending().then((pending) => setSyncStatus({ ...IDLE_SYNC, pending }));
  }, [config, db, bump]);

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) clientRef.current?.nudge(0);
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const emit = useCallback<PosContextValue['emit']>(
    (type, payload, meta) => {
      const factory = factoryRef.current;
      if (!factory) throw new Error('Dispositivo no configurado');
      const event = factory.create(type, payload);
      db.record(event, meta ?? {});
      bump();
      if (clientRef.current) {
        void clientRef.current.refreshPending();
        clientRef.current.nudge(800);
      } else {
        void db.countPending().then((pending) => setSyncStatus((s) => ({ ...s, pending })));
      }
    },
    [db, bump],
  );

  /** Verifica un PIN contra candidatos aplicando el bloqueo por intentos de la clave dada. */
  const checkPin = useCallback(
    async (key: string, pin: string, candidates: User[]): Promise<PinResult> => {
      if (!config) return { ok: false, locked: false, waitMs: 0, attemptsLeft: 0 };
      const now = Date.now();
      const lock = db.getSecurity<LockoutState>() ?? {};
      const wait = lockRemainingMs(lock, key, now);
      if (wait > 0) return { ok: false, locked: true, waitMs: wait, attemptsLeft: 0 };
      for (const u of candidates) {
        if (await verifyPinHash(u.pinHash, config.tenantId, pin)) {
          db.setSecurity(registerSuccess(lock, key));
          return { ok: true, user: u };
        }
      }
      const { state, lockedMs } = registerFailure(lock, key, now);
      db.setSecurity(state);
      db.appendAudit({ type: lockedMs ? 'pin_locked' : 'pin_failed', userId: key.startsWith('user:') ? key.slice(5) : null, detail: key });
      return { ok: false, locked: lockedMs > 0, waitMs: lockedMs, attemptsLeft: lockedMs ? 0 : MAX_ATTEMPTS - (state[key]?.failures ?? 0) };
    },
    [db, config],
  );

  const login = useCallback(
    async (userId: string, pin: string) => {
      const u = db.getUsers().find((x) => x.id === userId);
      const r = await checkPin(`user:${userId}`, pin, u ? [u] : []);
      if (r.ok) {
        window.sessionStorage.setItem('pos:user', JSON.stringify(r.user));
        setUser(r.user);
        db.appendAudit({ type: 'login', userId: r.user.id, detail: '' });
      }
      return r;
    },
    [db, checkPin],
  );

  const logout = useCallback(() => {
    window.sessionStorage.removeItem('pos:user');
    setUser(null);
  }, []);

  const verifyPin = useCallback(
    async (pin: string, minRole: 'supervisor' | 'owner') => {
      const candidates = db.getUsers().filter((u) => RANK[u.role] >= RANK[minRole]);
      const r = await checkPin('supervisor', pin, candidates);
      if (r.ok) db.appendAudit({ type: 'supervisor_authorized', userId: r.user.id, detail: `rol mínimo ${minRole}` });
      return r;
    },
    [db, checkPin],
  );

  const setupDemo = useCallback(async () => {
    if (!DEMO_MODE) throw new Error('El modo demo está deshabilitado en esta instalación');
    const rows = demoCatalog();
    const products: Product[] = rows.map((r) => r.product);
    const state = stateFromSnapshot({
      products,
      customers: DEMO_CUSTOMERS,
      stock: rows.map((r) => ({ productId: r.product.id, qty: r.initialStock })),
      lots: rows
        .filter((r) => r.expiresOn && r.product.tracksLots)
        .map((r) => ({ productId: r.product.id, lotId: `L-${r.product.sku}`, qty: r.initialStock, expiresOn: r.expiresOn })),
    });
    const users: User[] = await Promise.all(
      DEMO_USERS.map(async (u) => ({ id: u.id, name: u.name, role: u.role, pinHash: await hashPinPbkdf2(DEMO_TENANT.id, u.pin) })),
    );
    const cfg: DeviceConfig = {
      mode: 'demo',
      apiUrl: null,
      deviceId: `web-demo-${uuidv7().slice(-12)}`,
      deviceToken: null,
      deviceName: 'Caja demo',
      tenantId: DEMO_TENANT.id,
      tenantName: DEMO_TENANT.name,
      storeId: DEMO_STORE.id,
      storeName: DEMO_STORE.name,
    };
    await db.bootstrap(cfg, state, 0, users, DEMO_PRICE_LISTS);
    setConfig(cfg);
    bump();
  }, [db, bump]);

  const setupServer = useCallback(
    async (apiUrl: string, pairingCode: string, deviceName: string) => {
      const base = apiUrl.replace(/\/$/, '');
      const reg = await fetch(`${base}/v1/devices/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode, name: deviceName, platform: 'web' }),
      });
      if (!reg.ok) {
        const body = (await reg.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `Error ${reg.status} al registrar`);
      }
      const r = (await reg.json()) as RegisterDeviceResponse;
      const snapRes = await fetch(`${base}/v1/sync/snapshot`, { headers: { authorization: `Bearer ${r.deviceToken}` } });
      if (!snapRes.ok) throw new Error('No se pudo descargar el catálogo');
      const snap = (await snapRes.json()) as SnapshotResponse;
      const cfg: DeviceConfig = {
        mode: 'server',
        apiUrl: base,
        deviceId: r.deviceId,
        deviceToken: r.deviceToken,
        deviceName,
        tenantId: r.tenantId,
        tenantName: r.tenantName,
        storeId: r.storeId,
        storeName: r.storeName,
      };
      await db.bootstrap(cfg, stateFromSnapshot(snap), snap.cursor, snap.users, snap.priceLists);
      setConfig(cfg);
      bump();
    },
    [db, bump],
  );

  const syncNow = useCallback(async () => {
    if (clientRef.current) await clientRef.current.syncNow();
    bump();
  }, [bump]);

  const resetDevice = useCallback(async () => {
    clientRef.current?.stop();
    await db.reset();
    window.sessionStorage.removeItem('pos:user');
    setUser(null);
    setConfig(null);
    setSyncStatus(IDLE_SYNC);
    bump();
  }, [db, bump]);

  const restoreBackup = useCallback(
    async (file: unknown) => {
      clientRef.current?.stop();
      await db.importBackup(file);
      window.sessionStorage.removeItem('pos:user');
      setUser(null);
      setConfig(db.getConfig());
      bump();
    },
    [db, bump],
  );

  const value = useMemo<PosContextValue>(
    () => ({
      db,
      version,
      config,
      user,
      sync: { ...syncStatus, mode: config?.mode ?? 'demo' },
      online,
      emit,
      login,
      logout,
      verifyPin,
      setupDemo,
      setupServer,
      syncNow,
      resetDevice,
      restoreBackup,
    }),
    [db, version, config, user, syncStatus, online, emit, login, logout, verifyPin, setupDemo, setupServer, syncNow, resetDevice, restoreBackup],
  );

  return <PosContext.Provider value={value}>{children}</PosContext.Provider>;
}

export function usePos(): PosContextValue {
  const ctx = useContext(PosContext);
  if (!ctx) throw new Error('usePos fuera de PosProvider');
  return ctx;
}
