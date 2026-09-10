import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle } from '../../lib/types';
import { getYahooParams } from '../../lib/idxConfig';
import { fetchYahooChart, toYahooSymbol } from '../../lib/yahoo';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Candle[] | { error: string }>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { symbol, interval = '1d', range } = req.query;

  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol is required (e.g., BBCA)' });
  }

  const sanitizedSymbol = symbol.replace(/[^A-Z0-9.^]/g, '');
  const yahooSymbol = sanitizedSymbol.includes('.') ? sanitizedSymbol : `${sanitizedSymbol}.JK`;
  const yahooParams = getYahooParams(interval as string);
  const yahooRange = (range as string) || yahooParams.yahooRange;

  try {
    const candles = await fetchYahooChart(yahooSymbol, yahooParams.yahooInterval, yahooRange);
    return res.status(200).json(candles);
  } catch (err) {
    return res.status(500).json({
      error: `Failed to fetch IDX data: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }
}