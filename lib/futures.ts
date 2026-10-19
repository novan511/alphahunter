/**
 * Futures desk engine: server side only.
 *
 * Fetches the fixed book from lib/futuresBook (see that file for why the split
 * exists), scores one LONG/SHORT/WAIT verdict per instrument on the requested
 * timeframe, and returns it with macro context.
 *
 * Everything trades on Hyperliquid: crypto perps on the core dex, and gold /
 * silver / oil / US equities as HIP-3 builder perps on the `xyz` dex. One venue
 * means one price feed, 24/7 bars, and native shorting for every line. Yahoo is
 * used only for macro context that has no liquid perp (DXY, VIX).
 */

import { Candle } from './types';
import { AssetRef, parseAssetId } from './marketData';
import { fetchAssetCandles } from './marketData';
import { fetchYahooChart } from './yahoo';
import { sma, ema, atr, clamp01 } from './algorithms/indicators';
import { fetchWithRetry } from './api';
import {
  FUTURES_BOOK,
  FUTURES_TIMEFRAMES,
  type FuturesGroup,
  type FuturesInstrument,
  type FuturesSignal,
  type AlignmentRow,
  type MacroSnapshot,
  type TimeframeDef,
  type Verdict,
} from './futuresBook';

export * from './futuresBook';

export const FUTURES_INSTRUMENTS: FuturesInstrument[] = FUTURES_BOOK.map((entry) => {
  const asset: AssetRef = parseAssetId(entry.rawId);
  return { ...entry, id: asset.id, asset };
});

const BAR_MS: Record<string, number> = {
  '5m': 300_000, '15m': 900_000, '1h': 3_600_000,
  '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
};

/**
 * Drop the trailing in-progress bar.
 *
 * The venue returns the currently-forming bar as the last element, and on an
 * intraday timeframe that bar has barely any volume yet — scoring it produced
 * "Volume 0.0x" on every 5m card, so the volume vote could never fire. Every
 * vote reads the last CLOSED bar instead.
 *
 * Display price deliberately does NOT use this: a 1d card must show the live
 * price, not yesterday's close. Scoring reads closed, display reads live.
 */
export function closedBars(candles: Candle[], tf: string): Candle[] {
  const barMs = BAR_MS[tf];
  if (!barMs || candles.length < 2) return candles;
  const last = candles[candles.length - 1];
  const age = Date.now() - last.time * 1000;
  return age >= 0 && age < barMs ? candles.slice(0, -1) : candles;
}

/** Close time of the bar the verdict was scored on. Dedupe keys off this. */
export function closedBarTime(candles: Candle[], tf: string): number {
  const closed = closedBars(candles, tf);
  const last = closed[closed.length - 1];
  return last ? last.time : 0;
}

/** Bars of history each timeframe needs for its own momentum lookback. */
const LOOKBACK_BARS: Record<string, number> = {
  '5m': 6, '15m': 8, '1h': 12, '4h': 10, '1d': 12, '1w': 12,
};

const MA_FAST: Record<string, number> = {
  '5m': 12, '15m': 16, '1h': 20, '4h': 20, '1d': 20, '1w': 13,
};
const MA_SLOW: Record<string, number> = {
  '5m': 30, '15m': 40, '1h': 50, '4h': 50, '1d': 50, '1w': 26,
};

/**
 * Long/short evidence from one timeframe, scored rather than decided by a
 * single rule: four independent votes, each worth 25 points, so a chart that
 * only agrees on two of four cannot print a signal.
 */
