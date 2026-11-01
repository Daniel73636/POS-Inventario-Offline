'use client';

import { UNIT_LABELS, type Product, type User } from '@pos/contracts';
import {
  addToCart,
  allocateSaleLine,
  applyDiscount,
  computeCartTotals,
  emptyCart,
  finalizeSale,
  formatMoney,
  lineGross,
  removeLine,
  saleLotWarnings,
  setCustomer,
  setLinePromotion,
  setLineQty,
  type Cart,
  type PaymentInput,
} from '@pos/domain-pos';
import { findByBarcode, listNearExpiry, productLots, searchProducts, uuidv7, type ProductState, type SaleRecord } from '@pos/sync-engine';
import { applyTicketWidth, printTicket, readTicketWidth, type TicketWidth } from '@/lib/ticket';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePos } from '@/lib/pos-context';
import { sounds } from '@/lib/sound';
import { CreateProductDialog, CustomerPicker, DiscountDialog, ParkedSalesDialog, Receipt, SupervisorPinDialog } from './Dialogs';
import { PaymentDialog } from './PaymentDialog';

type DialogState =
  | null
  | { kind: 'pay' }
  | { kind: 'customer' }
  | { kind: 'discount' }
  | { kind: 'parked' }
  | { kind: 'create'; barcode: string }
  | { kind: 'pin'; reason: string; minRole: 'supervisor' | 'owner'; onOk: (authorizer: User) => void };

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'warn' | 'error';
}

