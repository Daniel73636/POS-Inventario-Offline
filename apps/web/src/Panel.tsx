'use client';

import { DEMO_OWNER, type Product } from '@pos/contracts';
import { formatMoney, parseMoney, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@pos/domain-pos';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, API_URL } from './api';

type Section = 'dashboard' | 'productos' | 'inventario' | 'clientes' | 'caja' | 'dispositivos' | 'alertas';

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'dashboard', label: 'Tablero' },
  { id: 'productos', label: 'Productos' },
  { id: 'inventario', label: 'Inventario' },
  { id: 'clientes', label: 'Clientes' },
  { id: 'caja', label: 'Cierres de caja' },
  { id: 'dispositivos', label: 'Dispositivos' },
  { id: 'alertas', label: 'Alertas' },
];

function useData<T>(path: string, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api<T>(path)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  return { data, error, loading, reload: useCallback(() => setN((x) => x + 1), []) };
}

function State({ error, loading, empty, emptyText = 'No hay datos para mostrar.', onRetry }: { error: string | null; loading: boolean; empty?: boolean; emptyText?: string; onRetry?: () => void }) {
  if (loading) return <p className="muted">Cargando…</p>;
  if (error) {
    return (
      <p className="error">
        {error} {onRetry && <button onClick={onRetry}>Reintentar</button>}
      </p>
    );
  }
  if (empty) return <p className="muted empty">{emptyText}</p>;
  return null;
}

function Kpi({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Login({ onLogged }: { onLogged: (name: string) => void }) {
  const [email, setEmail] = useState<string>(DEMO_OWNER.email);
  const [password, setPassword] = useState<string>(DEMO_OWNER.password);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ token: string; owner: { name: string }; tenant: { name: string } }>('/v1/auth/login', { method: 'POST', body: { email, password } });
      const label = `${r.owner.name} · ${r.tenant.name}`;
      localStorage.setItem('panel:token', r.token);
      localStorage.setItem('panel:name', label);
      onLogged(label);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>Panel del dueño</h1>
        <p className="muted">API: {API_URL}</p>
        <label>Correo<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Contraseña<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary">Entrar</button>
        <p className="muted small">Demo: {DEMO_OWNER.email} / {DEMO_OWNER.password}</p>
      </form>
    </div>
  );
}

interface DashboardReport {
  sales: number;
  totalCents: number;
  avgTicketCents: number;
  profitCents: number;
  marginBp: number;
  byMethod: Array<{ method: PaymentMethod; amountCents: number }>;
  topProducts: Array<{ productId: string; name: string; qty: number; totalCents: number }>;
  inventory: { negative: number; low: number };
  openAlerts: number;
  devices: { online: number; total: number };
}
interface SalesReport {
  days: Array<{ day: string; sales: number; totalCents: number; voided: number }>;
}
interface ProfitReport {
  revenueCents: number;
  costCents: number;
  profitCents: number;
  products: Array<{ productId: string; name: string; qty: number; revenueCents: number; costCents: number; profitCents: number; belowCost: boolean }>;
}
interface InventoryReport {
  items: Array<{ productId: string; name: string; category: string; qty: number; minStock: number | null; costAvgCents: number; priceCents: number; costValueCents: number; status: 'ok' | 'low' | 'negative' }>;
  costValueCents: number;
  retailValueCents: number;
  expiring?: Array<{ productId: string; name: string; lotCode: string | null; expiresOn: string; qty: number; daysLeft: number }>;
}
interface SaleRow {
  id: string;
  local_number: number;
  device_name: string | null;
  status: string;
  total_cents: number;
  occurred_at: string;
  methods: string | null;
  customer_name: string | null;
}

const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA');

