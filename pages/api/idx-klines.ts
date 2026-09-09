import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle } from '../../lib/types';
import { getYahooParams } from '../../lib/idxConfig';

interface YahooChartResult {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: number[];
          high: number[];
          low: number[];
          close: number[];
          volume: number[];
        }>;
      };
    }>;
    error: string | null;
  };
}

function toYahooSymbol(symbol: string): string {
  if (symbol.startsWith('^')) return symbol;
  if (symbol.includes('.')) return symbol;
  return `${symbol}.JK`;
}

async function fetchYahooChart(
  symbol: string,
  interval: string,
  range: string
): Promise<Candle[]> {
  const yahooSymbol = toYahooSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Yahoo Finance error for ${symbol}: ${res.status}`);
    }

    const data: YahooChartResult = await res.json();

    if (data.chart.error) {
      throw new Error(`Yahoo Finance: ${data.chart.error}`);
    }

    const result = data.chart.result?.[0];
    if (!result) {
      return [];
    }

    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];

    if (!timestamps || !quote) {
      return [];
    }

    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      const v = quote.volume?.[i];

      if (o == null || h == null || l == null || c == null) continue;

      candles.push({
        time: timestamps[i],
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v || 0,
      });
    }

    return candles;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

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