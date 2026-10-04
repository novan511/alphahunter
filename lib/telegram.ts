/**
 * Telegram client helpers (browser side).
 *
 * The browser never touches the bot token — it POSTs message text to
 * /api/notify-telegram, which holds the credentials server-side.
 *
 * Anti-spam rules, all client-side:
 *  1. Only severity 'high' warnings are sent (breakout / hot acceleration).
 *  2. Each warning id is sent at most once (persisted in localStorage).
 *  3. Sending only happens right after a scan finishes (the caller gates on
 *     that) — never on page load from cached history.
 */

import type { EarlyWarning } from './algorithms/earlyWarning';

const SENT_KEY = 'althunter:telegram-sent:v1';
const ENABLED_KEY = 'althunter:telegram-enabled:v1';
/** Cap on remembered ids so the buffer can't grow forever. */
const MAX_SENT = 300;

export function isTelegramEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    // Default ON — the server still no-ops when unconfigured, so a fresh
    // install without env vars sends nothing and reports it honestly.
    return window.localStorage.getItem(ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setTelegramEnabled(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}

function loadSent(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SENT_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveSent(s: Set<string>): void {
  try {
    window.localStorage.setItem(SENT_KEY, JSON.stringify(Array.from(s).slice(-MAX_SENT)));
  } catch {
    // ignore
  }
}

export async function checkTelegramConfigured(): Promise<boolean> {
  try {
    const res = await fetch('/api/notify-telegram');
    if (!res.ok) return false;
    const data = await res.json();
    return !!data?.configured;
  } catch {
    return false;
  }
}

export async function sendTelegramText(
  text: string
): Promise<{ ok: boolean; error?: string; configured?: boolean }> {
  try {
    const res = await fetch('/api/notify-telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: !!data?.ok, error: data?.error, configured: data?.configured };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch gagal' };
  }
}

/** One warning → compact Telegram block. Plain text, no markdown symbols. */
function formatWarning(w: EarlyWarning): string {
  const lines = [
    `${w.sectorIcon} ${w.title}`,
    w.detail,
  ];
  if (w.coins.length > 0) {
    const coins = w.coins
      .slice(0, 6)
      .map((c) => {
        if (c.source === 'watch') return `${c.ticker} (watchlist)`;
        return `${c.ticker} (${c.signal.replace('_', ' ')}, conf ${c.confluenceScore})`;
      })
      .join(', ');
    lines.push(`Koin: ${coins}`);
  }
  return lines.join('\n');
}

export function buildTelegramDigest(warnings: EarlyWarning[]): string {
  const head = 'ALERT ALTHUNTER — sektor mulai naik';
  return [head, '', ...warnings.map(formatWarning)].join('\n').slice(0, 3900);
}

/**
 * Send unsent high-severity warnings. Returns counts so the UI can confirm.
 * Never throws — notification must not break the scan flow.
 */
export async function notifyNewWarnings(
  warnings: EarlyWarning[]
): Promise<{ sent: number; skipped: number; error?: string }> {
  if (typeof window === 'undefined') return { sent: 0, skipped: warnings.length };
  if (!isTelegramEnabled()) return { sent: 0, skipped: warnings.length };

  const sent = loadSent();
  const fresh = warnings.filter((w) => w.severity === 'high' && !sent.has(w.id));
  if (fresh.length === 0) return { sent: 0, skipped: warnings.length };

  const digest = buildTelegramDigest(fresh);
  const result = await sendTelegramText(digest);
  if (!result.ok) {
    return { sent: 0, skipped: warnings.length, error: result.error };
  }
  fresh.forEach((w) => sent.add(w.id));
  saveSent(sent);
  return { sent: fresh.length, skipped: warnings.length - fresh.length };
}
