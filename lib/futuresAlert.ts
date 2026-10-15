/**
 * Futures alert decisions: what changed since the last push, and how to say it
 * on Telegram. Pure functions — no network, no clock, no env — so the rules
 * that decide whether a trader gets woken up are testable.
 */

import type { FuturesResponse, FuturesSignal, MacroSnapshot, Verdict } from './futuresBook';
import { GROUP_ORDER } from './futuresBook';

/** What the previous push saw for one symbol. */
export interface SymbolState {
  verdict: Verdict;
  /** Close time of the last CLOSED bar the verdict was scored on. */
  barTime: number;
  price: number;
}

export type AlertState = Record<string, SymbolState>;

export interface Alert {
  symbol: string;
  name: string;
  group: string;
  verdict: Verdict;
  score: number;
  price: number;
  stop: number;
  target: number;
  atrPct: number;
  barTime: number;
  /** Direction that changed, e.g. "short" when it flipped long -> short. */
  from: Verdict | null;
  reasons: string[];
  macroNote: string;
  alignment: { label: string; verdict: Verdict }[];
}

export interface AlertDiff {
  alerts: Alert[];
  next: AlertState;
  /** True when there is no previous state — this run is the baseline. */
  baseline: boolean;
  /** True when the book was incomplete and the run must not push. */
  blocked: boolean;
}

/** Close time of the bar the verdict was scored on — stored on the signal, never recomputed. */
function barTimeOf(signal: FuturesSignal): number {
  return signal.barTime || signal.candles[signal.candles.length - 1]?.time || 0;
}

/**
 * Which symbols deserve a message.
 *
 * An alert fires ONLY when the verdict CHANGES — wait -> long/short (new
 * thesis), long <-> short (flip), or long/short -> wait (stand down: the
 * trader holding that side must be told to exit). A steady signal never
 * re-alerts, however many bars close on it: re-confirming every hourly close
 * would send up to 300+ messages a day and train the trader to mute the bot,
 * which is how every later flip gets missed.
 *
 * The book must be complete: a partial load would look like "nothing changed"
 * for the missing symbols, which reads as "no signal" when it really means
 * "no data". That is the one miss this refuses to make.
 */
export function diffAlerts(
  response: Pick<FuturesResponse, 'tf' | 'signals' | 'missing'>,
  previous: AlertState | null
): AlertDiff {
  const next: AlertState = {};
  for (const s of response.signals) {
    next[s.instrument.symbol] = {
      verdict: s.verdict,
      barTime: barTimeOf(s),
      price: s.price,
    };
  }

  const blocked = response.missing.length > 0;
  const baseline = previous === null;
  if (blocked || baseline) {
    return { alerts: [], next, baseline, blocked };
  }

  const alerts: Alert[] = [];
  for (const signal of response.signals) {
    const symbol = signal.instrument.symbol;
    const barTime = barTimeOf(signal);
    const before = previous[symbol];

    // No history for this symbol: only a live side is worth mentioning.
    // A fresh wait is the default state of the world, not news.
    if (!before) {
      if (signal.verdict === 'wait') continue;
    } else if (before.verdict === signal.verdict) {
      continue;
    }

    alerts.push({
      symbol,
      name: signal.instrument.name,
      group: signal.instrument.group,
      verdict: signal.verdict,
      score: signal.score,
      price: signal.price,
      stop: signal.stop,
      target: signal.target,
      atrPct: signal.atrPct,
      barTime,
      from: before ? before.verdict : null,
      reasons: signal.reasons.filter((r) => !r.startsWith('⚠')).slice(0, 2),
      macroNote: signal.macroNote,
      alignment: signal.alignment.map((a) => ({ label: a.label, verdict: a.verdict })),
    });
  }

  // Grouped by desk, loudest first inside each desk: sorting purely by score
  // interleaved the group headers (CRYPTO / SAHAM / CRYPTO ...), which reads
  // as noise on a phone screen.
  const groupIdx = (g: string) => {
    const i = GROUP_ORDER.indexOf(g as (typeof GROUP_ORDER)[number]);
    return i < 0 ? 99 : i;
  };
  alerts.sort((a, b) => groupIdx(a.group) - groupIdx(b.group) || b.score - a.score);
  return { alerts, next, baseline: false, blocked: false };
}

