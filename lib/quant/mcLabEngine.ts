/**
 * Mesin Monte Carlo otonom untuk halaman /backtest.
 *
 * Tiga lapis yang harus dipisahkan dengan jelas:
 *   1. Data    — candle panjang (Yahoo sejak 2000, Binance deep, Hyperliquid).
 *   2. Aturan  — keluarga sinyal deterministik; parameter dari AI hanya masuk
 *                lewat clampParams di mcLabSpec.
 *   3. Penilaian — walk-forward out-of-sample + bootstrap Monte Carlo.
 *
 * Tidak ada lookahead: sinyal dihitung dari bar yang sudah tutup, eksekusi di
 * open bar berikutnya, stop/target diperiksa di dalam bar.
 */

import { Candle } from '../types';
import { parseAssetId } from '../marketData';
import { fetchBinanceKlines } from '../api';
import { readCandleCache, writeCandleCache } from '../candleCache';
import { fetchWithRetry } from '../api';
import { atr, ema, rsi, sma, standardDeviation, maxDrawdown, sharpeRatio } from '../algorithms/indicators';
import { findPivots } from '../algorithms/marketStructure';
import type { LabParams, LabProposal, LabFamily, LabInterval, MacroFilter } from './mcLabSpec';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const LIMIT_BY_INTERVAL: Record<LabInterval, number> = {
  '1h': 4000,
  '4h': 6000,
  '1d': 7000,
  '1w': 1500,
};

function yahooInterval(interval: LabInterval): string {
  return interval === '1w' ? '1wk' : interval === '4h' ? '1h' : interval;
}

/** Agregasi candle ke bucket lebih besar (dipakai untuk 4h dari data 1h Yahoo). */
function resample(candles: Candle[], bucketSeconds: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const bucket = Math.floor(c.time / bucketSeconds) * bucketSeconds;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ ...c, time: bucket });
    }
  }
  return out;
}

/**
 * Yahoo penuh sejak 2000. `range=max` tidak bisa dipercaya (GC=F hanya
 * mengembalikan 269 bar), jadi rentang diminta eksplisit lewat period1/period2.
 * Batas nyata: intraday hanya ~730 hari, mingguan/harian sejak 2000.
 */
async function fetchYahooHistory(symbol: string, interval: LabInterval): Promise<Candle[]> {
  const yi = yahooInterval(interval);
  const key = `mclab-yahoo|${symbol}|${yi}|${interval === '4h' ? '4h' : 'raw'}`;
  const cached = readCandleCache(key);
  if (cached && cached.length > 0) return cached;

  const now = Math.floor(Date.now() / 1000);
  const from = interval === '1h' || interval === '4h' ? now - 730 * 86400 : 946684800;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${yi}&period1=${from}&period2=${now}`;

  const res = await fetchWithRetry(
    url,
    { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' } },
    3,
    600,
    20_000
  );
  if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result?.timestamp || !result?.indicators?.quote?.[0]) {
    throw new Error(`Yahoo ${symbol}: data kosong`);
  }
  const q = result.indicators.quote[0];
  let out: Candle[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ time: result.timestamp[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] || 0 });
  }
  // Yahoo tidak punya 4h; agregasi dari 1h supaya timeframe tetap dihormati.
  if (interval === '4h') out = resample(out, 4 * 3600);
  if (out.length > 0) writeCandleCache(key, out, 12 * 3600_000);
  return out;
}

export async function loadLabCandles(assetId: string, interval: LabInterval): Promise<Candle[]> {
  const ref = parseAssetId(assetId);
  const limit = LIMIT_BY_INTERVAL[interval];

  if (ref.source === 'yahoo') return fetchYahooHistory(ref.symbol, interval);
  if (ref.source === 'binance') {
    return fetchBinanceKlines(ref.symbol, interval, limit, {
      deep: true,
      maxPages: Math.ceil(limit / 1000) + 2,
    });
  }
  // Gate / Hyperliquid: endpoint yang ada sudah mengembalikan sebanyak yang
  // venue izinkan (HL maks 5000 bar terakhir).
  const { fetchAssetCandles } = await import('../marketData');
  return fetchAssetCandles(ref, interval, Math.min(limit, 5000), { deep: true });
}

// ---------------------------------------------------------------------------
// Makro historis (FRED)
// ---------------------------------------------------------------------------

export interface MacroPoint {
  t: number; // detik
  v: number;
}

const FRED_SERIES: Record<string, string> = {
  vix: 'VIXCLS',
  fed: 'DFF',
  curve: 'T10Y2Y',
};

/** FRED CSV → titik harian berurutan. Cache 12 jam di disk. */
export async function fetchFredSeries(name: 'vix' | 'fed' | 'curve'): Promise<MacroPoint[]> {
  const id = FRED_SERIES[name];
  const key = `mclab-fred|${id}`;
  const cached = readCandleCache(key);
  if (cached && cached.length > 0) {
    return cached.map((c) => ({ t: c.time, v: c.close }));
  }
  const res = await fetchWithRetry(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`,
    {},
    3,
    800,
    20_000
  );
  if (!res.ok) throw new Error(`FRED ${id} HTTP ${res.status}`);
  const text = await res.text();
  const out: MacroPoint[] = [];
  for (const line of text.trim().split('\n').slice(1)) {
    const [date, raw] = line.split(',');
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) continue;
    const t = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
    if (Number.isFinite(t)) out.push({ t, v });
  }
  out.sort((a, b) => a.t - b.t);
  if (out.length > 0) {
    writeCandleCache(
      key,
      out.map((p) => ({ time: p.t, open: p.v, high: p.v, low: p.v, close: p.v, volume: 0 })),
      12 * 3600_000
    );
  }
  return out;
}

