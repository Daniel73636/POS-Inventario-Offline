/** Ancho de papel térmico elegido en la caja (diálogo de impresión del navegador). */
export type TicketWidth = 58 | 80;

const KEY = 'pos:ticketMm';

export function readTicketWidth(): TicketWidth {
  if (typeof localStorage === 'undefined') return 80;
  return localStorage.getItem(KEY) === '58' ? 58 : 80;
}

export function applyTicketWidth(width: TicketWidth): void {
  localStorage.setItem(KEY, String(width));
  document.documentElement.dataset.ticketMm = String(width);
}

export function printTicket(width: TicketWidth = readTicketWidth()): void {
  document.documentElement.dataset.ticketMm = String(width);
  window.print();
}
