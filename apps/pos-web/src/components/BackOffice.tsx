'use client';

import { EVENT_LABELS, UNIT_LABELS } from '@pos/contracts';
import { cashExpected, formatMoney, parseMoney, PAYMENT_METHOD_LABELS, profitOfSale } from '@pos/domain-pos';
import { normalizeText, uuidv7 } from '@pos/sync-engine';
import { useMemo, useState } from 'react';
import { usePos } from '@/lib/pos-context';
import { SupervisorPinDialog } from './Dialogs';

export function InventoryScreen() {
  const { db, emit, user } = usePos();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [counted, setCounted] = useState('');
  const [needPin, setNeedPin] = useState<null | (() => void)>(null);
  const products = Object.values(db.state.products)
    .filter((p) => normalizeText(`${p.name} ${p.barcodes.join(' ')} ${p.category}`).includes(normalizeText(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sel = selected ? db.state.products[selected] : null;

  function receive() {
    const n = Number(qty.replace(',', '.'));
    const c = parseMoney(cost);
    if (!sel || !user || !(n > 0) || c === null) return;
    emit('StockReceived', { productId: sel.id, qty: n, unitCostCents: c, userId: user.id, supplier: null });
    setQty('');
    setCost('');
  }

  function count() {
    const n = Number(counted.replace(',', '.'));
    if (!sel || !user || !Number.isFinite(n)) return;
    const delta = n - (db.state.stock[sel.id] ?? 0);
    if (delta === 0) return;
    const run = () => {
      emit('StockAdjusted', { productId: sel.id, qty: delta, reason: 'count', countedQty: n, userId: user.id });
      setCounted('');
    };
    if (user.role === 'cashier') setNeedPin(() => run);
    else run();
  }

  return (
    <div className="backoffice">
      <div className="bo-list">
        <input className="big-input" placeholder="Buscar producto o código" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <table className="grid">
          <thead><tr><th>Producto</th><th>Código</th><th className="num">Precio</th><th className="num">Stock</th></tr></thead>
          <tbody>
            {products.map((p) => {
              const s = db.state.stock[p.id] ?? 0;
              const low = p.minStock !== null && s <= p.minStock;
              return (
                <tr key={p.id} className={selected === p.id ? 'active' : ''} onClick={() => setSelected(p.id)}>
                  <td>{p.name}<div className="muted small">{p.category}</div></td>
                  <td><code>{p.barcodes[0]}</code></td>
                  <td className="num">{formatMoney(p.priceCents)}</td>
                  <td className={`num ${s < 0 ? 'neg' : low ? 'low' : ''}`}>{s} {UNIT_LABELS[p.unit]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="bo-side card">
        {!sel ? (
          <p className="muted">Selecciona un producto para registrar entradas de mercancía o conteos físicos.</p>
        ) : (
          <>
            <h2>{sel.name}</h2>
            <p>Stock actual: <strong>{db.state.stock[sel.id] ?? 0}</strong> · Costo promedio {formatMoney(sel.costAvgCents)}</p>
            <h3>Entrada de mercancía</h3>
            <label className="field"><span>Cantidad</span><input value={qty} onChange={(e) => setQty(e.target.value)} /></label>
            <label className="field"><span>Costo unitario</span><input value={cost} placeholder={formatMoney(sel.costAvgCents)} onChange={(e) => setCost(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && receive()} /></label>
            <button className="primary" onClick={receive}>Registrar entrada</button>
            <h3>Conteo físico</h3>
            <label className="field"><span>Cantidad contada</span><input value={counted} onChange={(e) => setCounted(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && count()} /></label>
            <button onClick={count}>Ajustar al conteo (requiere supervisor)</button>
          </>
        )}
      </div>
      {needPin && (
        <SupervisorPinDialog reason="Los ajustes de inventario requieren supervisor." minRole="supervisor" onOk={() => { needPin(); setNeedPin(null); }} onClose={() => setNeedPin(null)} />
      )}
    </div>
  );
}

export function CashScreen() {
  const { db, emit, user, logout } = usePos();
  const sessionId = db.meta.sessionId;
  const session = sessionId ? db.state.cashSessions[sessionId] : null;
  const [kind, setKind] = useState<'in' | 'out'>('out');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [counted, setCounted] = useState('');

  const sales = Object.values(db.state.sales).filter((s) => s.cashSessionId === sessionId && s.status === 'completed');
  const calc = useMemo(
    () =>
      cashExpected({
        openingCents: session?.openingCents ?? 0,
        salePayments: sales.flatMap((s) => s.payments),
        movements: session?.movements ?? [],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, sales.length],
  );
  if (!session || !user) return <p className="muted pad">No hay turno abierto.</p>;

  function movement() {
    const c = parseMoney(amount);
    if (!c || c <= 0 || !reason.trim() || !user || !sessionId) return;
    emit('CashMovement', { sessionId, movementId: uuidv7(), kind, amountCents: c, reason: reason.trim(), userId: user.id });
    setAmount('');
    setReason('');
  }

  function close() {
    const c = parseMoney(counted);
    if (c === null || !user || !sessionId) return;
    const diff = c - calc.expectedCents;
    if (!confirm(`Cerrar turno. Esperado ${formatMoney(calc.expectedCents)}, contado ${formatMoney(c)}, diferencia ${formatMoney(diff)}. ¿Confirmar?`)) return;
    emit('CashSessionClosed', { sessionId, userId: user.id, countedCents: c, expectedCents: calc.expectedCents, differenceCents: diff }, { sessionId: null });
    db.setMeta({ sessionId: null });
    logout();
  }

  return (
    <div className="backoffice">
      <div className="card">
        <h2>Turno actual</h2>
        <p className="muted">Abierto {new Date(session.openedAt).toLocaleString('es-CO')} · {sales.length} ventas</p>
        <table className="grid">
          <tbody>
            <tr><td>Base inicial</td><td className="num">{formatMoney(session.openingCents)}</td></tr>
            {Object.entries(calc.byMethod).map(([m, v]) => (
              <tr key={m}><td>Ventas {PAYMENT_METHOD_LABELS[m as keyof typeof PAYMENT_METHOD_LABELS]}</td><td className="num">{formatMoney(v)}</td></tr>
            ))}
            <tr><td>Ingresos</td><td className="num">{formatMoney(calc.inCents)}</td></tr>
            <tr><td>Retiros</td><td className="num">−{formatMoney(calc.outCents)}</td></tr>
            <tr className="strong"><td>Efectivo esperado</td><td className="num">{formatMoney(calc.expectedCents)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Ingreso / retiro de efectivo</h3>
        <div className="seg">
          <button className={kind === 'out' ? 'active' : ''} onClick={() => setKind('out')}>Retiro</button>
          <button className={kind === 'in' ? 'active' : ''} onClick={() => setKind('in')}>Ingreso</button>
        </div>
        <label className="field"><span>Monto</span><input value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field"><span>Motivo</span><input value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && movement()} /></label>
        <button onClick={movement}>Registrar movimiento</button>
        <ul className="plain">
          {session.movements.map((m) => <li key={m.id}>{m.kind === 'in' ? '+' : '−'}{formatMoney(m.amountCents)} · {m.reason}</li>)}
        </ul>
        <h3>Cierre de caja</h3>
        <label className="field"><span>Efectivo contado</span><input value={counted} onChange={(e) => setCounted(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && close()} /></label>
        {parseMoney(counted) !== null && (
          <p>Diferencia: <strong className={(parseMoney(counted) ?? 0) - calc.expectedCents === 0 ? 'ok' : 'neg'}>{formatMoney((parseMoney(counted) ?? 0) - calc.expectedCents)}</strong></p>
        )}
        <button className="primary" onClick={close}>Cerrar turno</button>
      </div>
    </div>
  );
}

export function SalesScreen() {
  const { db, emit, user } = usePos();
  const [voiding, setVoiding] = useState<string | null>(null);
  const sales = Object.values(db.state.sales)
    .filter((s) => s.deviceId === db.getConfig()?.deviceId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 100);
  const day = new Date().toISOString().slice(0, 10);
  const today = sales.filter((s) => s.status === 'completed' && s.occurredAt.slice(0, 10) === day);
  const profit = profitOfSale({ items: today.flatMap((s) => s.items) });
  return (
    <div className="pad">
      <div className="kpis">
        <div className="kpi"><span>Ventas hoy</span><strong>{today.length}</strong></div>
        <div className="kpi"><span>Total hoy</span><strong>{formatMoney(today.reduce((s, x) => s + x.totalCents, 0))}</strong></div>
        <div className="kpi"><span>Utilidad estimada</span><strong>{formatMoney(profit.profitCents)}</strong></div>
      </div>
      <table className="grid">
        <thead><tr><th>#</th><th>Hora</th><th>Artículos</th><th>Pago</th><th className="num">Total</th><th>Estado</th><th /></tr></thead>
        <tbody>
          {sales.map((s) => (
            <tr key={s.id}>
              <td>{s.localNumber}</td>
              <td>{new Date(s.occurredAt).toLocaleString('es-CO')}</td>
              <td>{s.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</td>
              <td>{s.payments.map((p) => PAYMENT_METHOD_LABELS[p.method]).join(' + ')}</td>
              <td className="num">{formatMoney(s.totalCents)}</td>
              <td>{s.status === 'voided' ? <span className="tag neg">Anulada</span> : 'OK'}</td>
              <td>{s.status === 'completed' && <button className="ghost" onClick={() => setVoiding(s.id)}>Anular</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {voiding && user && (
        <SupervisorPinDialog
          reason="Anular la venta devuelve los productos al inventario. Requiere supervisor."
          minRole="supervisor"
          onOk={(sup) => {
            const reason = prompt('Motivo de la anulación', 'Error del cajero') || 'Sin motivo';
            emit('SaleVoided', { saleId: voiding, reason, userId: user.id, authorizedBy: sup.id });
            setVoiding(null);
          }}
          onClose={() => setVoiding(null)}
        />
      )}
    </div>
  );
}

export function SettingsScreen() {
  const { db, config, sync, syncNow, resetDevice } = usePos();
  const events = db.allEvents();
  return (
    <div className="backoffice">
      <div className="card">
        <h2>Dispositivo</h2>
        <table className="grid">
          <tbody>
            <tr><td>Modo</td><td>{config?.mode === 'server' ? 'Conectado a servidor' : 'Demo local (sin servidor)'}</td></tr>
            <tr><td>API</td><td>{config?.apiUrl ?? '—'}</td></tr>
            <tr><td>ID dispositivo</td><td><code>{config?.deviceId}</code></td></tr>
            <tr><td>Tienda</td><td>{config?.tenantName} · {config?.storeName}</td></tr>
            <tr><td>Último seq local</td><td>{db.meta.lastSeq}</td></tr>
            <tr><td>Eventos pendientes</td><td>{sync.pending}</td></tr>
            <tr><td>Última sincronización</td><td>{sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString('es-CO') : '—'}</td></tr>
            <tr><td>Desfase de reloj</td><td>{Math.round(sync.clockSkewMs / 1000)} s {sync.clockWarning && <span className="tag neg">Revisar hora del equipo</span>}</td></tr>
          </tbody>
        </table>
        <div className="row-gap">
          <button disabled={config?.mode !== 'server'} onClick={() => syncNow()}>Sincronizar ahora</button>
          <button className="danger" onClick={() => { if (confirm(sync.pending ? `Hay ${sync.pending} eventos sin subir que se perderán. ¿Restablecer?` : '¿Restablecer esta caja?')) resetDevice(); }}>Restablecer caja</button>
        </div>
      </div>
      <div className="card">
        <h2>Registro de eventos (últimos 30)</h2>
        <table className="grid small">
          <thead><tr><th>seq</th><th>Tipo</th><th>HLC</th><th>Estado</th></tr></thead>
          <tbody>
            {events.slice(-30).reverse().map((s) => (
              <tr key={s.event.id}>
                <td>{s.event.seq}</td>
                <td>{EVENT_LABELS[s.event.type]}</td>
                <td><code>{s.event.hlc.slice(0, 21)}</code></td>
                <td>{s.rejected ? <span className="tag neg" title={s.rejected}>Rechazado</span> : s.syncedAt ? 'Sincronizado' : 'Pendiente'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
