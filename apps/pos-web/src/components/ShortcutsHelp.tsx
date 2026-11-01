'use client';

import { Dialog } from './Dialogs';

export const SHORTCUTS: Array<{ group: string; items: Array<[string, string]> }> = [
  {
    group: 'Venta',
    items: [
      ['Escanear / escribir + Enter', 'Agrega por código; texto = búsqueda (↑ ↓ + Enter)'],
      ['3*código', 'Cantidad antes del código (0,75*código para kg)'],
      ['Enter con campo vacío · F12', 'Cobrar'],
      ['F2', 'Buscar (enfocar el campo)'],
      ['F3', 'Cantidad exacta de la línea activa'],
      ['F4', 'Cliente (aplica su lista de precios)'],
      ['F6', 'Descuento (si supera tu límite pide PIN de supervisor)'],
      ['F9 · F10', 'Suspender venta · Ventas en espera'],
      ['↑ ↓ · + − · Supr', 'Línea activa · Cantidad · Eliminar línea'],
      ['Esc', 'Cancelar modo cantidad / cerrar diálogo'],
    ],
  },
  {
    group: 'Cobro',
    items: [
      ['E · T · R · C', 'Efectivo · Tarjeta · Transferencia · Crédito'],
      ['Enter', 'Confirmar pago'],
    ],
  },
  {
    group: 'Navegación',
    items: [
      ['Alt+1 … Alt+5', 'Venta · Inventario · Caja · Ventas · Ajustes'],
      ['? · F1', 'Mostrar esta ayuda'],
    ],
  },
];

/** `?` abre la ayuda salvo que se esté escribiendo texto en un campo. */
export function isHelpKey(e: KeyboardEvent): boolean {
  if (e.key === 'F1') return true;
  if (e.key !== '?') return false;
  const t = e.target as HTMLElement | null;
  const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  return !editable || !(t as HTMLInputElement).value;
}

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Atajos de teclado" onClose={onClose} wide>
      {SHORTCUTS.map((g) => (
        <section key={g.group}>
          <h3>{g.group}</h3>
          <table className="grid small">
            <tbody>
              {g.items.map(([keys, what]) => (
                <tr key={keys}><td><kbd>{keys}</kbd></td><td>{what}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <button className="primary" autoFocus onClick={onClose}>Entendido <kbd>Esc</kbd></button>
    </Dialog>
  );
}
