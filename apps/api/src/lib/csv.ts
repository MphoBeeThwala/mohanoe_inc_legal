// CSV for spreadsheets. Cells that a spreadsheet would read as a formula
// (=, +, -, @, tab or carriage return first) are prefixed with an apostrophe,
// so an exported value can never run as a formula (CSV injection).
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Plain numbers (including negative amounts) stay numbers.
  const numeric = typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(text);
  if (!numeric && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Cents as rands with two decimals, for spreadsheets (no currency sign). */
export const randsCell = (cents: number) => (cents / 100).toFixed(2);
