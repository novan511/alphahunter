import { Candle } from '../types';
import { fetchWithRetry } from '../api';
import { fetchBinanceKlines } from '../api';
import { fetchYahooChart } from '../yahoo';

export type MarketDataSource = 'binance' | 'hyperliquid' | 'yahoo';

export interface AssetRef {
  /** Display / internal id, e.g. binance:ETHUSDT, hyperliquid:HYPE, yahoo:GC=F */
  id: string;
  symbol: string;
  source: MarketDataSource;
  label: string;
  klass: 'crypto' | 'commodity' | 'fx' | 'index' | 'equity';
}

export interface AssetPreset {
  id: string;
  name: string;
  description: string;
  assets: AssetRef[];
  /** Preferred interval for this preset (sources may remap). */
  preferredInterval: string;
  /** Default benchmark asset id used for RS/decoupling when applicable. */
  benchmarkId?: string;
}

const HYPERLIQUID_URL = process.env.HYPERLIQUID_BASE_URL || 'https://api.hyperliquid.xyz';

export function parseAssetId(raw: string): AssetRef {
  // Strip annotations like "SOLUSDT (BINANCE)", "GC=F [Yahoo]", "ETH/USDT"
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  // Normalize pair separators: ETH/USDT → ETHUSDT
  cleaned = cleaned.replace(/([A-Z0-9]+)\/([A-Z0-9]+)/g, '$1$2');
  const lower = cleaned.toLowerCase();

  if (lower.startsWith('hyperliquid:')) {
    const symbol = cleaned.slice('hyperliquid:'.length).toUpperCase();
    return {
      id: `hyperliquid:${symbol}`,
      symbol,
      source: 'hyperliquid',
      label: `${symbol} (HL)`,
      klass: 'crypto',
    };
  }

  if (lower.startsWith('yahoo:')) {
    let symbol = cleaned.slice('yahoo:'.length).toUpperCase();
    // Strip trailing exchange notes after strip of ()
    symbol = symbol.replace(/\s+.*$/, '').trim();
    let klass: AssetRef['klass'] = 'equity';
    if (symbol.includes('=F')) klass = 'commodity';
    else if (symbol.includes('=X') || symbol.endsWith('USD=X')) klass = 'fx';
    else if (symbol.startsWith('^')) klass = 'index';
    return {
      id: `yahoo:${symbol}`,
      symbol,
      source: 'yahoo',
      label: `${symbol} (Yahoo)`,
      klass,
    };
  }

  if (lower.startsWith('binance:')) {
    let symbol = cleaned.slice('binance:'.length).toUpperCase();
    symbol = symbol.replace(/\s+.*$/, '').trim();
    return {
      id: `binance:${symbol}`,
      symbol,
      source: 'binance',
      label: `${symbol} (Binance)`,
      klass: 'crypto',
    };
  }

  // Bare crypto-like symbols → Binance
  const bare = cleaned.toUpperCase().replace(/\s+.*$/, '').trim();
  const isCryptoPair =
    /USDT$/.test(bare) ||
    /USDC$/.test(bare) ||
    /BTC$/.test(bare) ||
    /^(BTC|ETH|SOL|BNB|XRP|ADA|AVAX|LINK|DOT|DOGE|TON|SUI|APT|ARBUSDT)$/i.test(bare);

  if (isCryptoPair) {
    let symbol = bare;
    if (/^(BTC|ETH|SOL|BNB|XRP|ADA|AVAX|LINK|DOT|DOGE)$/i.test(symbol) && !/USDT$|USDC$|BTC$/.test(symbol)) {
      symbol = `${symbol}USDT`;
    }
    return {
      id: `binance:${symbol}`,
      symbol,
      source: 'binance',
      label: `${symbol} (Binance)`,
      klass: 'crypto',
    };
  }

  return {
    id: `yahoo:${bare}`,
    symbol: bare,
    source: 'yahoo',
    label: `${bare} (Yahoo)`,
    klass: 'equity',
  };
}

