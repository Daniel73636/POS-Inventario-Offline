'use client';

import { TAX_RATES_BP, type Product, type TaxCode, type User } from '@pos/contracts';
import { formatMoney, parseMoney, PAYMENT_METHOD_LABELS } from '@pos/domain-pos';
import { normalizeText, type SaleRecord } from '@pos/sync-engine';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePos } from '@/lib/pos-context';
import type { ParkedSale } from '@/lib/local-db';

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={`dialog ${wide ? 'wide' : ''}`}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose} aria-label="Cerrar">Esc ✕</button>
        </header>
        {children}
      </div>
    </div>
  );
}

function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

/** PIN de supervisor para anulaciones y descuentos grandes. */
export function SupervisorPinDialog({ reason, minRole, onOk, onClose }: { reason: string; minRole: 'supervisor' | 'owner'; onOk: (u: User) => void; onClose: () => void }) {
  const { verifyPin } = usePos();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useAutoFocus<HTMLInputElement>();
  async function submit() {
    const u = await verifyPin(pin, minRole);
    if (u) onOk(u);
    else {
      setError('PIN inválido o sin permisos suficientes');
      setPin('');
    }
  }
  return (
    <Dialog title="Autorización de supervisor" onClose={onClose}>
      <p className="muted">{reason}</p>
      <input
        ref={ref}
        className="big-input"
        type="password"
        inputMode="numeric"
        value={pin}
        placeholder="PIN"
        onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && <div className="error">{error}</div>}
      <p className="hint">Demo: supervisor Luis 9999 · dueña 0000</p>
      <button className="primary" onClick={submit}>Autorizar <kbd>Enter</kbd></button>
    </Dialog>
  );
}