export function evaluateTimeframe(
  rawCandles: Candle[],
  tf: string
): { verdict: Verdict; score: number; reasons: string[]; changePct: number; atrPct: number } {
  const candles = closedBars(rawCandles, tf);
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const fast = ema(closes, MA_FAST[tf] ?? 20);
  const slow = sma(closes, MA_SLOW[tf] ?? 50);
  const atrPct = atr(candles, 14);
  const last = closes.length - 1;
  const lookback = LOOKBACK_BARS[tf] ?? 10;

  const price = closes[last];
  const reasons: string[] = [];
  let bull = 0;
  let bear = 0;

  // Vote 1 — MA structure (ema fast vs slow).
  const f = fast[last];
  const s = slow[last];
  const maSpread = f > 0 && s > 0 ? (f - s) / s : 0;
  if (maSpread > 0.002) {
    bull += 25;
    reasons.push(`EMA${MA_FAST[tf]} di atas MA${MA_SLOW[tf]} (+${(maSpread * 100).toFixed(2)}%) — struktur naik`);
  } else if (maSpread < -0.002) {
    bear += 25;
    reasons.push(`EMA${MA_FAST[tf]} di bawah MA${MA_SLOW[tf]} (${(maSpread * 100).toFixed(2)}%) — struktur turun`);
  } else {
    reasons.push('EMA fast dan slow berdempet — tanpa arah struktur');
  }

  // Vote 2 — momentum over the timeframe's own lookback.
  const prev = closes[last - lookback] ?? price;
  const changePct = prev > 0 ? (price - prev) / prev : 0;
  const momGate = tf === '5m' ? 0.004 : tf === '15m' ? 0.006 : tf === '1w' ? 0.03 : 0.012;
  if (changePct > momGate) {
    bull += 25;
    reasons.push(`Momentum ${lookback} bar +${(changePct * 100).toFixed(2)}%`);
  } else if (changePct < -momGate) {
    bear += 25;
    reasons.push(`Momentum ${lookback} bar ${(changePct * 100).toFixed(2)}%`);
  } else {
    reasons.push(`Momentum ${lookback} bar datar (${(changePct * 100).toFixed(2)}%)`);
  }

  // Vote 3 — volume expansion on the latest closed bar.
  const volWindow = volumes.slice(-21, -1);
  const avgVol = volWindow.length ? volWindow.reduce((a, b) => a + b, 0) / volWindow.length : 0;
  const volRatio = avgVol > 0 ? volumes[last] / avgVol : 1;
  if (volRatio > 1.2) {
    const dir = changePct >= 0 ? 'bull' : 'bear';
    if (dir === 'bull') bull += 25;
    else bear += 25;
    reasons.push(`Volume ${volRatio.toFixed(1)}x rata-rata — perp ${changePct >= 0 ? 'naik' : 'turun'} dengan volume`);
  } else if (volRatio < 0.8) {
    reasons.push(`Volume ${volRatio.toFixed(1)}x — belum ada partisipasi, sinyal belum kuat`);
  } else {
    reasons.push(`Volume ${volRatio.toFixed(1)}x normal`);
  }

  // Vote 4 — position inside the last N-bar range (impulse, not just drift).
  const range = candles.slice(-lookback);
  const hi = Math.max(...range.map((c) => c.high));
  const lo = Math.min(...range.map((c) => c.low));
  const pos = hi > lo ? (price - lo) / (hi - lo) : 0.5;
  if (pos > 0.7) {
    bull += 25;
    reasons.push(`Harga di ${(pos * 100).toFixed(0)}% rentang ${lookback} bar — mendekati high`);
  } else if (pos < 0.3) {
    bear += 25;
    reasons.push(`Harga di ${(pos * 100).toFixed(0)}% rentang ${lookback} bar — mendekati low`);
  } else {
    reasons.push(`Harga di tengah rentang (${(pos * 100).toFixed(0)}%) — belum ada dorongan`);
  }

  const aPct = atrPct[last] > 0 && price > 0 ? (atrPct[last] / price) * 100 : 0;
  const net = bull - bear;
  // Needs 2 of 4 votes and a net edge of at least 25 points.
  let verdict: Verdict = 'wait';
  if (bull >= 50 && net >= 25) verdict = 'long';
  else if (bear >= 50 && net <= -25) verdict = 'short';

  return { verdict, score: clamp01(Math.abs(net) / 100), reasons, changePct, atrPct: aPct };
}

/**
 * Macro read per instrument. Deliberately blunt: this is context a trader
 * argues with, not another scoring model — so it returns a sentence, not a
 * verdict adjustment.
 */