function valueAt(points: MacroPoint[], time: number): number | null {
  if (points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= time) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 ? points[best].v : null;
}

/**
 * Gerbang makro per bar. `null` berarti data belum ada di tanggal itu (mis.
 * VIX sebelum 1990) — bar seperti itu diloloskan dan dihitung terpisah supaya
 * filter tidak diam-diam membuang awal sampel.
 */
export function macroAllows(
  filter: MacroFilter,
  points: { vix?: MacroPoint[]; fed?: MacroPoint[]; curve?: MacroPoint[] },
  time: number
): boolean {
  if (filter === 'none') return true;
  if (filter === 'vix_low' || filter === 'vix_high') {
    const v = valueAt(points.vix || [], time);
    if (v == null) return true;
    return filter === 'vix_low' ? v < 20 : v > 25;
  }
  if (filter === 'fed_easing' || filter === 'fed_tightening') {
    const now = valueAt(points.fed || [], time);
    const before = valueAt(points.fed || [], time - 90 * 86400);
    if (now == null || before == null) return true;
    return filter === 'fed_easing' ? now < before : now > before;
  }
  const c = valueAt(points.curve || [], time);
  if (c == null) return true;
  return filter === 'curve_inverted' ? c < 0 : c > 0;
}

export function macroSeriesNeeded(filter: MacroFilter): Array<'vix' | 'fed' | 'curve'> {
  if (filter === 'vix_low' || filter === 'vix_high') return ['vix'];
  if (filter === 'fed_easing' || filter === 'fed_tightening') return ['fed'];
  if (filter === 'curve_inverted' || filter === 'curve_positive') return ['curve'];
  return [];
}

// ---------------------------------------------------------------------------
// Generator sinyal
// ---------------------------------------------------------------------------

export type Side = 'buy' | 'sell';

export interface RawSignal {
  index: number;
  side: Side;
  note: string;
}

function crossUp(a: number[], b: number[], i: number): boolean {
  return i > 0 && Number.isFinite(a[i]) && Number.isFinite(b[i]) && a[i - 1] <= b[i - 1] && a[i] > b[i];
}

function crossDown(a: number[], b: number[], i: number): boolean {
  return i > 0 && Number.isFinite(a[i]) && Number.isFinite(b[i]) && a[i - 1] >= b[i - 1] && a[i] < b[i];
}

