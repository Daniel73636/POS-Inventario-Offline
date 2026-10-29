'use client';

import {
  formatMoney,
  parseMoney,
  PAYMENT_METHOD_KEYS,
  PAYMENT_METHOD_LABELS,
  quickCashOptions,
  splitPayments,
  type PaymentInput,
  type PaymentMethod,
} from '@pos/domain-pos';
import { useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  totalCents: number;
  hasCustomer: boolean;
  onConfirm: (payments: PaymentInput[]) => void;
  onClose: () => void;
}

const METHODS: Array<{ m: PaymentMethod; key: string }> = [
  { m: 'cash', key: 'E' },
  { m: 'card', key: 'T' },
  { m: 'transfer', key: 'R' },
  { m: 'credit', key: 'C' },
];

export function PaymentDialog({ totalCents, hasCustomer, onConfirm, onClose }: Props) {
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [payments, setPayments] = useState<PaymentInput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), [method]);

  const split = useMemo(() => splitPayments(totalCents, payments), [totalCents, payments]);
  const typed = parseMoney(amount);

  function tryConfirm(list: PaymentInput[]) {
    const r = splitPayments(totalCents, list);
    if (r.errors.length) {
      setError(r.errors[0]);
      return;
    }
    if (list.some((p) => p.method === 'credit') && !hasCustomer) {
      setError('El crédito requiere asignar un cliente (F4)');
      return;
    }
    if (r.ok) onConfirm(list);
  }

  function addPayment(value: number | null, m: PaymentMethod = method) {
    setError(null);
    const remaining = splitPayments(totalCents, payments).remainingCents;
    const amountCents = value ?? remaining;
    if (amountCents <= 0) {
      tryConfirm(payments);
      return;
    }
    if (m !== 'cash' && amountCents > remaining) {
      setError(`${PAYMENT_METHOD_LABELS[m]} no puede superar lo que falta (${formatMoney(remaining)})`);
      return;
    }
    const next = [...payments, { method: m, amountCents, reference: reference || null }];
    setPayments(next);
    setAmount('');
    setReference('');
    tryConfirm(next);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      addPayment(amount ? typed : null);
    } else if (PAYMENT_METHOD_KEYS[k] && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setMethod(PAYMENT_METHOD_KEYS[k]);
    } else if (e.key === 'Backspace' && !amount && payments.length) {
      e.preventDefault();
      setPayments(payments.slice(0, -1));
    } else if (e.key === 'F12') {
      e.preventDefault();
      addPayment(amount ? typed : null);
    }
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Cobrar" onKeyDown={onKeyDown}>
      <div className="dialog payment">
        <header className="dialog-head">
          <h2>Cobrar</h2>
          <button className="ghost" onClick={onClose} aria-label="Cerrar">Esc ✕</button>
        </header>

        <div className="pay-grid">
          <div>
            <div className="methods">
              {METHODS.map(({ m, key }) => (
                <button key={m} className={`method ${method === m ? 'active' : ''}`} onClick={() => setMethod(m)}>
                  <kbd>{key}</kbd> {PAYMENT_METHOD_LABELS[m]}
                </button>
              ))}
            </div>

            <label className="field">
              <span>Monto recibido ({PAYMENT_METHOD_LABELS[method]}) — vacío = exacto</span>
              <input
                ref={inputRef}
                className="big-input"
                inputMode="decimal"
                value={amount}
                placeholder={formatMoney(split.remainingCents)}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
              />
            </label>
            {method !== 'cash' && (
              <label className="field">
                <span>Referencia (opcional)</span>
                <input value={reference} onChange={(e) => setReference(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              </label>
            )}

            {method === 'cash' && (
              <div className="bills">
                {quickCashOptions(split.remainingCents || totalCents).map((v) => (
                  <button key={v} onClick={() => addPayment(v, 'cash')}>{formatMoney(v)}</button>
                ))}
              </div>
            )}

            <div className="keypad">
              {['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '000', '⌫'].map((d) => (
                <button
                  key={d}
                  onClick={() => {
                    setAmount((a) => (d === '⌫' ? a.slice(0, -1) : a + d));
                    inputRef.current?.focus();
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div className="pay-summary">
            <div className="row"><span>Total</span><strong>{formatMoney(totalCents)}</strong></div>
            {payments.length > 0 && (
              <table className="payments">
                <tbody>
                  {payments.map((p, i) => (
                    <tr key={i}>
                      <td>{PAYMENT_METHOD_LABELS[p.method]}</td>
                      <td className="num">{formatMoney(p.amountCents)}</td>
                      <td><button className="ghost" onClick={() => setPayments(payments.filter((_, j) => j !== i))}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="row"><span>Pagado</span><strong>{formatMoney(split.paidCents)}</strong></div>
            {split.remainingCents > 0 ? (
              <div className="due">Falta {formatMoney(split.remainingCents)}</div>
            ) : (
              <div className="change">Cambio {formatMoney(split.changeCents)}</div>
            )}
            {amount && typed !== null && method === 'cash' && typed > split.remainingCents && (
              <div className="change preview">Cambio: {formatMoney(typed - split.remainingCents)}</div>
            )}
            {error && <div className="error">{error}</div>}
            <button className="primary xl" onClick={() => addPayment(amount ? typed : null)}>
              Confirmar <kbd>Enter</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