export function macroNoteFor(group: FuturesGroup, macro: MacroSnapshot): string {
  const dxyUp = macro.dxyChangePct != null && macro.dxyChangePct > 0.15;
  const dxyDown = macro.dxyChangePct != null && macro.dxyChangePct < -0.15;
  const yld = macro.us10y;
  const yldUp = yld != null && yld >= 4.2;
  const vix = macro.vix;
  const riskOff = vix != null && vix >= 20;

  if (group === 'commodity') {
    if (yldUp) return `Macro: yield AS ${yld?.toFixed(2)}% tinggi — emas & perak berat, kandidat short saat rally.`;
    if (dxyUp) return `Macro: DXY +${macro.dxyChangePct?.toFixed(2)}% — commodity dalam denominasi USD tertahan.`;
    if (dxyDown) return 'Macro: DXY melemah — mendukung long commodity.';
    return 'Macro: netral, tidak ada tekanan dari sisi macro.';
  }

  if (group === 'equity') {
    if (riskOff) return `Macro: VIX ${vix?.toFixed(1)} — risk-off, saham beta tinggi (NVDA/META) paling gampang kena selloff.`;
    if (yldUp) return `Macro: yield ${yld?.toFixed(2)}% — valuasi saham bertekanan, long butuh konfirmasi.`;
    if (dxyDown) return 'Macro: DXY melemah — angin belakang untuk saham.';
    if (dxyUp) return 'Macro: DXY menguat — outflow dari aset ber risiko, beware long.';
    return 'Macro: netral.';
  }

  // crypto
  if (riskOff && dxyUp) return `Macro: VIX ${vix?.toFixed(1)} + DXY menguat — risk-off klasik, biasanya tidak mendukung long.`;
  if (dxyDown) return 'Macro: DXY melemah — biasanya mendukung risk-on crypto.';
  if (dxyUp) return 'Macro: DXY menguat — perlu konfirmasi untuk long.';
  return 'Macro: netral.';
}

export interface LoadedFutures {
  signals: FuturesSignal[];
  macro: MacroSnapshot;
  fetchedAt: number;
  errors: string[];
}

/**
 * Run `fn` over every item with at most `limit` in flight, preserving order.
 *
 * Concurrency alone was not the problem — measured against the venue, ~180
 * requests/minute is the ceiling (a sustained 182/min run was clean, 171/min
 * started returning 429). Both guards are needed: a worker pool so a load does
 * not burst, and a per-minute budget so several loads cannot add up past the
 * ceiling. More retries would only hide it.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

const VENUE_CONCURRENCY = 6;
const VENUE_BUDGET_PER_MIN = 140;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sliding-window call log for the venue; module scope is intentional. */
let venueCalls: number[] = [];

/** Reserve one slot against the per-minute venue budget, waiting if needed. */
async function venueSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    venueCalls = venueCalls.filter((t) => now - t < 60_000);
    if (venueCalls.length < VENUE_BUDGET_PER_MIN) {
      venueCalls.push(now);
      return;
    }
    await sleep(60_000 - (now - venueCalls[0]) + 25);
  }
}

/**
 * Short-lived candle cache. Active-timeframe bars are the tradable ones and get
 * a short TTL; the alignment bars are daily/weekly and cannot move much, so
 * they are held longer. Without this, every tab switch spends the whole venue
 * budget again and the dashboard is the thing that pushes us into 429.
 */
const candleCache = new Map<string, { at: number; candles: Candle[] }>();
const ACTIVE_TTL_MS = 120_000;
const ALIGN_TTL_MS = 300_000;

async function venueCandles(
  asset: AssetRef,
  tf: string,
  bars: number,
  isActive: boolean
): Promise<Candle[]> {
  const key = `${asset.id}|${tf}|${bars}`;
  const hit = candleCache.get(key);
  const ttl = isActive ? ACTIVE_TTL_MS : ALIGN_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.candles;

  await venueSlot();
  const candles = await fetchAssetCandles(asset, tf, bars);
  // An empty or stub response must never be cached, or a rate-limited call
  // would poison the timeframe until the TTL expired.
  if (candles.length >= 20) candleCache.set(key, { at: Date.now(), candles });
  return candles;
}

/** Drop cached bars — used by the self-check and after a venue outage. */
export function clearFuturesCache(): void {
  candleCache.clear();
  venueCalls = [];
}

/**
 * Load the whole book for one timeframe: candles for the active timeframe per
 * instrument, a higher-timeframe alignment pass, then evaluate.
 *
 * Alignment is always the daily and the weekly regime, and only when they sit
 * above the active timeframe: 5m noise must never outvote the daily, and a
 * 1W view has nothing above it to defer to. Two rungs also keeps a load at
 * 39 venue calls instead of 65 — the venue starts refusing around 180/min, and
 * the dashboard is not allowed to be the thing that trips it.
 */
const ALIGNMENT_ORDER: string[] = ['1h', '4h', '1d', '1w'];

/**
 * Alignment returns every key timeframe except the active one, so each card can
 * show a holistic multi-timeframe direction strip (1H, 4H, 1D, 1W) instead of
 * forcing the trader to pick one timeframe and guess the rest.
 */