/**
 * Sinyal per keluarga. Semua memakai data hingga bar i (tutup); eksekusi di
 * open bar i+1 dilakukan oleh simulator, bukan di sini.
 */
export function generateSignals(
  candles: Candle[],
  family: LabFamily,
  p: LabParams,
  benchmark?: Candle[]
): RawSignal[] {
  const closes = candles.map((c) => c.close);
  const out: RawSignal[] = [];
  const n = closes.length;

  if (family === 'trend') {
    const fast = ema(closes, p.fast);
    const slow = ema(closes, p.slow);
    const r = rsi(closes, p.rsiPeriod);
    for (let i = p.slow + 1; i < n; i++) {
      if (crossUp(fast, slow, i) && (!Number.isFinite(r[i]) || r[i] > p.rsiSell)) {
        out.push({ index: i, side: 'buy', note: `EMA${p.fast} cross di atas EMA${p.slow}` });
      } else if (p.allowShort && crossDown(fast, slow, i) && (!Number.isFinite(r[i]) || r[i] < p.rsiBuy)) {
        out.push({ index: i, side: 'sell', note: `EMA${p.fast} cross di bawah EMA${p.slow}` });
      }
    }
    return out;
  }

  if (family === 'momentum') {
    const r = rsi(closes, p.rsiPeriod);
    for (let i = p.rocPeriod + 1; i < n; i++) {
      const roc = (closes[i] - closes[i - p.rocPeriod]) / closes[i - p.rocPeriod];
      if (roc >= p.rocThreshold && r[i] >= p.rsiBuy) {
        out.push({ index: i, side: 'buy', note: `ROC ${p.rocPeriod} ${(roc * 100).toFixed(1)}% + RSI ${r[i].toFixed(0)}` });
      } else if (p.allowShort && roc <= -p.rocThreshold && r[i] <= p.rsiSell) {
        out.push({ index: i, side: 'sell', note: `ROC ${p.rocPeriod} ${(roc * 100).toFixed(1)}% + RSI ${r[i].toFixed(0)}` });
      }
    }
    return out;
  }

  if (family === 'breakout') {
    for (let i = p.donchian + 1; i < n; i++) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - p.donchian; j < i; j++) {
        if (candles[j].high > hi) hi = candles[j].high;
        if (candles[j].low < lo) lo = candles[j].low;
      }
      if (closes[i] > hi) {
        out.push({ index: i, side: 'buy', note: `breakout ${p.donchian} bar` });
      } else if (p.allowShort && closes[i] < lo) {
        out.push({ index: i, side: 'sell', note: `breakdown ${p.donchian} bar` });
      }
    }
    return out;
  }

  if (family === 'meanrev') {
    const ma = sma(closes, p.slow);
    const sd = standardDeviation(closes, p.slow);
    for (let i = p.slow + 1; i < n; i++) {
      if (!Number.isFinite(ma[i]) || !Number.isFinite(sd[i]) || sd[i] <= 0) continue;
      const z = (closes[i] - ma[i]) / sd[i];
      if (z <= -p.zEntry) {
        out.push({ index: i, side: 'buy', note: `z ${z.toFixed(2)} di bawah -${p.zEntry}` });
      } else if (p.allowShort && z >= p.zEntry) {
        out.push({ index: i, side: 'sell', note: `z ${z.toFixed(2)} di atas ${p.zEntry}` });
      }
    }
    return out;
  }

  if (family === 'rs') {
    if (!benchmark || benchmark.length < 30) return out;
    const len = Math.min(candles.length, benchmark.length);
    const a = candles.slice(-len);
    const b = benchmark.slice(-len);
    const ratio = a.map((c, i) => c.close / b[i].close);
    const z = (() => {
      const period = Math.max(10, Math.min(p.slow, 120));
      const mean = sma(ratio, period);
      const sd = standardDeviation(ratio, period);
      return ratio.map((v, i) =>
        Number.isFinite(mean[i]) && Number.isFinite(sd[i]) && sd[i] > 0 ? (v - mean[i]) / sd[i] : NaN
      );
    })();
    const ma = sma(a.map((c) => c.close), p.fast);
    const offset = candles.length - len;
    for (let i = Math.max(p.slow, 30); i < len; i++) {
      if (!Number.isFinite(z[i])) continue;
      const priceAbove = a[i].close > ma[i];
      if (z[i] >= p.zEntry && priceAbove) {
        out.push({ index: i + offset, side: 'buy', note: `RS z ${z[i].toFixed(2)} + harga di atas MA${p.fast}` });
      } else if (p.allowShort && z[i] <= -p.zEntry && a[i].close < ma[i]) {
        out.push({ index: i + offset, side: 'sell', note: `RS z ${z[i].toFixed(2)} + harga di bawah MA${p.fast}` });
      }
    }
    return out;
  }

  // pattern: level dari pivot yang SUDAH terkonfirmasi (index <= i-2), lalu
  // breakout close terhadap level dengan sentuhan >= minTouches.
  const pivots = findPivots(candles, 2);
  const atrSeries = atr(candles, 14);
  for (let i = 30; i < n; i++) {
    const a = atrSeries[i];
    if (!Number.isFinite(a) || a <= 0) continue;
    const recent = pivots.filter((pv) => pv.index <= i - 2 && pv.index >= i - 300);
    if (recent.length < p.minTouches) continue;
    const tol = a * 0.5;
    const levels: Array<{ price: number; touches: number }> = [];
    for (const pv of recent) {
      const hit = levels.find((l) => Math.abs(l.price - pv.price) <= tol);
      if (hit) {
        hit.price = (hit.price * hit.touches + pv.price) / (hit.touches + 1);
        hit.touches += 1;
      } else {
        levels.push({ price: pv.price, touches: 1 });
      }
    }
    const prev = closes[i - 1];
    for (const l of levels) {
      if (l.touches < p.minTouches) continue;
      if (prev <= l.price && closes[i] > l.price) {
        out.push({ index: i, side: 'buy', note: `breakout level ${l.touches} sentuhan` });
        break;
      }
      if (p.allowShort && prev >= l.price && closes[i] < l.price) {
        out.push({ index: i, side: 'sell', note: `breakdown level ${l.touches} sentuhan` });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Simulasi
// ---------------------------------------------------------------------------

export interface TradeRecord {
  entryTime: number;
  exitTime: number;
  side: Side;
  entry: number;
  exit: number;
  /** Harga stop & target saat entry — dipakai UI untuk menggambar kotak setup. */
  stop: number;
  target: number;
  bars: number;
  pnlPct: number;
  rMultiple: number;
  exitReason: 'stop' | 'target' | 'time' | 'end';
}

export interface SegmentMetrics {
  trades: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  buyHoldPct: number;
  exposurePct: number;
  bars: number;
}

export interface McResult {
  iterations: number;
  probProfit: number;
  p5Pct: number;
  p50Pct: number;
  p95Pct: number;
  worstPct: number;
  bestPct: number;
}

export interface BacktestOutput {
  full: SegmentMetrics;
  oos: SegmentMetrics[];
  oosPositive: number;
  mc: McResult;
  trades: TradeRecord[];
  equity: Array<{ time: number; equity: number }>;
  filterBlockedPct: number;
  dataFrom: number;
  dataTo: number;
  bars: number;
}

const FEE = 0.0005;
const SLIP = 0.0005;
const RISK_PER_TRADE = 0.01;

function emptyMetrics(bars: number): SegmentMetrics {
  return {
    trades: 0,
    winRate: 0,
    profitFactor: 0,
    expectancyR: 0,
    totalReturnPct: 0,
    cagrPct: 0,
    maxDrawdownPct: 0,
    sharpe: 0,
    buyHoldPct: 0,
    exposurePct: 0,
    bars,
  };
}

function barsPerYear(interval: LabInterval, isYahoo: boolean): number {
  if (interval === '1h') return 8760;
  if (interval === '4h') return 2190;
  if (interval === '1w') return 52;
  return isYahoo ? 252 : 365;
}

interface SimOptions {
  fromIdx: number;
  toIdx: number;
  params: LabParams;
  signals: RawSignal[];
  atrSeries: number[];
  candles: Candle[];
  interval: LabInterval;
  isYahoo: boolean;
  macroOk: boolean[] | null;
}

/**
 * Satu lintasan ekuitas. Posisi tunggal per aset (ini uji aturan, bukan
 * portofolio), ukuran risiko tetap 1% per trade supaya R bisa dibandingkan.
 */
function simulate(o: SimOptions): { metrics: SegmentMetrics; trades: TradeRecord[]; equity: number[] } {
  const { candles, signals, atrSeries, params } = o;
  const equity: number[] = [];
  const trades: TradeRecord[] = [];
  let cash = 1;
  let pos: {
    side: Side;
    entry: number;
    stop: number;
    target: number;
    risk: number;
    entryIdx: number;
  } | null = null;
  let barsInMarket = 0;

  const signalAt = new Map<number, RawSignal>();
  for (const s of signals) if (!signalAt.has(s.index)) signalAt.set(s.index, s);

  const startPrice = candles[o.fromIdx]?.close || 0;

  for (let i = o.fromIdx; i <= o.toIdx; i++) {
    const c = candles[i];
    if (!c) break;

    // 1) Entry di OPEN bar ini dari sinyal bar sebelumnya. Dilakukan SEBELUM
    //    manajemen posisi supaya stop/target bar entry ikut diperiksa — kalau
    //    tidak, posisi baru selalu aman satu bar (bias optimistis).
    if (!pos) {
      const sig = signalAt.get(i - 1);
      const atrNow = atrSeries[i];
      const allowed = !o.macroOk || o.macroOk[i];
      if (sig && allowed && Number.isFinite(atrNow) && atrNow > 0) {
        const raw = c.open || c.close;
        if (raw > 0) {
          const entry = raw * (sig.side === 'buy' ? 1 + SLIP : 1 - SLIP);
          const risk = params.atrStop * atrNow;
          if (risk > 0 && risk / entry < 0.5) {
            pos = {
              side: sig.side,
              entry,
              stop: sig.side === 'buy' ? entry - risk : entry + risk,
              target: sig.side === 'buy' ? entry + params.atrTarget * atrNow : entry - params.atrTarget * atrNow,
              risk,
              entryIdx: i,
            };
          }
        }
      }
    }

    // 2) Manajemen posisi pada bar ini (termasuk yang baru dibuka).
    if (pos) {
      barsInMarket++;
      let exitPrice: number | null = null;
      let reason: TradeRecord['exitReason'] = 'time';

      if (pos.side === 'buy') {
        if (c.low <= pos.stop) {
          exitPrice = pos.stop;
          reason = 'stop';
        } else if (c.high >= pos.target) {
          exitPrice = pos.target;
          reason = 'target';
        }
      } else {
        if (c.high >= pos.stop) {
          exitPrice = pos.stop;
          reason = 'stop';
        } else if (c.low <= pos.target) {
          exitPrice = pos.target;
          reason = 'target';
        }
      }
      if (exitPrice == null && i - pos.entryIdx >= params.maxHold) {
        exitPrice = c.close;
        reason = 'time';
      }

      if (exitPrice != null) {
        const fill = exitPrice * (pos.side === 'buy' ? 1 - SLIP : 1 + SLIP);
        const gross = pos.side === 'buy' ? (fill - pos.entry) / pos.entry : (pos.entry - fill) / pos.entry;
        const net = gross - 2 * FEE;
        const r = pos.risk > 0 ? (net * pos.entry) / pos.risk : 0;
        // Ukuran posisi: risiko 1% ekuitas per trade, jadi PnL = 1% × R.
        cash *= 1 + r * RISK_PER_TRADE;
        trades.push({
          entryTime: candles[pos.entryIdx].time,
          exitTime: c.time,
          side: pos.side,
          entry: pos.entry,
          exit: fill,
          stop: pos.stop,
          target: pos.target,
          bars: i - pos.entryIdx,
          pnlPct: net * 100,
          rMultiple: r,
          exitReason: reason,
        });
        pos = null;
      }
    }

    // Mark-to-market supaya kurva ekuitas mencerminkan posisi terbuka.
    let mtm = cash;
    if (pos) {
      const px = c.close;
      const gross = pos.side === 'buy' ? (px - pos.entry) / pos.entry : (pos.entry - px) / pos.entry;
      mtm = cash * (1 + (gross * pos.entry / pos.risk) * RISK_PER_TRADE);
    }
    equity.push(mtm);
  }

  // Tutup posisi yang masih terbuka di bar terakhir supaya angkanya utuh.
  if (pos) {
    const c = candles[o.toIdx];
    const fill = c.close * (pos.side === 'buy' ? 1 - SLIP : 1 + SLIP);
    const gross = pos.side === 'buy' ? (fill - pos.entry) / pos.entry : (pos.entry - fill) / pos.entry;
    const net = gross - 2 * FEE;
    const rEnd = pos.risk > 0 ? (net * pos.entry) / pos.risk : 0;
    cash *= 1 + rEnd * RISK_PER_TRADE;
    trades.push({
      entryTime: candles[pos.entryIdx].time,
      exitTime: c.time,
      side: pos.side,
      entry: pos.entry,
      exit: fill,
      stop: pos.stop,
      target: pos.target,
      bars: o.toIdx - pos.entryIdx,
      pnlPct: net * 100,
      rMultiple: pos.risk > 0 ? (net * pos.entry) / pos.risk : 0,
      exitReason: 'end',
    });
    if (equity.length) equity[equity.length - 1] = cash;
  }

  const bars = Math.max(1, o.toIdx - o.fromIdx + 1);
  const endPrice = candles[o.toIdx]?.close || startPrice;
  const buyHold = startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : 0;
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i - 1] > 0) rets.push((equity[i] - equity[i - 1]) / equity[i - 1]);
  }
  const { maxDD } = maxDrawdown(equity.length ? equity : [1]);
  const years = bars / barsPerYear(o.interval, o.isYahoo);
  const total = (cash - 1) * 100;
  const cagr = years > 0 && cash > 0 ? (Math.pow(cash, 1 / years) - 1) * 100 : 0;

  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlPct, 0));

  return {
    metrics: {
      trades: trades.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
      expectancyR: trades.length ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : 0,
      totalReturnPct: total,
      cagrPct: cagr,
      maxDrawdownPct: maxDD * 100,
      sharpe: sharpeRatio(rets) * Math.sqrt(barsPerYear(o.interval, o.isYahoo)),
      buyHoldPct: buyHold,
      exposurePct: (barsInMarket / bars) * 100,
      bars,
    },
    trades,
    equity,
  };
}

