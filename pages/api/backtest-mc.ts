import type { NextApiRequest, NextApiResponse } from 'next';
import { runMonteCarlo } from '../../lib/algorithms/mcBacktest';

type Response =
  | { combos: any[]; best: any | null }
  | { error: string };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Response>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    assetSymbol,
    indexSymbol = 'BTCUSDT',
    interval = '1d',
    bars = '300',
    forwardBars = '5',
  } = req.query;

  if (!assetSymbol || Array.isArray(assetSymbol)) {
    return res.status(400).json({ error: 'assetSymbol diperlukan (contoh ETHUSDT)' });
  }

  try {
    const result = await runMonteCarlo({
      assetSymbol: String(assetSymbol).toUpperCase(),
      indexSymbol: String(indexSymbol).toUpperCase(),
      interval: (String(interval) as '1h' | '4h' | '1d') || '1d',
      bars: parseInt(String(bars), 10) || 300,
      forwardBars: parseInt(String(forwardBars), 10) || 5,
    });

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      error: `Monte Carlo backtest gagal: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }
}