export function alignmentTimeframes(tf: string): string[] {
  return ALIGNMENT_ORDER.filter((t) => t !== tf);
}

/** Symbols the book expects but could not price — see FuturesResponse.missing. */
export function missingSymbols(loaded: Pick<LoadedFutures, 'signals'>): string[] {
  const priced = new Set(loaded.signals.map((s) => s.instrument.symbol));
  return FUTURES_BOOK.map((e) => e.symbol).filter((s) => !priced.has(s));
}

export async function loadFutures(tf: string): Promise<LoadedFutures> {
  const active = FUTURES_TIMEFRAMES.find((t) => t.tf === tf) ?? FUTURES_TIMEFRAMES[2];
  const alignTfs = alignmentTimeframes(active.tf);
  const errors: string[] = [];

  type Job = { instrument: FuturesInstrument; def: TimeframeDef; isActive: boolean };
  const jobs: Job[] = [];
  for (const instrument of FUTURES_INSTRUMENTS) {
    const need = [active, ...alignTfs.map((t) => FUTURES_TIMEFRAMES.find((x) => x.tf === t)!)]
      .filter((t): t is TimeframeDef => Boolean(t));
    // 1h/4h are also needed when the active tf is one of them.
    for (const def of Array.from(new Map(need.map((t) => [t.tf, t])).values())) {
      jobs.push({ instrument, def, isActive: def.tf === active.tf });
    }
  }

  const fetched = await mapLimit(jobs, VENUE_CONCURRENCY, async ({ instrument, def, isActive }) => ({
    instrument,
    tf: def.tf,
    candles: await venueCandles(instrument.asset, def.tf, def.bars, isActive),
  }));

  const byInstrument = new Map<string, Map<string, Candle[]>>();
  fetched.forEach((r, i) => {
    const { instrument } = jobs[i];
    let byTf = byInstrument.get(instrument.id);
    if (!byTf) {
      byTf = new Map();
      byInstrument.set(instrument.id, byTf);
    }
    if (r.status === 'fulfilled') {
      byTf.set(r.value.tf, r.value.candles);
    } else {
      errors.push(
        `${instrument.symbol} ${jobs[i].def.tf}: ${String(r.reason?.message ?? r.reason)}`
      );
    }
  });

  const macro = await loadMacro(errors);

  const signals: FuturesSignal[] = [];
  for (const instrument of FUTURES_INSTRUMENTS) {
    const candlesByTf = byInstrument.get(instrument.id) ?? new Map<string, Candle[]>();
    const candles = candlesByTf.get(active.tf) ?? [];
    if (candles.length < 40) {
      errors.push(`${instrument.symbol} ${active.tf}: candle kurang (${candles.length})`);
      continue;
    }

    const evalTf = evaluateTimeframe(candles, active.tf);
    const alignment: AlignmentRow[] = alignTfs.map((t) => {
      const c = candlesByTf.get(t) ?? [];
      const def = FUTURES_TIMEFRAMES.find((x) => x.tf === t);
      if (c.length < 40) {
        return { tf: t, label: def?.label ?? t, verdict: 'wait' as Verdict, score: 0 };
      }
      const e = evaluateTimeframe(c, t);
      return { tf: t, label: def?.label ?? t, verdict: e.verdict, score: e.score };
    });

    // A daily/weekly verdict pointing the other way is a warning, not a veto:
    // it is surfaced as a reason so the trader can size down.
    const blockers = alignment.filter(
      (a) => a.verdict !== 'wait' && evalTf.verdict !== 'wait' && a.verdict !== evalTf.verdict
    );
    const reasons = [...evalTf.reasons];
    if (blockers.length) {
      reasons.push(
        `⚠ HTF ${blockers.map((b) => b.label).join('/')} berlawanan arah (${blockers.map((b) => b.verdict.toUpperCase()).join(', ')}) — kecilkan size`
      );
    }

    let verdict = evalTf.verdict;
    let score = Math.round(clamp01(evalTf.score - blockers.length * 0.12) * 100);
    if (blockers.length >= 2 && verdict !== 'wait') {
      verdict = 'wait';
      reasons.push('Dua timeframe lebih tinggi berlawanan arah → wait, tunggu konfirmasi.');
    }

    // SL/TP anchor to the LIVE price with the ATR of the last closed bar: the
    // verdict was scored on closed bars (see closedBars), but a 1d card must
    // show today's price, not yesterday's close — otherwise SL/TP and the
    // displayed price disagree by a full day's move.
    const closed = closedBars(candles, active.tf);
    const shut = closed[closed.length - 1];
    const live = candles[candles.length - 1];
    const price = live.close;
    const aVal = atr(closed, 14);
    const a = aVal[aVal.length - 1] || price * 0.01;
    const dir = verdict === 'short' ? -1 : 1;

    signals.push({
      instrument,
      verdict,
      score,
      price,
      barTime: shut.time,
      changePct: evalTf.changePct,
      stop: verdict === 'wait' ? price : price - dir * active.stopAtr * a,
      target: verdict === 'wait' ? price : price + dir * active.targetAtr * a,
      atrPct: evalTf.atrPct,
      reasons,
      macroNote: macroNoteFor(instrument.group, macro),
      candles,
      alignment,
      lastSignal: lastFreshSignal(candles),
    });
  }

  return { signals, macro, fetchedAt: Date.now(), errors };
}

