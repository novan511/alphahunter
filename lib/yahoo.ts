import { Candle } from './types';
import { fetchWithRetry } from './api';

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
  // Futures / FX / indices use =F, =X, ^ prefix — do not remap
  if (symbol.startsWith('^')) return symbol;
  if (symbol.includes('=')) return symbol;
  // Already qualified (e.g. BBCA.JK, BRK-B)
  if (symbol.includes('.')) return symbol;
  // Bare ticker → Indonesian listing convention used by IDX pages
  return `${symbol}.JK`;
}

export async function fetchYahooChart(
  symbol: string,
  interval: string,
  range: string
): Promise<Candle[]> {
  const yahooSymbol = toYahooSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;

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

  return candles;
}
