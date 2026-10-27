import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle } from '../../lib/types';
import { fetchAssetCandles, parseAssetId } from '../../lib/marketData';

/** Candle chart per arena-position — asset ref 'binance:BTCUSDT' / 'yahoo:CL=F' style */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Candle[] | { error: string }>
) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { symbol, interval, limit, lastOnly, gran } = req.query;
  if (!symbol || typeof symbol !== 'string') return res.status(400).json({ error: 'symbol required' });
  const asset = parseAssetId(symbol);
  // mode gran=5m: harga mark live (candle 5 menit terakhir) — untuk floating PnL seperti CEX,
  // bukan close 1h yang berubah hanya saat candle roll
  const iv = typeof gran === 'string' && gran ? gran : String(interval || '1h');
  try {
    const limitWanted = Math.min(Math.max(parseInt(limit as string, 10) || (lastOnly ? 3 : 200), 3), lastOnly ? 3 : 500);
    const raw = await fetchAssetCandles(asset, iv, limitWanted);
    const candles = lastOnly ? raw.slice(-3) : raw.slice(-500);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(candles);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'fetch failed' });
  }
}