export function SaleScreen() {
  const { db, user, config, emit, version } = usePos();
  const state = db.state;
  const [cart, setCart] = useState<Cart>(() => db.getDraft<Cart>() ?? emptyCart());
  const [active, setActive] = useState(0);
  const [input, setInput] = useState('');
  const [qtyMode, setQtyMode] = useState(false);
  const [resultIdx, setResultIdx] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lastSale, setLastSale] = useState<SaleRecord | null>(null);
  const [discountAuthorizedBy, setDiscountAuthorizedBy] = useState<string | null>(null);
  const [ticketMm, setTicketMm] = useState<TicketWidth>(80);
  const inputRef = useRef<HTMLInputElement>(null);

  // Venta en curso persistida: tras un corte se recupera la venta en espera.
  useEffect(() => db.setDraft(cart), [cart, db]);
  useEffect(() => setTicketMm(readTicketWidth()), []);
  useEffect(() => {
    if (!dialog) inputRef.current?.focus();
  }, [dialog, cart]);

  const totals = useMemo(() => computeCartTotals(cart), [cart]);
  const customer = cart.customerId ? state.customers[cart.customerId] : null;
  const results = useMemo(() => {
    const q = input.replace(/^\d+([.,]\d+)?\*/, '');
    if (qtyMode || q.length < 2 || /^\d+$/.test(q)) return [];
    return searchProducts(state, q, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, qtyMode, version]);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const addProduct = useCallback(
    (product: ProductState | Product, qty = 1, packId: string | null = null) => {
      setCart((c) => {
        const next = addToCart(c, product, qty, { packId });
        const idx = next.lines.findIndex((l) => l.productId === product.id && l.packId === packId);
        setActive(idx);
        return next;
      });
      const units = packId ? (product.packs.find((p) => p.id === packId)?.unitsPerPack ?? 1) * qty : qty;
      const inCart = cart.lines.filter((l) => l.productId === product.id).reduce((s, l) => s + l.qty, 0);
      const stock = state.stock[product.id] ?? 0;
      const today = new Date().toISOString().slice(0, 10);
      const soon = listNearExpiry(state, today).filter((l) => l.productId === product.id);
      if (stock - inCart - units < 0) {
        sounds.stock();
        toast(`Stock insuficiente de "${product.name}" (${stock}). Se permite vender; quedará negativo.`, 'warn');
      } else if (soon.some((l) => l.daysLeft < 0)) {
        sounds.stock();
        toast(`"${product.name}" tiene lote vencido bloqueado. Se vende del lote vigente.`, 'warn');
      } else if (soon.length) {
        sounds.ok();
        toast(`"${product.name}" vence el ${soon[0].expiresOn}.`, 'warn');
      } else {
        sounds.ok();
      }
    },
    [cart.lines, state, toast],
  );

  function submitInput() {
    const raw = input.trim();
    if (qtyMode) {
      const qty = Number(raw.replace(',', '.'));
      const line = cart.lines[active];
      if (line && qty > 0) setCart((c) => setLineQty(c, line.lineId, qty));
      setQtyMode(false);
      setInput('');
      return;
    }
    if (!raw) {
      if (cart.lines.length) setDialog({ kind: 'pay' });
      return;
    }
    let qty = 1;
    let code = raw;
    const m = raw.match(/^(\d+(?:[.,]\d+)?)\*(.+)$/);
    if (m) {
      qty = Number(m[1].replace(',', '.'));
      code = m[2].trim();
    }
    const hit = findByBarcode(state, code);
    if (hit && hit.product.active) {
      addProduct(hit.product, qty, hit.packId);
      setInput('');
      return;
    }
    if (results.length) {
      addProduct(results[Math.min(resultIdx, results.length - 1)], qty);
      setInput('');
      setResultIdx(0);
      return;
    }
    if (/^\d{4,}$/.test(code)) {
      sounds.notFound();
      setDialog({ kind: 'create', barcode: code });
      setInput('');
      return;
    }
    sounds.notFound();
    toast(`Sin resultados para "${code}"`, 'error');
  }

  const changeQty = useCallback(
    (delta: number) => {
      const line = cart.lines[active];
      if (!line) return;
      setCart((c) => setLineQty(c, line.lineId, line.qty + delta));
    },
    [cart.lines, active],
  );

  const deleteActive = useCallback(() => {
    const line = cart.lines[active];
    if (!line) return;
    setCart((c) => removeLine(c, line.lineId));
    setActive((a) => Math.max(0, Math.min(a, cart.lines.length - 2)));
  }, [cart.lines, active]);

  const park = useCallback(() => {
    if (!cart.lines.length) {
      setDialog({ kind: 'parked' });
      return;
    }
    const list = db.getParked();
    db.setParked([...list, { id: uuidv7(), at: new Date().toISOString(), label: `${totals.itemCount} art. · ${formatMoney(totals.totalCents)}${customer ? ` · ${customer.name}` : ''}`, cart }]);
    setCart(emptyCart());
    toast('Venta suspendida (F10 para recuperar)');
  }, [cart, customer, db, toast, totals]);

  function requestDiscount(rule: { type: 'percent'; bp: number } | { type: 'amount'; cents: number }) {
    if (!user) return;
    const full = rule.type === 'percent' ? { ...rule, scope: 'cart' as const } : { ...rule, scope: 'cart' as const };
    const r = applyDiscount(cart, full, user.role);
    if (r.ok) {
      setCart(r.cart);
      setDiscountAuthorizedBy(null);
      setDialog(null);
      toast(r.discountCents ? `Descuento ${formatMoney(r.discountCents)} aplicado` : 'Descuento retirado');
      return;
    }
    if (r.reason === 'exceeds_role_limit') {
      const minRole = r.requiredRole === 'owner' ? 'owner' : 'supervisor';
      setDialog({
        kind: 'pin',
        reason: `Descuento de ${formatMoney(r.discountCents)} supera tu límite. Requiere ${minRole === 'owner' ? 'dueña' : 'supervisor'}.`,
        minRole,
        onOk: (authorizer) => {
          const again = applyDiscount(cart, full, authorizer.role);
          if (again.ok) {
            setCart(again.cart);
            setDiscountAuthorizedBy(again.discountCents ? authorizer.id : null);
            toast(`Descuento autorizado: ${formatMoney(again.discountCents)}`);
          }
          setDialog(null);
        },
      });
      return;
    }
    toast(r.message, 'error');
  }

  function completeSale(payments: PaymentInput[]) {
    if (!user || !config) return;
    const sessionId = db.meta.sessionId;
    if (!sessionId) {
      toast('Abre la caja antes de vender', 'error');
      return;
    }
    const result = finalizeSale(cart, payments);
    if (!result.ok) {
      toast(result.errors[0], 'error');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const lotWarnings: string[] = [];
    const items = result.sale.items.map((item) => {
      const product = state.products[item.productId];
      if (!product?.tracksLots) return item;
      const known = productLots(state, item.productId);
      if (!known.some((l) => l.qty > 0)) {
        lotWarnings.push(`"${item.name}" controla lotes pero no hay existencias por lote.`);
        return item;
      }
      const alloc = allocateSaleLine(item.baseQty, known, today);
      lotWarnings.push(...saleLotWarnings(item.name, alloc, today));
      return alloc.lots.length ? { ...item, lots: alloc.lots } : item;
    });
    const saleId = uuidv7();
    const localNumber = db.meta.saleNumber + 1;
    emit(
      'SaleCompleted',
      { saleId, localNumber, cashSessionId: sessionId, userId: user.id, fiscalNumber: null, discountAuthorizedBy: result.sale.discountCents > 0 ? discountAuthorizedBy : null, ...result.sale, items },
      { saleNumber: localNumber },
    );
    sounds.paid();
    setLastSale(db.state.sales[saleId] ?? null);
    setCart(emptyCart());
    setDiscountAuthorizedBy(null);
    setActive(0);
    setDialog(null);
    toast(
      result.sale.changeCents > 0 ? `Venta #${localNumber} · Cambio ${formatMoney(result.sale.changeCents)}` : `Venta #${localNumber} registrada`,
    );
    if (lotWarnings.length) toast(lotWarnings[0], 'warn');
  }

  // Atajos de teclado globales de la pantalla de venta.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (dialog || document.querySelector('[role="dialog"]')) return;
      const inputEmpty = !inputRef.current?.value;
      switch (e.key) {
        case 'F2':
          e.preventDefault();
          setQtyMode(false);
          inputRef.current?.focus();
          inputRef.current?.select();
          break;
        case 'F3':
          e.preventDefault();
          if (cart.lines.length) {
            setQtyMode(true);
            setInput('');
          }
          break;
        case 'F4':
          e.preventDefault();
          setDialog({ kind: 'customer' });
          break;
        case 'F6':
          e.preventDefault();
          if (cart.lines.length) setDialog({ kind: 'discount' });
          break;
        case 'F9':
          e.preventDefault();
          park();
          break;
        case 'F10':
          e.preventDefault();
          setDialog({ kind: 'parked' });
          break;
        case 'F12':
          e.preventDefault();
          if (cart.lines.length) setDialog({ kind: 'pay' });
          break;
        case 'ArrowUp':
          if (results.length) return;
          e.preventDefault();
          setActive((a) => Math.max(0, a - 1));
          break;
        case 'ArrowDown':
          if (results.length) return;
          e.preventDefault();
          setActive((a) => Math.min(cart.lines.length - 1, a + 1));
          break;
        case '+':
          if (inputEmpty) {
            e.preventDefault();
            changeQty(1);
          }
          break;
        case '-':
          if (inputEmpty) {
            e.preventDefault();
            changeQty(-1);
          }
          break;
        case 'Delete':
          if (inputEmpty) {
            e.preventDefault();
            deleteActive();
          }
          break;
        case 'Escape':
          e.preventDefault();
          setQtyMode(false);
          setInput('');
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, cart.lines.length, results.length, park, changeQty, deleteActive]);

  const quick = Object.values(state.products).filter((p) => p.quick && p.active).slice(0, 16);
  const expiring = useMemo(() => listNearExpiry(state, new Date().toISOString().slice(0, 10)), [state, version]);

  return (
    <div className="sale">
      <section className="sale-left">
        {expiring.length > 0 && (
          <div className="expiry-banner" role="status">
            <strong>Por vencer o vencido ({expiring.length})</strong>
            <ul>
              {expiring.slice(0, 4).map((l) => (
                <li key={`${l.productId}:${l.lotId}`}>
                  {l.productName} · lote {l.lotId} · {l.qty} und · {l.daysLeft < 0 ? `venció ${l.expiresOn}` : `vence ${l.expiresOn}`}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="scan-wrap">
          <input
            ref={inputRef}
            className={`scan-input ${qtyMode ? 'qty-mode' : ''}`}
            value={input}
            aria-label="Código de barras o búsqueda"
            placeholder={qtyMode ? `Nueva cantidad para "${cart.lines[active]?.name ?? ''}" y Enter` : 'Escanea o escribe (F2) · 3*código para cantidad · Enter vacío = cobrar'}
            onChange={(e) => {
              setInput(e.target.value);
              setResultIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitInput();
              } else if (results.length && e.key === 'ArrowDown') {
                e.preventDefault();
                setResultIdx((i) => Math.min(i + 1, results.length - 1));
              } else if (results.length && e.key === 'ArrowUp') {
                e.preventDefault();
                setResultIdx((i) => Math.max(i - 1, 0));
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {results.length > 0 && (
            <ul className="results" role="listbox">
              {results.map((p, i) => (
                <li key={p.id} className={i === resultIdx ? 'active' : ''} role="option" aria-selected={i === resultIdx}>
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addProduct(p);
                      setInput('');
                    }}
                  >
                    <span>{p.name}</span>
                    <span className="muted">stock {state.stock[p.id] ?? 0}</span>
                    <strong>{formatMoney(p.priceCents)}</strong>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <CartTable cart={cart} active={active} onSelect={setActive} onQty={(lineId, qty) => setCart((c) => setLineQty(c, lineId, qty))} onRemove={(lineId) => setCart((c) => removeLine(c, lineId))} lineTotals={totals.lines} />
      </section>

      <aside className="sale-right">
        <div className="total-panel">
          <div className="total-label">TOTAL</div>
          <div className="total-amount" data-testid="total">{formatMoney(totals.totalCents)}</div>
          <div className="total-meta">
            <span>{cart.lines.length} líneas · {totals.itemCount} artículos</span>
            {totals.discountCents > 0 && <span className="discount">Descuento −{formatMoney(totals.discountCents)}</span>}
            <span>IVA/INC incluido {formatMoney(totals.taxCents)}</span>
          </div>
          <div className="customer-chip">Cliente: <strong>{customer?.name ?? 'Consumidor final'}</strong>{customer?.priceListId && <span className="tag">Lista {customer.priceListId}</span>}</div>
        </div>
        <button className="primary pay-btn" disabled={!cart.lines.length} onClick={() => setDialog({ kind: 'pay' })}>
          Cobrar <kbd>F12</kbd>
        </button>
        <div className="actions">
          <button onClick={() => inputRef.current?.focus()}>Buscar <kbd>F2</kbd></button>
          <button disabled={!cart.lines.length} onClick={() => { setQtyMode(true); inputRef.current?.focus(); }}>Cantidad <kbd>F3</kbd></button>
          <button onClick={() => setDialog({ kind: 'customer' })}>Cliente <kbd>F4</kbd></button>
          <button disabled={!cart.lines.length} onClick={() => setDialog({ kind: 'discount' })}>Descuento <kbd>F6</kbd></button>
          <button
            disabled={!cart.lines.length}
            className={cart.lines[active]?.promotion?.kind === 'bogo' ? 'active' : ''}
            onClick={() => {
              const line = cart.lines[active];
              if (!line) return;
              const on = line.promotion?.kind === 'bogo';
              setCart((c) => setLinePromotion(c, line.lineId, on ? null : { id: `2x1:${line.productId}`, kind: 'bogo', productId: line.productId, buy: 2, pay: 1 }));
            }}
          >2×1</button>
          <button onClick={park}>Suspender <kbd>F9</kbd></button>
          <button onClick={() => setDialog({ kind: 'parked' })}>En espera ({db.getParked().length}) <kbd>F10</kbd></button>
          <button disabled={!cart.lines.length} className="danger" onClick={() => { if (confirm('¿Cancelar la venta en curso?')) setCart(emptyCart()); }}>Cancelar venta</button>
        </div>
        {lastSale && (
          <div className="last-sale">
            <div className="row">
              <span>Última venta #{lastSale.localNumber}</span>
              <span className="ticket-tools">
                <button className={ticketMm === 58 ? 'active' : ''} onClick={() => { setTicketMm(58); applyTicketWidth(58); }}>58 mm</button>
                <button className={ticketMm === 80 ? 'active' : ''} onClick={() => { setTicketMm(80); applyTicketWidth(80); }}>80 mm</button>
                <button onClick={() => printTicket(ticketMm)}>Imprimir</button>
              </span>
            </div>
            <Receipt sale={lastSale} storeName={config?.storeName ?? ''} cashier={user?.name ?? ''} width={ticketMm} />
          </div>
        )}
      </aside>

      <section className="quick-grid" aria-label="Productos rápidos">
        {quick.map((p) => (
          <button key={p.id} style={{ borderTopColor: p.color ?? 'var(--accent)' }} onClick={() => addProduct(p)}>
            <span>{p.name}</span>
            <strong>{formatMoney(p.priceCents)}{p.unit !== 'unit' ? `/${UNIT_LABELS[p.unit]}` : ''}</strong>
          </button>
        ))}
      </section>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
      </div>

      {dialog?.kind === 'pay' && <PaymentDialog totalCents={totals.totalCents} hasCustomer={!!cart.customerId} onConfirm={completeSale} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'customer' && (
        <CustomerPicker
          onPick={(c) => {
            setCart((cur) => setCustomer(cur, c ? { id: c.id, priceListId: c.priceListId } : null));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'discount' && <DiscountDialog grossCents={totals.grossCents} onApply={requestDiscount} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'parked' && (
        <ParkedSalesDialog
          list={db.getParked()}
          onResume={(p) => {
            if (cart.lines.length) park();
            setCart(p.cart as Cart);
            db.setParked(db.getParked().filter((x) => x.id !== p.id));
            setDialog(null);
          }}
          onDelete={(id) => {
            db.setParked(db.getParked().filter((x) => x.id !== id));
            setDialog({ kind: 'parked' });
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'create' && (
        <CreateProductDialog
          barcode={dialog.barcode}
          onCreate={(p) => {
            emit('ProductUpserted', { product: p });
            addProduct(p);
            setDialog(null);
            toast(`Producto "${p.name}" creado`);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'pin' && (
        <SupervisorPinDialog reason={dialog.reason} minRole={dialog.minRole} onOk={(u) => dialog.onOk(u)} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function CartTable({
  cart,
  active,
  onSelect,
  onQty,
  onRemove,
  lineTotals,
}: {
  cart: Cart;
  active: number;
  onSelect: (i: number) => void;
  onQty: (lineId: string, qty: number) => void;
  onRemove: (lineId: string) => void;
  lineTotals: Array<{ lineId: string; totalCents: number; discountCents: number }>;
}) {
  const activeRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => activeRef.current?.scrollIntoView({ block: 'nearest' }), [active, cart.lines.length]);
  if (!cart.lines.length) {
    return (
      <div className="cart-empty">
        <p>Escanea un producto para empezar.</p>
        <p className="hint">Prueba: <code>7701234000011</code> (gaseosa) · <code>7701234009014</code> (six pack) · <code>12*7701234000066</code> (12 arroz, precio por volumen) · escribe «leche»</p>
      </div>
    );
  }
  return (
    <div className="cart-wrap">
      <table className="cart">
        <thead>
          <tr><th>Cant.</th><th>Producto</th><th className="num">P. unit</th><th className="num">Importe</th><th /></tr>
        </thead>
        <tbody>
          {cart.lines.map((l, i) => (
            <tr key={l.lineId} ref={i === active ? activeRef : undefined} className={i === active ? 'active' : ''} onClick={() => onSelect(i)}>
              <td className="qty">
                <button aria-label="Menos" onClick={(e) => { e.stopPropagation(); onQty(l.lineId, l.qty - 1); }}>−</button>
                <span>{l.qty}{l.unit !== 'unit' ? ` ${UNIT_LABELS[l.unit as keyof typeof UNIT_LABELS] ?? l.unit}` : ''}</span>
                <button aria-label="Más" onClick={(e) => { e.stopPropagation(); onQty(l.lineId, l.qty + 1); }}>+</button>
              </td>
              <td>
                {l.name}
                {l.promotion?.kind === 'bogo' && <span className="tag">2×1</span>}
                {l.packId && <span className="tag">{l.pricing.packs?.find((p) => p.id === l.packId)?.name}</span>}
                {l.priceListId !== 'general' && <span className="tag">{l.priceListId}</span>}
              </td>
              <td className="num">{formatMoney(l.unitPriceCents)}</td>
              <td className="num">
                {formatMoney(lineGross(l))}
                {lineTotals[i]?.discountCents > 0 && <div className="muted small">−{formatMoney(lineTotals[i].discountCents)}</div>}
              </td>
              <td><button className="ghost" aria-label="Eliminar" onClick={(e) => { e.stopPropagation(); onRemove(l.lineId); }}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">↑↓ seleccionar · + / − cantidad · Supr eliminar · F3 cantidad exacta (kg)</p>
    </div>
  );
}
