/**
 * Canonical Telegram message frame.
 *
 * Every push gets the same shape so a chat message is instantly readable:
 *   - source label (what kind of message this is)
 *   - WIB timestamp (when it was sent)
 *   - divider
 *   - body
 *   - optional disclaimer footer
 *
 * Pure strings — safe to import from browser and server alike.
 */

export function tgFrame(
  label: string,
  body: string,
  opts: { footer?: string } = {},
): string {
  const now = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const head = [`🧭 ALTHUNTER · ${label}`, `${now} WIB`, '━━━━━━━━━━━━━━━━━━━━━━'];
  const parts = [...head, body];
  if (opts.footer) parts.push('', opts.footer);
  return parts.join('\n').slice(0, 3900);
}

/** Label emoji + teks per jenis sinyal. */
export function signalLabel(signal: string): string {
  return {
    strong_buy: '🚀 STRONG BUY',
    buy: '📈 BUY',
    strong_sell: '🔻 STRONG SELL',
    sell: '📉 SELL',
  }[signal] ?? signal;
}

/** Disclaimer appended to actionable (trade) pushes. */
export const TG_FOOTER =
  '⚠️ Bukan saran finansial. Konfirmasi sendiri sebelum entry, pasang stop loss.';
