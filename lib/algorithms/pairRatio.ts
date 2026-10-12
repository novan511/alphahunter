import { Candle } from '../types';
import { fetchKlinesRouted } from '../universe';

export interface PairRatio {
  base: string;
  quote: string;
  interval: string;
  times: number[];
  ratio: number[];
  baseCloses: number[];
  quoteCloses: number[];
  change: number;
  high: number;
  low: number;
  bars: number;
}

const MIN_OVERLAP = 10;

function clean(s: string): string {
  const i = s.indexOf(':');
  return (i >= 0 ? s.slice(i + 1) : s).toUpperCase().replace(/[\s_/\\().[\]-]/g, '');
}

function round4(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

/**
 * Shared pair-ratio computation for /api/ratio and the Telegram webhook.
 *
 * Both legs are intersected on bar timestamps; the ratio is rebased to 100
 * at the first shared bar. Throws on unusable input so callers can turn it
 * into their own error shape (HTTP status vs chat reply).
 */
export async function fetchPairRatio(
  rawBase: string,
  rawQuote: string,
  interval: string,
  limit: number,
): Promise<PairRatio> {
  const b = clean(rawBase);
  const q = clean(rawQuote);
  if (!b || !q) throw new Error('base dan quote harus simbol non-kosong');

  const want = Math.min(Math.max(limit, 20), 1000);

  const [baseCandles, quoteCandles]: Candle[][] = await Promise.all([
    fetchKlinesRouted(b, interval, want + 20),
    fetchKlinesRouted(q, interval, want + 20),
  ]);

  const quoteByTime = new Map(quoteCandles.map((c) => [c.time, c.close]));
  const joined: Array<{ time: number; bc: number; qc: number }> = [];
  for (const c of baseCandles) {
    const qc = quoteByTime.get(c.time);
    if (qc === undefined) continue;
    if (!(c.close > 0) || !(qc > 0)) continue;
    joined.push({ time: c.time, bc: c.close, qc });
  }

  if (joined.length < MIN_OVERLAP) {
    throw new Error(
      `hanya ${joined.length} bar overlap untuk ${b}/${q} di ${interval} — butuh >= ${MIN_OVERLAP}`,
    );
  }

  const bars = joined.slice(-want);
  const first = bars[0].bc / bars[0].qc;

  const times = bars.map((x) => x.time);
  const baseCloses = bars.map((x) => x.bc);
  const quoteCloses = bars.map((x) => x.qc);
  const ratio = bars.map((x) => round4((100 * (x.bc / x.qc)) / first));

  let high = -Infinity;
  let low = Infinity;
  for (const v of ratio) {
    if (v > high) high = v;
    if (v < low) low = v;
  }

  return {
    base: b,
    quote: q,
    interval,
    times,
    ratio,
    baseCloses,
    quoteCloses,
    change: round4(ratio[ratio.length - 1] - 100),
    high: round4(high),
    low: round4(low),
    bars: bars.length,
  };
}

/**
 * Strength of base over quote across the last `windowBars` returns of an
 * already-fetched pair — the same number the matrix cell reports, so the bot
 * can quote it without recomputing the whole basket.
 */
export function windowStrength(pair: PairRatio, windowBars: number): number {
  const n = Math.min(windowBars, pair.baseCloses.length - 1);
  if (n < 1) return 0;
  const bc = pair.baseCloses.slice(-(n + 1));
  const qc = pair.quoteCloses.slice(-(n + 1));
  let acc = 0;
  for (let i = 1; i < bc.length; i++) {
    acc += Math.log(bc[i] / bc[i - 1]) - Math.log(qc[i] / qc[i - 1]);
  }
  return Math.round(acc * 100 * 100) / 100;
}