function Dashboard() {
  const [from, setFrom] = useState(isoDay(-6));
  const [to, setTo] = useState(isoDay());
  const q = `?from=${from}&to=${to}`;
  const dash = useData<DashboardReport>(`/v1/reports/dashboard${q}`);
  const sales = useData<SalesReport>(`/v1/reports/sales${q}`);
  const profit = useData<ProfitReport>(`/v1/reports/profit${q}`);
  const inv = useData<InventoryReport>('/v1/reports/inventory');
  const recent = useData<SaleRow[]>(`/v1/sales${q}`);
  const max = Math.max(1, ...(sales.data?.days.map((d) => d.totalCents) ?? [1]));
  const d = dash.data;
  return (
    <>
      <div className="toolbar">
        <label>Desde <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>Hasta <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button onClick={() => { dash.reload(); sales.reload(); profit.reload(); inv.reload(); recent.reload(); }}>Actualizar</button>
      </div>
      <State error={dash.error} loading={dash.loading && !d} onRetry={dash.reload} />
      {dash.loading && d && <p className="muted small">Actualizando…</p>}
      {d && (
        <div className="kpis">
          <Kpi label="Ventas" value={d.sales} />
          <Kpi label="Total vendido" value={formatMoney(d.totalCents)} />
          <Kpi label="Ticket promedio" value={formatMoney(d.avgTicketCents)} />
          <Kpi label="Utilidad real (costos congelados)" value={formatMoney(d.profitCents)} tone="ok" />
          <Kpi label="Margen" value={`${(d.marginBp / 100).toFixed(1)} %`} />
          <Kpi label="Valor inventario (costo)" value={inv.data ? formatMoney(inv.data.costValueCents) : '…'} />
          <Kpi label="Bajo mínimo / negativos" value={`${d.inventory.low} / ${d.inventory.negative}`} tone={d.inventory.negative ? 'neg' : ''} />
          <Kpi label="Cajas en línea" value={`${d.devices.online} / ${d.devices.total}`} />
          <Kpi label="Alertas abiertas" value={d.openAlerts} tone={d.openAlerts ? 'warn' : ''} />
        </div>
      )}
      <div className="cols">
        <section className="card">
          <h2>Ventas por día</h2>
          <div className="bars">
            {sales.data?.days.map((x) => (
              <div key={x.day} className="bar-row">
                <span>{x.day.slice(5)}</span>
                <div className="bar" style={{ width: `${(x.totalCents / max) * 100}%` }} />
                <strong>{formatMoney(x.totalCents)}</strong>
              </div>
            ))}
            {sales.loading && !sales.data && <p className="muted">Cargando…</p>}
            {sales.error && <State error={sales.error} loading={false} onRetry={sales.reload} />}
            {!sales.loading && sales.data?.days.length === 0 && <p className="muted">Sin ventas en el rango.</p>}
          </div>
          <h3>Por medio de pago</h3>
          <table>
            <tbody>
              {d?.byMethod.map((m) => (
                <tr key={m.method}><td>{PAYMENT_METHOD_LABELS[m.method] ?? m.method}</td><td className="num">{formatMoney(m.amountCents)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>Utilidad por producto</h2>
          <table>
            <thead><tr><th>Producto</th><th className="num">Unid.</th><th className="num">Ingreso</th><th className="num">Utilidad</th></tr></thead>
            <tbody>
              {profit.loading && !profit.data && <tr><td colSpan={4} className="muted">Cargando…</td></tr>}
              {profit.error && <tr><td colSpan={4}><State error={profit.error} loading={false} onRetry={profit.reload} /></td></tr>}
              {!profit.loading && profit.data?.products.length === 0 && <tr><td colSpan={4} className="muted">Sin utilidad en el rango.</td></tr>}
              {profit.data?.products.slice(0, 10).map((p) => (
                <tr key={p.productId}>
                  <td>{p.name}{p.belowCost && <span className="tag neg">bajo costo</span>}</td>
                  <td className="num">{Math.round(p.qty * 100) / 100}</td>
                  <td className="num">{formatMoney(p.revenueCents)}</td>
                  <td className={`num ${p.profitCents < 0 ? 'neg' : 'ok'}`}>{formatMoney(p.profitCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      <section className="card">
        <h2>Ventas (todas las cajas)</h2>
        <table>
          <thead><tr><th>#</th><th>Fecha</th><th>Caja</th><th>Cliente</th><th>Pago</th><th>Estado</th><th className="num">Total</th></tr></thead>
          <tbody>
            {recent.loading && !recent.data && <tr><td colSpan={7} className="muted">Cargando…</td></tr>}
            {recent.error && <tr><td colSpan={7}><State error={recent.error} loading={false} onRetry={recent.reload} /></td></tr>}
            {!recent.loading && recent.data?.length === 0 && <tr><td colSpan={7} className="muted">Sin ventas en el rango.</td></tr>}
            {recent.data?.slice(0, 30).map((s) => (
              <tr key={s.id}>
                <td>{s.local_number}</td>
                <td>{new Date(s.occurred_at).toLocaleString('es-CO')}</td>
                <td>{s.device_name}</td>
                <td>{s.customer_name ?? '—'}</td>
                <td>{s.methods?.split(',').map((m) => PAYMENT_METHOD_LABELS[m as PaymentMethod] ?? m).join(' + ')}</td>
                <td>{s.status === 'voided' ? <span className="tag neg">Anulada</span> : 'Completada'}</td>
                <td className="num">{formatMoney(Number(s.total_cents))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

type ProductRow = Product & { stock: number };

function Products() {
  const { data, error, loading, reload } = useData<ProductRow[]>('/v1/products');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [price, setPrice] = useState('');
  const [name, setName] = useState('');
  const [recvQty, setRecvQty] = useState('');
  const [recvCost, setRecvCost] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  function open(p: ProductRow) {
    setEditing(p);
    setPrice(String(p.priceCents / 100));
    setName(p.name);
    setRecvQty('');
    setRecvCost(String(p.costAvgCents / 100));
    setMsg(null);
  }

  async function save() {
    if (!editing) return;
    const cents = parseMoney(price);
    if (cents === null) return setMsg('Precio inválido');
    try {
      await api(`/v1/products/${editing.id}`, { method: 'PUT', body: { name, priceCents: cents } });
      setMsg('Guardado. Las cajas lo recibirán en la próxima sincronización.');
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function toggleActive(p: ProductRow) {
    await api(`/v1/products/${p.id}`, { method: 'PUT', body: { active: !p.active } });
    reload();
  }

  async function receive() {
    if (!editing) return;
    const qty = Number(recvQty.replace(',', '.'));
    const cost = parseMoney(recvCost);
    if (!(qty > 0) || cost === null) return setMsg('Cantidad o costo inválido');
    await api('/v1/inventory/receipts', { method: 'POST', body: { productId: editing.id, qty, unitCostCents: cost, supplier: 'Panel web' } });
    setMsg(`Entrada de ${qty} registrada.`);
    reload();
  }

  const rows = (data ?? []).filter((p) => `${p.name} ${p.barcodes.join(' ')} ${p.category}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="cols wide-left">
      <section className="card">
        <div className="toolbar"><input placeholder="Buscar por nombre, código o categoría" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <State error={error} loading={loading && !data} empty={!!data && rows.length === 0} onRetry={reload} />
        <table>
          <thead><tr><th>Producto</th><th>Código</th><th>Impuesto</th><th className="num">Costo prom.</th><th className="num">Precio</th><th className="num">Stock</th><th /></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={editing?.id === p.id ? 'active' : ''}>
                <td>{p.name}<div className="muted small">{p.category}{!p.active && ' · inactivo'}</div></td>
                <td><code>{p.barcodes[0]}</code></td>
                <td>{p.taxCode}</td>
                <td className="num">{formatMoney(p.costAvgCents)}</td>
                <td className="num">{formatMoney(p.priceCents)}</td>
                <td className={`num ${p.stock < 0 ? 'neg' : ''}`}>{p.stock}</td>
                <td className="nowrap">
                  <button onClick={() => open(p)}>Editar</button>
                  <button className="ghost" onClick={() => toggleActive(p)}>{p.active ? 'Desactivar' : 'Activar'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        {!editing ? (
          <p className="muted">Selecciona un producto para editar su precio o registrar una entrada de mercancía. Los cambios se distribuyen a todas las cajas como eventos (última escritura gana por HLC).</p>
        ) : (
          <>
            <h2>{editing.name}</h2>
            <label>Nombre<input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>Precio de venta (lista general)<input value={price} onChange={(e) => setPrice(e.target.value)} /></label>
            <button className="primary" onClick={save}>Guardar</button>
            <h3>Entrada de mercancía</h3>
            <label>Cantidad<input value={recvQty} onChange={(e) => setRecvQty(e.target.value)} /></label>
            <label>Costo unitario<input value={recvCost} onChange={(e) => setRecvCost(e.target.value)} /></label>
            <button onClick={receive}>Registrar entrada</button>
            {msg && <p className="muted">{msg}</p>}
          </>
        )}
      </section>
    </div>
  );
}

function Inventory() {
  const { data, error, loading, reload } = useData<InventoryReport>('/v1/reports/inventory');
  const label = { ok: 'OK', low: 'Bajo mínimo', negative: 'Negativo' } as const;
  const low = data?.items.filter((i) => i.status === 'low').length ?? 0;
  const negative = data?.items.filter((i) => i.status === 'negative').length ?? 0;
  return (
    <section className="card">
      <State error={error} loading={loading && !data} empty={!!data && data.items.length === 0} onRetry={reload} />
      {data && data.items.length > 0 && (
        <>
          <div className="kpis">
            <Kpi label="Valor a costo" value={formatMoney(data.costValueCents)} />
            <Kpi label="Valor a precio de venta" value={formatMoney(data.retailValueCents)} />
            <Kpi label="Bajo mínimo" value={low} tone={low ? 'warn' : ''} />
            <Kpi label="Stock negativo" value={negative} tone={negative ? 'neg' : ''} />
          </div>
          <table>
            <thead><tr><th>Producto</th><th>Categoría</th><th className="num">Stock</th><th className="num">Mínimo</th><th className="num">Costo prom.</th><th className="num">Valor</th><th>Estado</th></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.productId}>
                  <td>{i.name}</td><td>{i.category}</td>
                  <td className="num">{i.qty}</td><td className="num">{i.minStock ?? '—'}</td>
                  <td className="num">{formatMoney(i.costAvgCents)}</td><td className="num">{formatMoney(i.costValueCents)}</td>
                  <td><span className={`tag ${i.status === 'negative' ? 'neg' : i.status === 'low' ? 'warn' : ''}`}>{label[i.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data.expiring?.length ?? 0) > 0 && (
            <>
              <h3>Por vencer (7 días) o vencido</h3>
              <table>
                <thead><tr><th>Producto</th><th>Lote</th><th className="num">Cantidad</th><th>Vence</th><th className="num">Días</th></tr></thead>
                <tbody>
                  {data.expiring!.map((l) => (
                    <tr key={`${l.productId}:${l.lotCode}:${l.expiresOn}`}>
                      <td>{l.name}</td>
                      <td>{l.lotCode ?? '—'}</td>
                      <td className="num">{l.qty}</td>
                      <td>{l.expiresOn}</td>
                      <td className={`num ${l.daysLeft < 0 ? 'neg' : 'warn'}`}>{l.daysLeft}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Customers() {
  const { data, error, loading, reload } = useData<Array<{ id: string; name: string; docId: string | null; phone: string | null; priceListId: string | null; creditLimitCents: number | null; creditBalanceCents: number }>>('/v1/customers');
  return (
    <section className="card">
      <State error={error} loading={loading && !data} empty={!!data && data.length === 0} onRetry={reload} />
      <table>
        <thead><tr><th>Cliente</th><th>Documento</th><th>Teléfono</th><th>Lista</th><th className="num">Cupo</th><th className="num">Ventas a crédito</th></tr></thead>
        <tbody>
          {data?.map((c) => (
            <tr key={c.id}><td>{c.name}</td><td>{c.docId}</td><td>{c.phone}</td><td>{c.priceListId ?? 'general'}</td><td className="num">{c.creditLimitCents ? formatMoney(c.creditLimitCents) : '—'}</td><td className="num">{formatMoney(c.creditBalanceCents)}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Cash() {
  const { data, error, loading, reload } = useData<{ sessions: Array<{ id: string; opened_at: string; closed_at: string | null; opening_cents: number; counted_cents: number | null; expected_cents: number | null; difference_cents: number | null; device_name: string; user_name: string; cash_sales_cents: number; sales: number }> }>(
    `/v1/reports/cash?from=${isoDay(-30)}&to=${isoDay()}`,
  );
  return (
    <section className="card">
      <p className="muted">Últimos 30 días. El cierre es por dispositivo y turno; las cajas desconectadas se consolidan al sincronizar. En la caja el esperado queda oculto hasta el conteo.</p>
      <State error={error} loading={loading && !data} empty={!!data && data.sessions.length === 0} onRetry={reload} />
      <table>
        <thead><tr><th>Apertura</th><th>Cierre</th><th>Caja</th><th>Cajero</th><th className="num">Base</th><th className="num">Ventas</th><th className="num">Efectivo vendido</th><th className="num">Esperado</th><th className="num">Contado</th><th className="num">Diferencia</th></tr></thead>
        <tbody>
          {data?.sessions.map((c) => (
            <tr key={c.id}>
              <td>{new Date(c.opened_at).toLocaleString('es-CO')}</td>
              <td>{c.closed_at ? new Date(c.closed_at).toLocaleString('es-CO') : <span className="tag">Abierta</span>}</td>
              <td>{c.device_name}</td><td>{c.user_name}</td>
              <td className="num">{formatMoney(Number(c.opening_cents))}</td>
              <td className="num">{c.sales}</td>
              <td className="num">{formatMoney(Number(c.cash_sales_cents))}</td>
              <td className="num">{c.expected_cents === null ? '—' : formatMoney(Number(c.expected_cents))}</td>
              <td className="num">{c.counted_cents === null ? '—' : formatMoney(Number(c.counted_cents))}</td>
              <td className={`num ${Number(c.difference_cents) !== 0 && c.difference_cents !== null ? 'neg' : ''}`}>{c.difference_cents === null ? '—' : formatMoney(Number(c.difference_cents))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Devices() {
  const { data, error, loading, reload } = useData<Array<{ id: string; name: string; platform: string; last_seq: number; events: number; created_at: string; last_seen_at: string | null; revoked_at: string | null }>>('/v1/devices');
  const [code, setCode] = useState<string | null>(null);
  async function newCode() {
    const r = await api<{ code: string }>('/v1/devices/pairing-codes', { method: 'POST', body: { uses: 1 } });
    setCode(r.code);
  }
  async function revoke(id: string) {
    if (!confirm('¿Revocar este dispositivo? Dejará de sincronizar inmediatamente.')) return;
    await api(`/v1/devices/${id}/revoke`, { method: 'POST' });
    reload();
  }
  return (
    <section className="card">
      <div className="toolbar">
        <button className="primary" onClick={newCode}>Generar código de vinculación</button>
        {code && <span>Código de un solo uso (24 h): <code className="big">{code}</code></span>}
        <span className="muted">Código demo reutilizable: DEMO-2026</span>
      </div>
      <State error={error} loading={loading && !data} empty={!!data && data.length === 0} onRetry={reload} />
      <table>
        <thead><tr><th>Nombre</th><th>Plataforma</th><th className="num">Eventos</th><th className="num">Último seq</th><th>Última conexión</th><th>Estado</th><th /></tr></thead>
        <tbody>
          {data?.map((d) => (
            <tr key={d.id}>
              <td>{d.name}<div className="muted small"><code>{d.id}</code></div></td>
              <td>{d.platform}</td>
              <td className="num">{d.events}</td>
              <td className="num">{d.last_seq}</td>
              <td>{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString('es-CO') : '—'}</td>
              <td>{d.revoked_at ? <span className="tag neg">Revocado</span> : <span className="tag">Activo</span>}</td>
              <td>{!d.revoked_at && !d.id.startsWith('srv_') && <button className="ghost" onClick={() => revoke(d.id)}>Revocar</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Alerts() {
  const { data, error, loading, reload } = useData<Array<{ id: string; kind: string; message: string; created_at: string }>>('/v1/alerts');
  const kinds: Record<string, string> = {
    negative_stock: 'Stock negativo',
    price_diff: 'Diferencia de precio',
    barcode_conflict: 'Código duplicado',
    sale_voided: 'Anulación',
    cash_difference: 'Diferencia de caja',
    near_expiry: 'Por vencer',
  };
  async function resolve(id: string) {
    await api(`/v1/alerts/${id}/resolve`, { method: 'POST' });
    reload();
  }
  return (
    <section className="card">
      <State error={error} loading={loading && !data} empty={!!data && data.length === 0} emptyText="Sin alertas pendientes." onRetry={reload} />
      <table>
        <tbody>
          {data?.map((a) => (
            <tr key={a.id}>
              <td><span className={`tag ${a.kind === 'negative_stock' || a.kind === 'cash_difference' ? 'neg' : 'warn'}`}>{kinds[a.kind] ?? a.kind}</span></td>
              <td>{a.message}</td>
              <td className="muted nowrap">{new Date(a.created_at).toLocaleString('es-CO')}</td>
              <td><button className="ghost" onClick={() => resolve(a.id)}>Resolver</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function Panel() {
  const [name, setName] = useState<string | null>(() => (localStorage.getItem('panel:token') ? localStorage.getItem('panel:name') ?? 'Dueño' : null));
  const [section, setSection] = useState<Section>('dashboard');
  useEffect(() => {
    const out = () => setName(null);
    window.addEventListener('panel:logout', out);
    return () => window.removeEventListener('panel:logout', out);
  }, []);
  if (!name) return <Login onLogged={setName} />;
  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>POS MiniMarket</h1>
        <p className="muted small">{name}</p>
        <nav>
          {SECTIONS.map((s) => (
            <button key={s.id} className={section === s.id ? 'active' : ''} onClick={() => setSection(s.id)}>{s.label}</button>
          ))}
        </nav>
        <button className="ghost" onClick={() => { localStorage.removeItem('panel:token'); setName(null); }}>Cerrar sesión</button>
      </aside>
      <main className="content">
        <h1>{SECTIONS.find((s) => s.id === section)?.label}</h1>
        {section === 'dashboard' && <Dashboard />}
        {section === 'productos' && <Products />}
        {section === 'inventario' && <Inventory />}
        {section === 'clientes' && <Customers />}
        {section === 'caja' && <Cash />}
        {section === 'dispositivos' && <Devices />}
        {section === 'alertas' && <Alerts />}
      </main>
    </div>
  );
}
