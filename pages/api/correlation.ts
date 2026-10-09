import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle } from '../../lib/types';
import { fetchKlinesRouted } from '../../lib/universe';
import { computeMatrix, CorrMatrix } from '../../lib/algorithms/correlationMatrix';

const MAX_SYMBOLS = 14;
const MIN_SYMBOLS = 2;

interface ErrorResponse {
  error: string;
}

/**
 * `fetchKlinesRouted` takes a BARE symbol (`BTCUSDT`, `HYPE`), not a prefixed
 * asset id. It normalizes with a character class that does not strip `:`,
 * so `binance:BTCUSDT` misses the symbol registry and falls through to
 * Hyperliquid, which answers unknown coins with a slow 500.
 *
 * Accept prefixed ids from the client for readability and strip the prefix
 * here, keeping the bare symbol as the routing key.
 */
function toBareSymbol(raw: string): string {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(':');
  const bare = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
  return bare.toUpperCase().replace(/[\s_/\\().[\]-]/g, '');
}

/**
 * Pairwise strength matrix.
 *
 * Accepts `symbols` as a comma-separated list. Both `binance:SOLUSDT` and
 * `SOLUSDT` work; the prefix is dropped before routing.
 *
 * `window` is a count of return bars, not candles. We fetch extra history
 * because alignment drops bars where any asset is missing.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CorrMatrix | ErrorResponse>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { symbols, interval, window } = req.query;

  if (!symbols || typeof symbols !== 'string') {
    return res.status(400).json({ error: 'symbols is required (comma-separated)' });
  }

  const parsedSymbols = Array.from(
    new Set(
      symbols
        .split(',')
        .map((s) => toBareSymbol(s))
        .filter(Boolean),
    ),
  ).slice(0, MAX_SYMBOLS);

  if (parsedSymbols.length < MIN_SYMBOLS) {
    return res.status(400).json({
      error: `need at least ${MIN_SYMBOLS} symbols to compare`,
    });
  }

  const tf = typeof interval === 'string' && interval ? interval : '4h';
  const windowBars = Math.min(
    Math.max(parseInt(window as string, 10) || 30, 10),
    200,
  );

  // Alignment drops bars where any asset is missing, so fetch with slack.
  const fetchLimit = Math.min(1000, windowBars * 3 + 60);

  const settled = await Promise.allSettled(
    parsedSymbols.map(async (symbol) => {
      const candles = await fetchKlinesRouted(symbol, tf, fetchLimit);
      return { symbol, candles };
    }),
  );

  const series: Record<string, Candle[]> = {};
  const failed: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.candles.length > 0) {
      series[r.value.symbol] = r.value.candles;
    } else {
      failed.push(parsedSymbols[i]);
    }
  });

  const available = Object.keys(series);
  if (available.length < MIN_SYMBOLS) {
    return res.status(502).json({
      error: `could not load enough symbols. failed: ${failed.join(', ') || 'unknown'}`,
    });
  }

  // A partial basket is still useful, but say so explicitly rather than
  // silently comparing 4 coins when 6 were asked for.
  const matrix = computeMatrix(series, available, windowBars, tf);
  if (!matrix) {
    return res.status(422).json({
      error: `not enough overlapping history for a ${windowBars}-bar ${tf} window across ${available.length} symbols`,
    });
  }

  if (failed.length > 0) {
    res.setHeader('X-Skipped-Symbols', failed.join(','));
  }

  return res.status(200).json(matrix);
}