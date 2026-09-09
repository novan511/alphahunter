import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle } from '../../lib/types';
import { fetchBinanceKlines } from '../../lib/api';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Candle[] | { error: string }>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { symbol, interval, limit } = req.query;

  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol is required' });
  }
  if (!interval || typeof interval !== 'string') {
    return res.status(400).json({ error: 'interval is required' });
  }

  const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 500, 50), 1000);

  try {
    const candles = await fetchBinanceKlines(symbol, interval, parsedLimit);
    return res.status(200).json(candles);
  } catch (err) {
    return res.status(500).json({
      error: `Failed to fetch klines: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }
}