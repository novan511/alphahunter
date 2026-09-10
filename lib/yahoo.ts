import { Candle } from './types';
import { fetchWithRetry } from './api';
import { readCandleCache, writeCandleCache } from './candleCache';

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

export function toYahooSymbol(symbol: string): string {
  if (symbol.startsWith('^')) return symbol;
  if (symbol.includes('=')) return symbol;
  if (symbol.includes('.')) return symbol;
  return `${symbol}.JK`;
}

/** Map requested interval to Yahoo-supported interval. */
export function mapYahooInterval(interval: string): string {
  const allowed = new Set(['1m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);
  if (allowed.has(interval)) return interval;
  if (interval === '4h' || interval === '2h' || interval === '3h') return '1h';
  if (interval === '1w') return '1wk';
  if (interval === '1d') return '1d';
  return '1d';
}

/** Prefer deep ranges for daily+ so commodities get multi-year history. */
export function yahooRangeFor(interval: string, deep: boolean): string {
  const iv = mapYahooInterval(interval);
  if (!deep) {
    if (iv === '1m' || iv === '5m' || iv === '15m' || iv === '30m' || iv === '60m' || iv === '1h') {
      return '3mo';
    }
    if (iv === '1wk') return '2y';
    return '2y';
  }
  // deep history
  if (iv === '1m' || iv === '5m') return '1mo';
  if (iv === '15m' || iv === '30m' || iv === '1h' || iv === '60m') return '2y';
  if (iv === '1wk') return '10y';
  return '10y';
}

export async function fetchYahooChart(
  symbol: string,
  interval: string,
  range: string,
  options: { skipCache?: boolean; deep?: boolean } = {}
): Promise<Candle[]> {
  const yahooSymbol = toYahooSymbol(symbol);
  const yi = mapYahooInterval(interval);
  const effectiveRange = options.deep ? yahooRangeFor(interval, true) : range;
  const cacheKey = `yahoo|${yahooSymbol}|${yi}|${effectiveRange}`;

  if (!options.skipCache) {
    const disk = readCandleCache(cacheKey);
    if (disk && disk.length > 0) return disk;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${yi}&range=${effectiveRange}`;

  const res = await fetchWithRetry(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance error for ${symbol}: ${res.status}`);
  }

  const data: YahooChartResult = await res.json();

  if (data.chart.error) {
    throw new Error(`Yahoo Finance: ${data.chart.error}`);
  }

  const result = data.chart.result?.[0];
  if (!result) return [];

  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];

  if (!timestamps || !quote) return [];

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

  if (candles.length > 0) {
    writeCandleCache(cacheKey, candles, options.deep ? 24 * 3600_000 : 6 * 3600_000);
  }

  return candles;
}
