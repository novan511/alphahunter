import { BINANCE_BASE_URL } from './config';
import { Candle, BinanceKline } from './types';

function formatBinanceKline(raw: BinanceKline): Candle {
  return {
    time: Math.floor(raw[0] / 1000),
    open: parseFloat(raw[1]),
    high: parseFloat(raw[2]),
    low: parseFloat(raw[3]),
    close: parseFloat(raw[4]),
    volume: parseFloat(raw[5]),
  };
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries: number = 3,
  backoffMs: number = 500
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) return response;

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoffMs * attempt;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (response.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
        continue;
      }

      return response;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }

  throw new Error('Max retries exceeded');
}

export async function fetchBinanceKlines(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const s = symbol.replace(/[^A-Z0-9]/g, '');
  const iv = interval.replace(/[^0-9a-z]/g, '');
  const url = `${BINANCE_BASE_URL}/api/v3/klines?symbol=${s}&interval=${iv}&limit=${limit}`;

  const response = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'Althunter/2.0' },
  });

  if (!response.ok) {
    throw new Error(`Binance API error for ${symbol}: ${response.status}`);
  }

  const raw: BinanceKline[] = await response.json();
  return raw.map(formatBinanceKline);
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}