function fmtPrice(n: number): string {
  const digits = n >= 1000 ? 1 : n >= 10 ? 2 : 3;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function macroLine(macro: MacroSnapshot): string {
  const bits: string[] = [];
  if (macro.dxy != null) {
    bits.push(
      `DXY ${macro.dxy.toFixed(2)}${
        macro.dxyChangePct != null ? ` (${macro.dxyChangePct >= 0 ? '+' : ''}${macro.dxyChangePct.toFixed(2)}%)` : ''
      }`
    );
  }
  if (macro.vix != null) bits.push(`VIX ${macro.vix.toFixed(1)}`);
  if (macro.us10y != null) bits.push(`US10Y ${macro.us10y.toFixed(2)}%`);
  return bits.join(' · ');
}

const GROUP_HEAD: Record<string, string> = {
  crypto: 'CRYPTO',
  commodity: 'KOMODITAS',
  equity: 'SAHAM US',
};

/** Plain text on purpose: no parse_mode, so a symbol can never break the send. */
export function buildAlertMessage(
  tf: string,
  alerts: Alert[],
  macro: MacroSnapshot,
  opts: { baseline?: boolean; missing?: string[] } = {}
): string {
  if (opts.baseline) {
    return [
      `📈 FUTURES — baseline ${tf.toUpperCase()}`,
      opts.missing?.length ? `⚠ book tidak lengkap: ${opts.missing.join(', ')}` : '',
      `Book dimuat, ${alerts.length} sinyal aktif dipantau dari sekarang.`,
      'Pesan berikutnya hanya dikirim saat arah BERUBAH (termasuk sinyal yang tutup).',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (alerts.length === 0) return '';

  const lines: string[] = [`📈 FUTURES ${tf.toUpperCase()} · ${new Date().toISOString().slice(11, 16)} UTC`];
  const ml = macroLine(macro);
  if (ml) lines.push(ml);
  lines.push('');

  let currentGroup = '';
  for (const a of alerts) {
    if (a.group !== currentGroup) {
      currentGroup = a.group;
      lines.push(`— ${GROUP_HEAD[a.group] ?? a.group} —`);
    }
    // WAIT means stand down: the previous side stopped working. It must read
    // as an exit, never as a short — the old code rendered every non-long as
    // "▼ SHORT", so a decayed long would have told the trader to short it.
    if (a.verdict === 'wait') {
      lines.push(`⏸ WAIT ${a.symbol} (dari ${a.from?.toUpperCase() ?? '?'}) · ${fmtPrice(a.price)} — sinyal tutup, jangan tambah posisi`);
      for (const r of a.reasons) lines.push(`  • ${r}`);
      lines.push('');
      continue;
    }
    const arrow = a.verdict === 'long' ? '▲ LONG' : '▼ SHORT';
    // First sighting after a wait is the common case and "(dari WAIT)" on
    // every line is noise — the flip suffix only earns its space on a real
    // reversal or an exit.
    const flip = a.from && a.from !== 'wait' && a.from !== a.verdict ? ` (dari ${a.from.toUpperCase()})` : '';
    lines.push(`${arrow} ${a.symbol}${flip} · ${fmtPrice(a.price)} · SL ${fmtPrice(a.stop)} · TP ${fmtPrice(a.target)} · conv ${a.score}`);
    for (const r of a.reasons) lines.push(`  • ${r}`);
    if (a.alignment.length) {
      lines.push(`  ${a.alignment.map((x) => `${x.label}:${x.verdict.toUpperCase()}`).join(' ')}`);
    }
    lines.push(`  ${a.macroNote}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Keep a message inside Telegram's 4000-char limit by dropping whole alerts,
 * never by cutting one in half.
 */
export function fitMessage(text: string, limit = 3900): string {
  if (text.length <= limit) return text;
  const blocks = text.split('\n\n');
  const header = blocks.slice(0, 2).join('\n\n');
  const kept: string[] = [];
  let length = header.length;
  for (const block of blocks.slice(2)) {
    if (length + block.length + 2 > limit) break;
    kept.push(block);
    length += block.length + 2;
  }
  const dropped = blocks.slice(2).length - kept.length;
  const tail = dropped > 0 ? `\n\n(+${dropped} sinyal lain, buka tab Futures)` : '';
  return header + (kept.length ? '\n\n' + kept.join('\n\n') : '') + tail;
}