export function parseAssetList(raw: string | undefined, fallback: AssetRef[]): AssetRef[] {
  if (!raw || !raw.trim()) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseAssetId)
    .slice(0, 24);
}

/** Yahoo does not support 4h; map to nearest available. */
export function mapIntervalForSource(source: MarketDataSource, interval: string): string {
  if (source !== 'yahoo') return interval;
  const allowed = new Set(['1m', '5m', '15m', '30m', '1h', '1d', '1wk', '1mo']);
  if (allowed.has(interval)) return interval;
  if (interval === '4h' || interval === '2h' || interval === '3h') return '1h';
  if (interval === '1w') return '1wk';
  return '1d';
}

export async function fetchAssetCandles(
  asset: AssetRef,
  interval: string,
  limit: number,
  options: { deep?: boolean; skipCache?: boolean } = {}
): Promise<Candle[]> {
  const iv = mapIntervalForSource(asset.source, interval);
  const deep = options.deep === true || limit > 800;

  if (asset.source === 'binance') {
    try {
      return await fetchBinanceKlines(asset.symbol, iv, limit, {
        deep,
        skipCache: options.skipCache,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 451 = geo-restricted; fallback to Hyperliquid for common crypto
      if (msg.includes('451') || msg.includes('403') || msg.includes('451')) {
        try {
          const hlCoin = asset.symbol.replace(/USDT$|USDC$/i, '');
          return await fetchHyperliquidCandles(hlCoin, iv, limit);
        } catch {
          throw new Error(
            `Binance blocked (451/geo) for ${asset.symbol}, Hyperliquid fallback also failed. Try BINANCE_BASE_URL=https://data-api.binance.vision or use hyperliquid:${asset.symbol}`
          );
        }
      }
      throw err;
    }
  }

  if (asset.source === 'hyperliquid') {
    return fetchHyperliquidCandles(asset.symbol, iv, limit);
  }

  if (asset.source === 'yahoo') {
    const range = rangeForLimit(iv, limit);
    return fetchYahooChart(asset.symbol, iv, range, {
      deep,
      skipCache: options.skipCache,
    });
  }

  throw new Error(`Unknown market data source: ${(asset as AssetRef).source}`);
}

function rangeForLimit(interval: string, limit: number): string {
  if (interval.includes('m') || interval === '1h') {
    if (limit > 400) return '2y';
    if (limit > 150) return '1y';
    return '6mo';
  }
  if (limit > 400) return '10y';
  if (limit > 150) return '5y';
  return '2y';
}

interface HyperliquidCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n?: number;
}

export async function fetchHyperliquidCandles(
  coin: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const end = Date.now();
  // rough ms span: interval * limit * 1.15
  const ivMs = intervalToMs(interval);
  const start = end - Math.ceil(ivMs * Math.max(limit, 50) * 1.2);

  const body = {
    type: 'candleSnapshot',
    req: {
      coin: coin.toUpperCase(),
      interval,
      startTime: start,
      endTime: end,
    },
  };

  const res = await fetchWithRetry(`${HYPERLIQUID_URL}/info`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Althunter/2.0',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Hyperliquid API error for ${coin}: ${res.status}`);
  }

  const raw = (await res.json()) as HyperliquidCandle[];
  if (!Array.isArray(raw)) return [];

  const candles = raw
    .map((k) => ({
      time: Math.floor(Number(k.t) / 1000),
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v) || 0,
    }))
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time);

  // Hyperliquid returns up to 5000 recent; keep last `limit`
  return candles.slice(-limit);
}

function intervalToMs(interval: string): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '2h': 7_200_000,
    '4h': 14_400_000,
    '8h': 28_800_000,
    '12h': 43_200_000,
    '1d': 86_400_000,
    '3d': 259_200_000,
    '1w': 604_800_000,
    '1mo': 2_592_000_000,
  };
  return map[interval] || 86_400_000;
}
