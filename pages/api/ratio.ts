import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchPairRatio, type PairRatio } from '../../lib/algorithms/pairRatio';

interface ErrorResponse {
  error: string;
}

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
  res: NextApiResponse<PairRatio | ErrorResponse>
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

  try {
    const pair = await fetchPairRatio(base, quote, tf, want);
    return res.status(200).json(pair);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    const status = /non-kosong/.test(msg) ? 400 : /overlap/.test(msg) ? 422 : 502;
    return res.status(status).json({ error: msg });
  }
}