/** Bootstrap trade R-multiples: sebaran hasil kalau urutan trade berbeda. */
export function monteCarlo(trades: TradeRecord[], iterations = 300): McResult {
  if (trades.length < 5) {
    return { iterations: 0, probProfit: 0, p5Pct: 0, p50Pct: 0, p95Pct: 0, worstPct: 0, bestPct: 0 };
  }
  const r = trades.map((t) => t.rMultiple);
  const finals: number[] = [];
  for (let k = 0; k < iterations; k++) {
    let eq = 1;
    for (let j = 0; j < r.length; j++) {
      const pick = r[Math.floor(Math.random() * r.length)];
      eq *= 1 + pick * RISK_PER_TRADE;
      if (eq <= 0) {
        eq = 0;
        break;
      }
    }
    finals.push((eq - 1) * 100);
  }
  finals.sort((a, b) => a - b);
  const at = (q: number) => finals[Math.min(finals.length - 1, Math.floor(q * finals.length))];
  return {
    iterations,
    probProfit: finals.filter((f) => f > 0).length / finals.length,
    p5Pct: at(0.05),
    p50Pct: at(0.5),
    p95Pct: at(0.95),
    worstPct: finals[0],
    bestPct: finals[finals.length - 1],
  };
}

export interface RunOptions {
  proposal: LabProposal;
  onStage?: (stage: string, progress: number) => Promise<void> | void;
}

