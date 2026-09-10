import { BINANCE_BASE_URL } from './config';
import { Candle, BinanceKline } from './types';
import { readCandleCache, writeCandleCache } from './candleCache';

const KLINE_CACHE_TTL_MS = 60_000;
const KLINE_CACHE_MAX = 500;
const DEEP_MEMORY_TTL_MS = 10 * 60_000;
const DEEP_DISK_TTL_MS = 6 * 60 * 60 * 1000;
const BINANCE_MAX_LIMIT = 1000;

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
  klineCache.forEach((entry, key) => {
    if (entry.expires <= now) klineCache.delete(key);
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
      const response = await fetch(url, { ...options, signal: controller.signal });
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

function intervalMs(interval: string): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '2h': 7_200_000,
    '4h': 14_400_000,
    '6h': 21_600_000,
    '8h': 28_800_000,
    '12h': 43_200_000,
    '1d': 86_400_000,
    '3d': 259_200_000,
    '1w': 604_800_000,
  };
  return map[interval] || 86_400_000;
}

async function fetchBinancePage(
  symbol: string,
  interval: string,
  limit: number,
  startTime?: number,
  endTime?: number
): Promise<Candle[]> {
  const s = symbol.replace(/[^A-Z0-9]/g, '');
  const iv = interval.replace(/[^0-9a-z]/g, '');
  const params = new URLSearchParams({
    symbol: s,
    interval: iv,
    limit: String(Math.min(limit, BINANCE_MAX_LIMIT)),
  });
  if (startTime) params.set('startTime', String(startTime));
  if (endTime) params.set('endTime', String(endTime));

  const bases = [
    BINANCE_BASE_URL,
    'https://data-api.binance.vision',
    'https://api1.binance.com',
  ].filter((b, i, arr) => b && arr.indexOf(b) === i);

  let lastStatus = 0;
  let lastErr = '';
  for (const base of bases) {
    const url = `${base}/api/v3/klines?${params.toString()}`;
    try {
      const response = await fetchWithRetry(url, {
        headers: { 'User-Agent': 'Althunter/2.0' },
      });
      if (response.ok) {
        const raw: BinanceKline[] = await response.json();
        return raw.map(formatBinanceKline);
      }
      lastStatus = response.status;
      lastErr = `Binance API error for ${symbol}: ${response.status} (${base})`;
      // 451/403 → try next base; others throw
      if (response.status !== 451 && response.status !== 403 && response.status !== 418) {
        throw new Error(lastErr);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (lastStatus === 451 || lastErr.includes('451')) continue;
      // network fail on this base → try next
      if (base !== bases[bases.length - 1]) continue;
      throw e;
    }
  }
  throw new Error(
    lastErr ||
      `Binance API error for ${symbol}: 451 (geo-restricted). Set BINANCE_BASE_URL=https://data-api.binance.vision`
  );
}

/**
 * Fetch klines with optional deep pagination.
 * deep=true walks backward via endTime until `limit` bars collected or maxPages.
 */
export async function fetchBinanceKlines(
  symbol: string,
  interval: string,
  limit: number,
  options: { skipCache?: boolean; deep?: boolean; maxPages?: number } = {}
): Promise<Candle[]> {
  const s = symbol.replace(/[^A-Z0-9]/g, '');
  const iv = interval.replace(/[^0-9a-z]/g, '');
  const deep = options.deep === true || limit > BINANCE_MAX_LIMIT;
  const target = Math.min(limit, deep ? 5000 : BINANCE_MAX_LIMIT);
  const cacheKey = `binance|${s}|${iv}|${target}|${deep ? 'deep' : 'shallow'}`;

  if (!options.skipCache) {
    const mem = klineCache.get(cacheKey);
    if (mem && mem.expires > Date.now()) {
      return cloneCandles(mem.data);
    }
    const disk = readCandleCache(cacheKey);
    if (disk && disk.length >= Math.min(target, 50)) {
      klineCache.set(cacheKey, {
        data: disk,
        expires: Date.now() + DEEP_MEMORY_TTL_MS,
      });
      return cloneCandles(disk);
    }
  }

  let candles: Candle[];

  if (!deep) {
    candles = await fetchBinancePage(s, iv, target);
  } else {
    const maxPages = options.maxPages ?? Math.ceil(target / BINANCE_MAX_LIMIT) + 1;
    const all: Candle[] = [];
    let endTime: number | undefined;
    const page = BINANCE_MAX_LIMIT;

    for (let p = 0; p < maxPages; p++) {
      const batch = await fetchBinancePage(s, iv, page, undefined, endTime);
      if (batch.length === 0) break;
      all.unshift(...batch);
      const first = batch[0].time;
      endTime = first * 1000 - 1;
      if (all.length >= target) break;
      // stop if we went back far enough
      if (batch.length < page) break;
      await new Promise((r) => setTimeout(r, 120));
    }

    // dedupe + sort + take last N
    const map = new Map<number, Candle>();
    for (const c of all) map.set(c.time, c);
    candles = Array.from(map.values())
      .sort((a, b) => a.time - b.time)
      .slice(-target);
  }

  const ttl = deep ? DEEP_DISK_TTL_MS : KLINE_CACHE_TTL_MS;
  klineCache.set(cacheKey, {
    data: cloneCandles(candles),
    expires: Date.now() + ttl,
  });
  pruneCache();
  if (deep) {
    writeCandleCache(cacheKey, candles, DEEP_DISK_TTL_MS);
  }

  return candles;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { intervalMs };
