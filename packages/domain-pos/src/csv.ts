/** Celda CSV. Neutraliza fórmulas de hoja de cálculo y escapa comillas. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** CSV con salto de línea final. El llamador puede anteponer el BOM UTF-8 para Excel. */
export function toCsv(headers: string[], rows: Array<Array<string | number>>): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}