export interface RunOutput extends BacktestOutput {
  asset: string;
  interval: LabInterval;
  family: LabFamily;
  macroFilter: MacroFilter;
  params: LabParams;
  benchmark: string | null;
  notes: string[];
}

const BENCHMARK_FOR: Record<string, string> = {
  binance: 'binance:BTCUSDT',
  hyperliquid: 'hyperliquid:BTC',
  yahoo: 'yahoo:SPY',
};

export async function runLabExperiment(o: RunOptions): Promise<RunOutput> {
  const { proposal } = o;
  const stage = async (s: string, p: number) => {
    if (o.onStage) await o.onStage(s, p);
  };

  await stage('Memuat data harga', 10);
  const ref = parseAssetId(proposal.asset);
  const candles = await loadLabCandles(proposal.asset, proposal.interval);
  if (candles.length < 120) {
    throw new Error(`data ${proposal.asset} hanya ${candles.length} bar — tidak cukup untuk ${proposal.interval}`);
  }

  const notes: string[] = [];
  if (candles.length < 500) {
    notes.push(`riwayat ${proposal.asset} terbatas (${candles.length} bar) — venue baru mencantumkan aset ini`);
  }

  await stage('Menghitung indikator', 25);
  const atrSeries = atr(candles, 14);

  let benchmark: Candle[] | null = null;
  let benchmarkId: string | null = null;
  if (proposal.family === 'rs') {
    benchmarkId = BENCHMARK_FOR[ref.source] || null;
    if (benchmarkId) {
      try {
        benchmark = await loadLabCandles(benchmarkId, proposal.interval);
      } catch {
        notes.push(`benchmark ${benchmarkId} gagal dimuat — keluarga RS dilewati`);
      }
    }
  }

  await stage('Membangun sinyal', 40);
  const signals = generateSignals(candles, proposal.family, proposal.params, benchmark || undefined);
  if (signals.length === 0) {
    notes.push('aturan ini tidak menghasilkan satu pun sinyal pada data ini');
  }

  await stage('Menerapkan filter makro', 50);
  const needed = macroSeriesNeeded(proposal.macroFilter);
  const macroPoints: { vix?: MacroPoint[]; fed?: MacroPoint[]; curve?: MacroPoint[] } = {};
  for (const s of needed) {
    try {
      macroPoints[s] = await fetchFredSeries(s);
    } catch {
      notes.push(`FRED ${s} tidak tersedia — filter makro dilewati`);
    }
  }
  const macroOk =
    proposal.macroFilter === 'none' || needed.length === 0
      ? null
      : candles.map((c) => macroAllows(proposal.macroFilter, macroPoints, c.time));

  const filterBlockedPct =
    macroOk == null ? 0 : (macroOk.filter((v) => !v).length / Math.max(1, macroOk.length)) * 100;

  await stage('Backtest penuh', 60);
  const isYahoo = ref.source === 'yahoo';
  const full = simulate({
    fromIdx: 0,
    toIdx: candles.length - 1,
    params: proposal.params,
    signals,
    atrSeries,
    candles,
    interval: proposal.interval,
    isYahoo,
    macroOk,
  });

  await stage('Walk-forward out-of-sample', 72);
  const n = candles.length;
  const warmup = Math.floor(n * 0.3);
  const rest = n - warmup;
  const windows = 3;
  const chunk = Math.floor(rest / windows);
  const oos: SegmentMetrics[] = [];
  for (let w = 0; w < windows; w++) {
    const from = warmup + w * chunk;
    const to = w === windows - 1 ? n - 1 : warmup + (w + 1) * chunk - 1;
    if (to - from < 30) continue;
    const seg = simulate({
      fromIdx: from,
      toIdx: to,
      params: proposal.params,
      signals,
      atrSeries,
      candles,
      interval: proposal.interval,
      isYahoo,
      macroOk,
    });
    oos.push(seg.metrics);
  }
  const oosPositive = oos.filter((m) => m.totalReturnPct > 0 && m.profitFactor >= 1).length;

  await stage('Monte Carlo bootstrap', 85);
  const mc = monteCarlo(full.trades, 300);

  return {
    asset: proposal.asset,
    interval: proposal.interval,
    family: proposal.family,
    macroFilter: proposal.macroFilter,
    params: proposal.params,
    benchmark: benchmarkId,
    notes,
    full: full.metrics,
    oos,
    oosPositive,
    mc,
    trades: full.trades,
    equity: full.equity.map((e, i) => ({
      time: candles[i]?.time ?? 0,
      equity: Math.round(e * 10000) / 10000,
    })),
    filterBlockedPct,
    dataFrom: candles[0].time,
    dataTo: candles[candles.length - 1].time,
    bars: candles.length,
  };
}