/**
 * Last bar whose body closed against the open — the marker drawn on the chart.
 * Deliberately body-based: wick-only bars are noise, not a decision.
 */
function lastFreshSignal(candles: Candle[]): { time: number; price: number; type: 'buy' | 'sell' } | null {
  for (let i = candles.length - 2; i >= Math.max(0, candles.length - 6); i--) {
    const c = candles[i];
    if (c.close > c.open) return { time: c.time, price: c.close, type: 'buy' };
    if (c.close < c.open) return { time: c.time, price: c.close, type: 'sell' };
  }
  return null;
}

const FRED_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';

/** FRED CSV needs no API key; the newest observation may be months old, so it is cached hard. */
async function fredSeries(seriesId: string): Promise<{ value: number; date: string } | null> {
  try {
    const res = await fetchWithRetry(`${FRED_URL}${seriesId}`, {}, 2, 400, 10000);
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split('\n');
    for (let i = lines.length - 1; i > 0; i--) {
      const [date, raw] = lines[i].split(',');
      const v = parseFloat(raw);
      if (Number.isFinite(v)) return { value: v, date };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * DXY and VIX come from Yahoo, not from the xyz perps of the same name: those
 * two markets are listed but trade so rarely that candleSnapshot returns [],
 * while Yahoo gives real daily history for both level and change.
 */
async function yahooChangePct(symbol: string): Promise<{ value: number; change: number } | null> {
  try {
    const candles = await fetchYahooChart(symbol, '1d', '1mo', { skipCache: true });
    if (candles.length < 3) return null;
    const close = candles[candles.length - 1].close;
    const prev = candles[candles.length - 2].close;
    if (!(prev > 0)) return null;
    return { value: close, change: ((close - prev) / prev) * 100 };
  } catch {
    return null;
  }
}

/** CPI is year-over-year: same month last year vs newest. */
function cpiYoY(series: string): number | null {
  const rows = series
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => {
      const [date, raw] = l.split(',');
      return { date, v: parseFloat(raw) };
    })
    .filter((r) => Number.isFinite(r.v));
  if (rows.length < 13) return null;
  const now = rows[rows.length - 1];
  const yearAgo = rows[rows.length - 13];
  if (yearAgo.v === 0) return null;
  return ((now.v - yearAgo.v) / yearAgo.v) * 100;
}

async function loadMacro(errors: string[]): Promise<MacroSnapshot> {
  const [dxy, vix, yields, fed, cpiRaw] = await Promise.all([
    yahooChangePct('DX-Y.NYB'),
    yahooChangePct('^VIX'),
    fredSeries('DGS10'),
    fredSeries('FEDFUNDS'),
    (async () => {
      try {
        const res = await fetchWithRetry(`${FRED_URL}CPIAUCSL`, {}, 2, 400, 10000);
        return res.ok ? await res.text() : null;
      } catch {
        return null;
      }
    })(),
  ]);

  if (!dxy) errors.push('macro: DXY gagal');
  if (!yields) errors.push('macro: US10Y (FRED DGS10) gagal');

  return {
    dxy: dxy?.value ?? null,
    dxyChangePct: dxy?.change ?? null,
    vix: vix?.value ?? null,
    vixChangePct: vix?.change ?? null,
    us10y: yields?.value ?? null,
    fedFunds: fed?.value ?? null,
    cpiYoY: cpiRaw ? cpiYoY(cpiRaw) : null,
    asOf: yields?.date ?? null,
    errors: [],
  };
}
