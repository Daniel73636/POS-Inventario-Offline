'use client';

import { EVENT_LABELS, UNIT_LABELS } from '@pos/contracts';
import { COP_DENOMINATIONS, cashExpected, countDenominations, formatMoney, parseMoney, PAYMENT_METHOD_LABELS, profitOfSale } from '@pos/domain-pos';
import { listNearExpiry, normalizeText, productLots, uuidv7 } from '@pos/sync-engine';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SCHEMA_VERSION } from '@/lib/local-db';
import { usePos } from '@/lib/pos-context';
import { applyTicketWidth, readTicketWidth, type TicketWidth } from '@/lib/ticket';
import { SupervisorPinDialog } from './Dialogs';

export function InventoryScreen() {
  const { db, emit, user } = usePos();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [counted, setCounted] = useState('');
  const [lotCode, setLotCode] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [needPin, setNeedPin] = useState<null | (() => void)>(null);
  const today = new Date().toISOString().slice(0, 10);
  const expiring = listNearExpiry(db.state, today);
  const products = Object.values(db.state.products)
    .filter((p) => normalizeText(`${p.name} ${p.barcodes.join(' ')} ${p.category}`).includes(normalizeText(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sel = selected ? db.state.products[selected] : null;

  function receive() {
    const n = Number(qty.replace(',', '.'));
    const c = parseMoney(cost);
    if (!sel || !user || !(n > 0) || c === null) return;
    const lot = sel.tracksLots ? (lotCode.trim() || (expiresOn ? `vence-${expiresOn}` : null)) : null;
    emit('StockReceived', {
      productId: sel.id,
      qty: n,
      unitCostCents: c,
      userId: user.id,
      supplier: null,
      lotCode: lot,
      expiresOn: sel.tracksLots && expiresOn ? expiresOn : null,
    });
    setQty('');
    setCost('');
    setLotCode('');
    setExpiresOn('');
    setNote(sel.tracksLots && !expiresOn ? 'Entrada sin fecha de vencimiento: no participa del orden FEFO.' : null);
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
        {expiring.length > 0 && (
          <div className="expiry-banner" role="status">
            <strong>Por vencer o vencido</strong>
            <ul>
              {expiring.slice(0, 6).map((l) => (
                <li key={`${l.productId}:${l.lotId}`}>{l.productName} · {l.lotId} · {l.qty} · {l.daysLeft < 0 ? `venció ${l.expiresOn}` : `vence ${l.expiresOn}`}</li>
              ))}
            </ul>
          </div>
        )}
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
            {sel.tracksLots && (
              <ul className="plain">
                {productLots(db.state, sel.id).filter((l) => l.qty > 0).map((l) => (
                  <li key={l.id}>{l.id} · {l.qty} · {l.expiresOn ?? 'sin vencimiento'}</li>
                ))}
                {productLots(db.state, sel.id).every((l) => !(l.qty > 0)) && <li className="muted">Sin lotes con existencia.</li>}
              </ul>
            )}
            <h3>Entrada de mercancía</h3>
            <label className="field"><span>Cantidad</span><input value={qty} onChange={(e) => setQty(e.target.value)} /></label>
            <label className="field"><span>Costo unitario</span><input value={cost} placeholder={formatMoney(sel.costAvgCents)} onChange={(e) => setCost(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && receive()} /></label>
            {sel.tracksLots && (
              <>
                <label className="field"><span>Código de lote</span><input value={lotCode} onChange={(e) => setLotCode(e.target.value)} /></label>
                <label className="field"><span>Vencimiento</span><input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} /></label>
              </>
            )}
            <button className="primary" onClick={receive}>Registrar entrada</button>
            {note && <p className="hint">{note}</p>}
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
  const [denoms, setDenoms] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState(false);
  const [submittedCents, setSubmittedCents] = useState<number | null>(null);

  const sales = Object.values(db.state.sales).filter((s) => s.cashSessionId === sessionId && s.status === 'completed');
  const calc = useMemo(
    () =>
      cashExpected({
        openingCents: session?.openingCents ?? 0,
        salePayments: sales.flatMap((s) => s.payments),
        movements: session?.movements ?? [],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, sales.length, revealed],
  );
  const countedCents = countDenominations(Object.fromEntries(Object.entries(denoms).map(([den, n]) => [den, Number(n) || 0])));
  if (!session || !user) return <p className="muted pad">No hay turno abierto.</p>;

  function movement() {
    const c = parseMoney(amount);
    if (!c || c <= 0 || !reason.trim() || !user || !sessionId) return;
    emit('CashMovement', { sessionId, movementId: uuidv7(), kind, amountCents: c, reason: reason.trim(), userId: user.id });
    setAmount('');
    setReason('');
  }

  function submitCount() {
    setSubmittedCents(countedCents);
    setRevealed(true);
  }

  function correctCount() {
    setRevealed(false);
    setSubmittedCents(null);
  }

  function close() {
    if (submittedCents === null || !revealed || !user || !sessionId) return;
    const diff = submittedCents - calc.expectedCents;
    if (!confirm(`Cerrar turno. Esperado ${formatMoney(calc.expectedCents)}, contado ${formatMoney(submittedCents)}, diferencia ${formatMoney(diff)}. ¿Confirmar?`)) return;
    emit('CashSessionClosed', { sessionId, userId: user.id, countedCents: submittedCents, expectedCents: calc.expectedCents, differenceCents: diff }, { sessionId: null });
    db.setMeta({ sessionId: null });
    logout();
  }

  const diff = submittedCents === null ? 0 : submittedCents - calc.expectedCents;
  const otherMethods = (Object.entries(calc.byMethod) as Array<[keyof typeof PAYMENT_METHOD_LABELS, number]>).filter(([m]) => m !== 'cash');

  return (
    <div className="backoffice">
      <div className="card">
        <h2>Turno actual</h2>
        <p className="muted">Abierto {new Date(session.openedAt).toLocaleString('es-CO')} · {sales.length} ventas</p>
        {!revealed ? (
          <>
            <p className="hint">Arqueo ciego: el efectivo esperado permanece oculto hasta registrar el conteo.</p>
            <table className="grid">
              <tbody>
                {otherMethods.map(([m, v]) => (
                  <tr key={m}><td>Ventas {PAYMENT_METHOD_LABELS[m]}</td><td className="num">{formatMoney(v)}</td></tr>
                ))}
                <tr><td>Ventas en efectivo</td><td className="num">Oculto</td></tr>
                <tr className="strong"><td>Efectivo esperado</td><td className="num">Oculto</td></tr>
              </tbody>
            </table>
          </>
        ) : (
          <table className="grid">
            <tbody>
              <tr><td>Base inicial</td><td className="num">{formatMoney(session.openingCents)}</td></tr>
              {Object.entries(calc.byMethod).map(([m, v]) => (
                <tr key={m}><td>Ventas {PAYMENT_METHOD_LABELS[m as keyof typeof PAYMENT_METHOD_LABELS]}</td><td className="num">{formatMoney(v)}</td></tr>
              ))}
              <tr><td>Ingresos</td><td className="num">{formatMoney(calc.inCents)}</td></tr>
              <tr><td>Retiros</td><td className="num">−{formatMoney(calc.outCents)}</td></tr>
              <tr className="strong"><td>Efectivo esperado</td><td className="num">{formatMoney(calc.expectedCents)}</td></tr>
              <tr><td>Efectivo contado</td><td className="num">{formatMoney(submittedCents ?? 0)}</td></tr>
              <tr><td>Diferencia</td><td className={`num ${diff === 0 ? 'ok' : 'neg'}`}>{formatMoney(diff)}</td></tr>
            </tbody>
          </table>
        )}
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
          {session.movements.length === 0 && <li className="muted">Sin movimientos en el turno.</li>}
        </ul>
        <h3>Conteo ciego</h3>
        <p className="hint">Cantidad de cada denominación. El total contado no se compara con el sistema hasta registrarlo.</p>
        <div className="denoms">
          {COP_DENOMINATIONS.map((den) => (
            <label key={den} className="field">
              <span>{formatMoney(den)}</span>
              <input
                inputMode="numeric"
                disabled={revealed}
                value={denoms[String(den)] ?? ''}
                onChange={(e) => setDenoms((d) => ({ ...d, [String(den)]: e.target.value.replace(/\D/g, '') }))}
              />
            </label>
          ))}
        </div>
        <p>Total contado: <strong>{formatMoney(revealed ? submittedCents ?? 0 : countedCents)}</strong></p>
        {!revealed ? (
          <button className="primary" onClick={submitCount}>Registrar conteo</button>
        ) : (
          <div className="row-gap">
            <button onClick={correctCount}>Corregir conteo</button>
            <button className="primary" onClick={close}>Confirmar cierre</button>
          </div>
        )}
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

function BackupCard() {
  const { db, sync, restoreBackup } = usePos();
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function exportBackup() {
    const backup = await db.exportBackup();
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `respaldo-caja-${backup.config?.deviceName ?? 'pos'}-${backup.exportedAt.slice(0, 10)}.json`.replace(/\s+/g, '-');
    a.click();
    URL.revokeObjectURL(url);
    setMessage({ tone: 'ok', text: `Respaldo descargado (${backup.events.length} eventos).` });
  }

  async function importBackup(file: File) {
    try {
      const data = JSON.parse(await file.text()) as unknown;
      const warn = sync.pending ? ` Hay ${sync.pending} eventos sin subir en esta caja que se reemplazarán.` : '';
      if (!confirm(`¿Restaurar el respaldo "${file.name}"? Se reemplazan todos los datos locales.${warn}`)) return;
      await restoreBackup(data);
      setMessage({ tone: 'ok', text: 'Respaldo restaurado. Vuelve a iniciar sesión.' });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="card">
      <h2>Base local y respaldo</h2>
      <table className="grid">
        <tbody>
          <tr><td>Motor</td><td>IndexedDB (esquema v{SCHEMA_VERSION})</td></tr>
          <tr>
            <td>Almacenamiento persistente</td>
            <td>{db.persisted === null ? 'No soportado por el navegador' : db.persisted ? 'Concedido' : <span className="tag neg">No concedido: el navegador podría borrar datos si falta espacio</span>}</td>
          </tr>
          {db.writeError && <tr><td>Último error de escritura</td><td className="neg">{db.writeError}</td></tr>}
        </tbody>
      </table>
      <p className="hint">El respaldo incluye la credencial de la caja: guárdalo en un lugar seguro y no lo compartas.</p>
      <div className="row-gap">
        <button onClick={() => void exportBackup()}>Descargar respaldo (JSON)</button>
        <button onClick={() => fileRef.current?.click()}>Restaurar respaldo…</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importBackup(f); }} />
      </div>
      {message && <div className={message.tone === 'ok' ? 'ok' : 'error'}>{message.text}</div>}
    </div>
  );
}

export function SettingsScreen() {
  const { db, config, sync, syncNow, resetDevice } = usePos();
  const events = db.allEvents();
  const [ticketMm, setTicketMm] = useState<TicketWidth>(80);
  useEffect(() => setTicketMm(readTicketWidth()), []);
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
          <button className="danger" onClick={() => { if (confirm(sync.pending ? `Hay ${sync.pending} eventos sin subir que se perderán. ¿Restablecer?` : '¿Restablecer esta caja?')) void resetDevice(); }}>Restablecer caja</button>
        </div>
        <h3>Ticket térmico</h3>
        <p className="hint">La última venta se imprime por el diálogo del navegador, a 58 mm o 80 mm. No envía comandos ESC/POS ni abre el cajón.</p>
        <div className="seg">
          <button className={ticketMm === 58 ? 'active' : ''} onClick={() => { setTicketMm(58); applyTicketWidth(58); }}>58 mm</button>
          <button className={ticketMm === 80 ? 'active' : ''} onClick={() => { setTicketMm(80); applyTicketWidth(80); }}>80 mm</button>
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
      <BackupCard />
    </div>
  );
}
