import { BINANCE_BASE_URL } from './config';
import { Candle, BinanceKline } from './types';

const KLINE_CACHE_TTL_MS = 60_000;
const KLINE_CACHE_MAX = 500;

interface CacheEntry {
  data: Candle[];
  expires: number;
}

const klineCache = new Map<string, CacheEntry>();

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

function cloneCandles(candles: Candle[]): Candle[] {
  return candles.map((c) => ({ ...c }));
}

function pruneCache(): void {
  if (klineCache.size <= KLINE_CACHE_MAX) return;
  const now = Date.now();
  klineCache.forEach((_entry, key) => {
    if (_entry.expires <= now) {
      klineCache.delete(key);
    }
  });
  while (klineCache.size > KLINE_CACHE_MAX) {
    const firstKey = klineCache.keys().next().value as string | undefined;
    if (firstKey === undefined) break;
    klineCache.delete(firstKey);
  }
}

export function clearKlineCache(): void {
  klineCache.clear();
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
  limit: number,
  options: { skipCache?: boolean } = {}
): Promise<Candle[]> {
  const s = symbol.replace(/[^A-Z0-9]/g, '');
  const iv = interval.replace(/[^0-9a-z]/g, '');
  const cacheKey = `${s}|${iv}|${limit}`;

  if (!options.skipCache) {
    const cached = klineCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cloneCandles(cached.data);
    }
  }

  const url = `${BINANCE_BASE_URL}/api/v3/klines?symbol=${s}&interval=${iv}&limit=${limit}`;

  const response = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'Althunter/2.0' },
  });

  if (!response.ok) {
    throw new Error(`Binance API error for ${symbol}: ${response.status}`);
  }

  const raw: BinanceKline[] = await response.json();
  const candles = raw.map(formatBinanceKline);

  klineCache.set(cacheKey, {
    data: cloneCandles(candles),
    expires: Date.now() + KLINE_CACHE_TTL_MS,
  });
  pruneCache();

  return candles;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