// ---------------------------------------------------------------------------
// Putusan
// ---------------------------------------------------------------------------

export type Verdict = 'strong' | 'promising' | 'weak' | 'none';

export interface Judgement {
  verdict: Verdict;
  score: number;
  reasons: string[];
}

/**
 * Putusan sengaja konservatif dan berbasis OOS. Return besar dengan PF tinggi
 * di satu jendela tapi negatif di jendela lain bukan temuan — itu kebetulan.
 *
 * Skor dibatasi oleh ukuran sampel: PF 4 dari 30 trade bukan bukti sekuat PF 1,6
 * dari 300 trade, jadi trade < 60 memotong plafon skor secara eksplisit.
 */
export function judge(r: BacktestOutput): Judgement {
  const reasons: string[] = [];
  const oosTotal = r.oos.length;
  const consistency = oosTotal > 0 ? r.oosPositive / oosTotal : 0;
  const avgPf = r.oos.length ? r.oos.reduce((a, m) => a + m.profitFactor, 0) / r.oos.length : 0;
  const avgExp = r.oos.length ? r.oos.reduce((a, m) => a + m.expectancyR, 0) / r.oos.length : 0;

  if (r.full.trades < 20) {
    reasons.push(`hanya ${r.full.trades} trade — sampel terlalu kecil untuk disimpulkan`);
    return { verdict: 'none', score: 0, reasons };
  }
  if (consistency < 0.5) {
    reasons.push(`hanya ${r.oosPositive}/${oosTotal} jendela OOS yang positif`);
    return { verdict: 'none', score: Math.round(consistency * 40), reasons };
  }

  let score = 0;
  score += consistency * 35;
  // PF di atas ~2,5 pada sampel menengah biasanya artefak stop sempit, bukan edge.
  score += Math.min(22, Math.max(0, (Math.min(avgPf, 2.5) - 1) * 28));
  score += Math.min(18, Math.max(0, avgExp * 35));
  score += r.mc.probProfit * 15;
  if (r.full.maxDrawdownPct > 30) score -= 10;
  if (r.full.exposurePct < 5) score -= 5;

  // Plafon sampel: 20 trade = 45, 40 = 65, 60+ = 85, 120+ = 100.
  const sampleCap = Math.min(100, 25 + r.full.trades * 0.65);
  const capped = Math.min(score, sampleCap);

  reasons.push(`OOS positif ${r.oosPositive}/${oosTotal}, PF rata-rata ${avgPf.toFixed(2)}, expectancy ${avgExp.toFixed(2)}R`);
  reasons.push(`MC bootstrap: peluang profit ${(r.mc.probProfit * 100).toFixed(0)}%, median ${r.mc.p50Pct.toFixed(1)}%`);
  reasons.push(`sampel ${r.full.trades} trade → plafon skor ${Math.round(sampleCap)}`);
  if (r.full.maxDrawdownPct > 30) reasons.push(`drawdown penuh ${r.full.maxDrawdownPct.toFixed(1)}% — terlalu dalam`);

  const verdict: Verdict =
    capped >= 65 && consistency >= 0.66 && avgPf >= 1.3 && r.full.trades >= 40
      ? 'strong'
      : capped >= 45 && consistency >= 0.66 && avgPf >= 1.1
        ? 'promising'
        : 'weak';

  return { verdict, score: Math.round(Math.max(0, Math.min(100, capped))), reasons };
}
