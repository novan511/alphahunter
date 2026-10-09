import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchKlinesRouted } from '../../lib/universe';

export interface RatioResponse {
  base: string;
  quote: string;
  interval: string;
  /** Shared bar timestamps (unix seconds), ascending. */
  times: number[];
  /** base/quote rebased to 100 at the first bar. Rising = base strengthening. */
  ratio: number[];
  baseCloses: number[];
  quoteCloses: number[];
  /** ratio[last] - 100, i.e. the pair's move over the displayed range. */
  change: number;
  high: number;
  low: number;
  bars: number;
}

interface ErrorResponse {
  error: string;
}

const MIN_OVERLAP = 10;

/**
 * Pair ratio chart data: base/quote over time.
 *
 * This is the visual form of one matrix cell. The matrix reports
 * rs(base, quote) = (sum log-returns of base - sum log-returns of quote),
 * and exp of that difference is exactly ratio[end]/ratio[start]. So the
 * number in the cell and the slope of this chart are the same fact in two
 * forms — if they ever disagree, the chart is right and the cell is stale.
 *
 * Both legs are intersected on bar timestamps (same rule as the matrix), so
 * a bar only appears when both coins traded it.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RatioResponse | ErrorResponse>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { base, quote, interval, limit } = req.query;

  if (!base || typeof base !== 'string' || !quote || typeof quote !== 'string') {
    return res.status(400).json({ error: 'base and quote are required' });
  }

  const tf = typeof interval === 'string' && interval ? interval : '4h';
  const want = Math.min(Math.max(parseInt(limit as string, 10) || 200, 20), 1000);

  const clean = (s: string) => {
    const i = s.indexOf(':');
    return (i >= 0 ? s.slice(i + 1) : s).toUpperCase().replace(/[\s_/\\().[\]-]/g, '');
  };
  const b = clean(base);
  const q = clean(quote);

  if (!b || !q) {
    return res.status(400).json({ error: 'base and quote must be non-empty symbols' });
  }

  let baseCandles;
  let quoteCandles;
  try {
    [baseCandles, quoteCandles] = await Promise.all([
      fetchKlinesRouted(b, tf, want + 20),
      fetchKlinesRouted(q, tf, want + 20),
    ]);
  } catch (err) {
    return res.status(502).json({
      error: `failed to load pair ${b}/${q}: ${err instanceof Error ? err.message : 'unknown'}`,
    });
  }

  const quoteByTime = new Map(quoteCandles.map((c) => [c.time, c.close]));
  const joined: Array<{ time: number; bc: number; qc: number }> = [];
  for (const c of baseCandles) {
    const qc = quoteByTime.get(c.time);
    if (qc === undefined) continue;
    if (!(c.close > 0) || !(qc > 0)) continue;
    joined.push({ time: c.time, bc: c.close, qc });
  }

  if (joined.length < MIN_OVERLAP) {
    return res.status(422).json({
      error: `only ${joined.length} overlapping bars for ${b}/${q} on ${tf} — need at least ${MIN_OVERLAP}`,
    });
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

  return res.status(200).json({
    base: b,
    quote: q,
    interval: tf,
    times,
    ratio,
    baseCloses,
    quoteCloses,
    change: round4(ratio[ratio.length - 1] - 100),
    high: round4(high),
    low: round4(low),
    bars: bars.length,
  });
}

function round4(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}
