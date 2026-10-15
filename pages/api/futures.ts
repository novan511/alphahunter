import type { NextApiRequest, NextApiResponse } from 'next';
import {
  loadFutures,
  missingSymbols,
  FUTURES_TIMEFRAMES,
  EMPTY_MACRO,
  type FuturesResponse,
} from '../../lib/futures';

/**
 * Futures desk feed: the fixed perp book plus macro context for one timeframe.
 *
 * One request per timeframe on purpose. Splitting per symbol would mean 13
 * round trips and a page where half the cards are still loading; the venue
 * answers these small snapshots in well under a second, so the whole book
 * ships together and the tab renders atomically.
 *
 * Cached briefly because the tab refetches on every timeframe switch and the
 * underlying bars only close on the interval, not on the viewer's refresh.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; data: FuturesResponse }>();

const VALID_TF = new Set(FUTURES_TIMEFRAMES.map((t) => t.tf));

/** Must match what FuturesChart plots; anything older is dead weight. */
const CHART_BARS = 120;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<FuturesResponse | { error: string }>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = typeof req.query.tf === 'string' ? req.query.tf : '1h';
  const tf = VALID_TF.has(raw) ? raw : '1h';

  const hit = cache.get(tf);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return res.status(200).json(hit.data);
  }

  try {
    const loaded = await loadFutures(tf);
    if (loaded.signals.length === 0) {
      return res.status(502).json({
        error: `Tidak ada instrumen yang bisa dimuat (${loaded.errors.slice(0, 3).join('; ') || 'venue kosong'})`,
      });
    }

    const missing = missingSymbols(loaded);
    const data: FuturesResponse = {
      tf,
      // The cards only plot the last 120 bars, so shipping the full 300 makes
      // the payload twice as large for nothing.
      signals: loaded.signals.map((s) => ({ ...s, candles: s.candles.slice(-CHART_BARS) })),
      macro: loaded.macro ?? EMPTY_MACRO,
      fetchedAt: loaded.fetchedAt,
      errors: loaded.errors,
      missing,
      complete: missing.length === 0,
    };
    cache.set(tf, { at: Date.now(), data });
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'futures load failed',
    });
  }
}
