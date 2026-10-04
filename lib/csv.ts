/**
 * CSV export helpers.
 *
 * Kept deliberately dependency-free: the ranking table is the only consumer and
 * pulling in a CSV library for one download button would be dead weight.
 */

export type CsvCell = string | number | null | undefined;

/** Escape a single field per RFC 4180. */
function escapeCell(value: CsvCell): string {
  if (value == null) return '';
  const s = String(value);
  // Guard against spreadsheet formula injection (=, +, -, @ at field start).
  const needsQuote = /[",\n\r]/.test(s) || /^[=+\-@\t\r]/.test(s);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return needsQuote ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Serialize a 2D array to RFC 4180 CSV (CRLF line endings). */
export function toCsv(rows: CsvCell[][]): string {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

/**
 * Trigger a client-side download. Runs in the browser only — callers must not
 * invoke this during SSR.
 */
export function downloadCsv(filename: string, rows: CsvCell[][]): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  // BOM so Excel opens UTF-8 tickers/icons correctly.
  const blob = new Blob(['\uFEFF', toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick — revoking synchronously races the click in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `althunter-ranking-2026-10-04-1530.csv` */
export function csvTimestampedName(prefix: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
}
