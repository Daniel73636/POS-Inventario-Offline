'use client';

import { useEffect, useState } from 'react';
import { PosProvider, usePos } from '@/lib/pos-context';
import { CashScreen, InventoryScreen, SalesScreen, SettingsScreen } from './BackOffice';
import { SaleScreen } from './SaleScreen';
import { isHelpKey, ShortcutsHelp } from './ShortcutsHelp';
import { LoginScreen, OpenSessionScreen, SetupScreen } from './Setup';

type Tab = 'venta' | 'inventario' | 'caja' | 'ventas' | 'ajustes';

const TABS: Array<{ id: Tab; label: string; key: string }> = [
  { id: 'venta', label: 'Venta', key: 'Alt+1' },
  { id: 'inventario', label: 'Inventario', key: 'Alt+2' },
  { id: 'caja', label: 'Caja', key: 'Alt+3' },
  { id: 'ventas', label: 'Ventas', key: 'Alt+4' },
  { id: 'ajustes', label: 'Ajustes', key: 'Alt+5' },
];

function SyncIndicator() {
  const { sync, online, config, syncNow } = usePos();
  let label: string;
  let tone: string;
  if (config?.mode === 'demo') {
    label = `Modo demo local · ${sync.pending} eventos`;
    tone = 'muted';
  } else if (!online || sync.state === 'offline') {
    label = `Sin conexión${sync.pending ? ` · Pendiente (${sync.pending})` : ''}`;
    tone = 'offline';
  } else if (sync.state === 'revoked') {
    label = 'Dispositivo revocado';
    tone = 'offline';
  } else if (sync.state === 'error') {
    label = `Error de sincronización · Pendiente (${sync.pending})`;
    tone = 'offline';
  } else if (sync.pending > 0) {
    label = `Pendiente (${sync.pending})`;
    tone = 'pending';
  } else if (sync.state === 'syncing') {
    label = 'Sincronizando…';
    tone = 'pending';
  } else {
    label = 'Sincronizado';
    tone = 'ok';
  }
  return (
    <button className={`sync ${tone}`} onClick={() => syncNow()} title={sync.lastError ?? 'Sincronizar ahora'} data-testid="sync-status">
      <span className="dot" /> {label}
    </button>
  );
}

function Shell() {
  const { config, user, db, logout, online, sync } = usePos();
  const [tab, setTab] = useState<Tab>('venta');
  const [dark, setDark] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('pos:theme') === 'dark';
    setDark(saved);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('pos:theme', dark ? 'dark' : 'light');
  }, [dark]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        setTab(TABS[Number(e.key) - 1].id);
      } else if (isHelpKey(e)) {
        e.preventDefault();
        setHelp(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!config) return <SetupScreen />;
  if (!user) return <LoginScreen />;
  const session = db.meta.sessionId ? db.state.cashSessions[db.meta.sessionId] : null;
  if (!session || session.closedAt) return <OpenSessionScreen />;

  return (
    <div className="app">
      <nav className="topbar">
        <strong className="brand">{config.storeName}</strong>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)} title={t.key}>
            {t.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="ghost" onClick={() => setHelp(true)} aria-label="Atajos de teclado" title="Atajos de teclado (? o F1)">?</button>
        <button className="ghost" onClick={() => setDark((d) => !d)} aria-label="Cambiar tema">{dark ? '☀' : '☾'}</button>
      </nav>
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      <main className="main">
        {tab === 'venta' && <SaleScreen />}
        {tab === 'inventario' && <InventoryScreen />}
        {tab === 'caja' && <CashScreen />}
        {tab === 'ventas' && <SalesScreen />}
        {tab === 'ajustes' && <SettingsScreen />}
      </main>
      <footer className="statusbar">
        <span>👤 {user.name} ({user.role === 'cashier' ? 'cajero' : user.role === 'supervisor' ? 'supervisor' : 'dueña'})</span>
        <span>Turno desde {new Date(session.openedAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}</span>
        <span>🖨 Impresora: navegador</span>
        <span className={online ? 'ok' : 'neg'}>{online ? '● En línea' : '● Sin red'}</span>
        {sync.clockWarning && <span className="neg">⚠ Hora del equipo desfasada</span>}
        <SyncIndicator />
        <button className="ghost" onClick={logout}>Salir</button>
      </footer>
    </div>
  );
}

export default function PosApp() {
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);
  return (
    <PosProvider>
      <Shell />
    </PosProvider>
  );
}
