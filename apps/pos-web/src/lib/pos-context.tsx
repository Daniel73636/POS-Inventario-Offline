'use client';

import {
  DEMO_CUSTOMERS,
  DEMO_PRICE_LISTS,
  DEMO_STORE,
  DEMO_TENANT,
  DEMO_USERS,
  demoCatalog,
  pinHashInput,
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
import { LocalDb, type DeviceConfig } from './local-db';

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

type SyncView = SyncStatus & { mode: 'demo' | 'server' };

interface PosContextValue {
  db: LocalDb;
  version: number;
  config: DeviceConfig | null;
  user: User | null;
  sync: SyncView;
  online: boolean;
  emit: <K extends EventType>(type: K, payload: EventPayload<K>, meta?: { saleNumber?: number; sessionId?: string | null }) => void;
  login: (userId: string, pin: string) => Promise<boolean>;
  logout: () => void;
  verifyPin: (pin: string, minRole: 'supervisor' | 'owner') => Promise<User | null>;
  setupDemo: () => Promise<void>;
  setupServer: (apiUrl: string, pairingCode: string, deviceName: string) => Promise<void>;
  syncNow: () => Promise<void>;
  resetDevice: () => void;
}

const PosContext = createContext<PosContextValue | null>(null);

const RANK = { cashier: 0, supervisor: 1, owner: 2 } as const;

const IDLE_SYNC: SyncStatus = { state: 'idle', pending: 0, lastSyncAt: null, lastError: null, clockSkewMs: 0, clockWarning: false };

export function PosProvider({ children }: { children: ReactNode }) {
  const dbRef = useRef<LocalDb | null>(null);
  if (!dbRef.current) dbRef.current = new LocalDb();
  const db = dbRef.current;

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

  const login = useCallback(
    async (userId: string, pin: string) => {
      const u = db.getUsers().find((x) => x.id === userId);
      if (!u || !config) return false;
      const hash = await sha256Hex(pinHashInput(config.tenantId, pin));
      if (hash !== u.pinHash) return false;
      window.sessionStorage.setItem('pos:user', JSON.stringify(u));
      setUser(u);
      return true;
    },
    [db, config],
  );

  const logout = useCallback(() => {
    window.sessionStorage.removeItem('pos:user');
    setUser(null);
  }, []);

  const verifyPin = useCallback(
    async (pin: string, minRole: 'supervisor' | 'owner') => {
      if (!config) return null;
      const hash = await sha256Hex(pinHashInput(config.tenantId, pin));
      const u = db.getUsers().find((x) => x.pinHash === hash);
      return u && RANK[u.role] >= RANK[minRole] ? u : null;
    },
    [db, config],
  );

  const setupDemo = useCallback(async () => {
    const rows = demoCatalog();
    const products: Product[] = rows.map((r) => r.product);
    const state = stateFromSnapshot({
      products,
      customers: DEMO_CUSTOMERS,
      stock: rows.map((r) => ({ productId: r.product.id, qty: r.initialStock })),
    });
    const users: User[] = await Promise.all(
      DEMO_USERS.map(async (u) => ({ id: u.id, name: u.name, role: u.role, pinHash: await sha256Hex(pinHashInput(DEMO_TENANT.id, u.pin)) })),
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
    db.bootstrap(cfg, state, 0, users, DEMO_PRICE_LISTS);
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
      db.bootstrap(cfg, stateFromSnapshot(snap), snap.cursor, snap.users, snap.priceLists);
      setConfig(cfg);
      bump();
    },
    [db, bump],
  );

  const syncNow = useCallback(async () => {
    if (clientRef.current) await clientRef.current.syncNow();
    bump();
  }, [bump]);

  const resetDevice = useCallback(() => {
    clientRef.current?.stop();
    db.reset();
    window.sessionStorage.removeItem('pos:user');
    setUser(null);
    setConfig(null);
    setSyncStatus(IDLE_SYNC);
    bump();
  }, [db, bump]);

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
    }),
    [db, version, config, user, syncStatus, online, emit, login, logout, verifyPin, setupDemo, setupServer, syncNow, resetDevice],
  );

  return <PosContext.Provider value={value}>{children}</PosContext.Provider>;
}

export function usePos(): PosContextValue {
  const ctx = useContext(PosContext);
  if (!ctx) throw new Error('usePos fuera de PosProvider');
  return ctx;
}