export function CustomerPicker({ onPick, onClose }: { onPick: (c: { id: string; name: string; priceListId: string | null } | null) => void; onClose: () => void }) {
  const { db } = usePos();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const ref = useAutoFocus<HTMLInputElement>();
  const list = Object.values(db.state.customers)
    .filter((c) => c.active && normalizeText(`${c.name} ${c.docId ?? ''} ${c.phone ?? ''}`).includes(normalizeText(q)))
    .slice(0, 8);
  return (
    <Dialog title="Cliente (F4)" onClose={onClose}>
      <input
        ref={ref}
        className="big-input"
        placeholder="Buscar por nombre, documento o teléfono"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, list.length - 1));
          if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          if (e.key === 'Enter' && list[active]) onPick(list[active]);
        }}
      />
      <ul className="pick-list">
        <li className={active === -1 ? 'active' : ''}>
          <button onClick={() => onPick(null)}>Consumidor final (sin cliente)</button>
        </li>
        {list.map((c, i) => (
          <li key={c.id} className={i === active ? 'active' : ''}>
            <button onClick={() => onPick(c)}>
              <strong>{c.name}</strong> <span className="muted">{c.docId}</span>
              {c.priceListId && <span className="tag">Lista {c.priceListId}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export function DiscountDialog({ grossCents, onApply, onClose }: { grossCents: number; onApply: (rule: { type: 'percent'; bp: number } | { type: 'amount'; cents: number }) => void; onClose: () => void }) {
  const [mode, setMode] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const ref = useAutoFocus<HTMLInputElement>();
  function submit() {
    if (mode === 'percent') {
      const pct = Number(value.replace(',', '.'));
      if (!(pct >= 0 && pct <= 100)) return;
      onApply({ type: 'percent', bp: Math.round(pct * 100) });
    } else {
      const cents = parseMoney(value);
      if (cents === null || cents < 0) return;
      onApply({ type: 'amount', cents });
    }
  }
  return (
    <Dialog title="Descuento al total (F6)" onClose={onClose}>
      <div className="seg">
        <button className={mode === 'percent' ? 'active' : ''} onClick={() => setMode('percent')}>% Porcentaje</button>
        <button className={mode === 'amount' ? 'active' : ''} onClick={() => setMode('amount')}>$ Valor</button>
      </div>
      <input
        ref={ref}
        className="big-input"
        inputMode="decimal"
        placeholder={mode === 'percent' ? 'Ej: 5' : 'Ej: 2.000'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === '%') {
            e.preventDefault();
            setMode('percent');
          }
        }}
      />
      <p className="hint">Bruto {formatMoney(grossCents)} · Cajero hasta 10 %, supervisor hasta 30 %, dueña sin límite. 0 = quitar descuento.</p>
      <button className="primary" onClick={submit}>Aplicar <kbd>Enter</kbd></button>
    </Dialog>
  );
}

export function ParkedSalesDialog({ list, onResume, onDelete, onClose }: { list: ParkedSale[]; onResume: (p: ParkedSale) => void; onDelete: (id: string) => void; onClose: () => void }) {
  return (
    <Dialog title="Ventas suspendidas (F10)" onClose={onClose}>
      {list.length === 0 && <p className="muted">No hay ventas en espera.</p>}
      <ul className="pick-list">
        {list.map((p, i) => (
          <li key={p.id}>
            <button autoFocus={i === 0} onClick={() => onResume(p)}>
              <strong>{p.label}</strong> <span className="muted">{new Date(p.at).toLocaleTimeString('es-CO')}</span>
            </button>
            <button className="ghost" onClick={() => onDelete(p.id)} aria-label="Descartar">🗑</button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

const TAX_OPTIONS: TaxCode[] = ['IVA19', 'IVA5', 'INC8', 'EXENTO', 'EXCLUIDO'];

/** Código inexistente: crear el producto al vuelo sin salir de la venta. */
export function CreateProductDialog({ barcode, onCreate, onClose }: { barcode: string; onCreate: (p: Product) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [tax, setTax] = useState<TaxCode>('IVA19');
  const ref = useAutoFocus<HTMLInputElement>();
  function submit() {
    const priceCents = parseMoney(price);
    if (!name.trim() || priceCents === null || priceCents <= 0) return;
    onCreate({
      id: `prd_${crypto.randomUUID().slice(0, 8)}`,
      name: name.trim(),
      sku: null,
      category: 'Sin categoría',
      brand: null,
      unit: 'unit',
      taxCode: tax,
      taxRateBp: TAX_RATES_BP[tax],
      taxIncluded: true,
      priceCents,
      costAvgCents: 0,
      minStock: null,
      active: true,
      tracksLots: false,
      barcodes: barcode ? [barcode] : [],
      prices: [{ priceListId: 'general', priceCents, minQty: 1 }],
      packs: [],
      color: null,
      quick: false,
    });
  }
  return (
    <Dialog title="Producto no encontrado" onClose={onClose}>
      <p className="muted">Código <code>{barcode}</code>. Créalo ahora y se agrega a la venta.</p>
      <label className="field"><span>Nombre</span><input ref={ref} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></label>
      <label className="field"><span>Precio de venta (IVA incluido)</span><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></label>
      <label className="field">
        <span>Impuesto</span>
        <select value={tax} onChange={(e) => setTax(e.target.value as TaxCode)}>
          {TAX_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <button className="primary" onClick={submit}>Crear y agregar <kbd>Enter</kbd></button>
    </Dialog>
  );
}

export function Receipt({ sale, storeName, cashier }: { sale: SaleRecord; storeName: string; cashier: string }) {
  return (
    <div className="receipt" id="receipt">
      <h3>{storeName}</h3>
      <p>Venta #{sale.localNumber} · {new Date(sale.occurredAt).toLocaleString('es-CO')}</p>
      <p>Cajero: {cashier}</p>
      <hr />
      {sale.items.map((it, i) => (
        <div key={i} className="r-line">
          <span>{it.qty} × {it.name}</span>
          <span>{formatMoney(it.lineTotalCents)}</span>
        </div>
      ))}
      <hr />
      {sale.discountCents > 0 && <div className="r-line"><span>Descuento</span><span>-{formatMoney(sale.discountCents)}</span></div>}
      <div className="r-line"><span>Impuestos incluidos</span><span>{formatMoney(sale.taxCents)}</span></div>
      <div className="r-line total"><span>TOTAL</span><span>{formatMoney(sale.totalCents)}</span></div>
      {sale.payments.map((p, i) => (
        <div key={i} className="r-line"><span>{PAYMENT_METHOD_LABELS[p.method]}</span><span>{formatMoney(p.amountCents)}</span></div>
      ))}
      {sale.changeCents > 0 && <div className="r-line"><span>Cambio</span><span>{formatMoney(sale.changeCents)}</span></div>}
      <hr />
      <p className="center">Documento interno — sin validez fiscal (demo)</p>
    </div>
  );
}
