/**
 * Market-cap tiers via CoinGecko's public /coins/markets endpoint.
 *
 * Why this exists: the exchange feeds the scanner uses (Binance / Gate /
 * Hyperliquid) expose 24h quote volume but NOT market cap or supply, and volume
 * is a poor proxy for size — a low-float token can print enormous volume while
 * a mega-cap can be quiet. Ranking "large caps vs small caps" therefore needs a
 * real cap figure, which only an aggregator provides.
 *
 * Cost: 3 paginated requests per refresh, cached in-process for 6h. On failure
 * the scanner degrades to "unknown" tier rather than guessing, so an outage
 * never silently mislabels a coin's size.
 */

const CG_BASE = 'https://api.coingecko.com/api/v3';
const PAGES = 3;
const PER_PAGE = 250;
const TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

export type CapTier = 'mega' | 'large' | 'mid' | 'small' | 'micro' | 'unknown';

export interface CapInfo {
  marketCap: number;
  rank: number | null;
  volume24h: number;
  name: string;
  tier: CapTier;
}

export const CAP_TIER_LABELS: Record<CapTier, string> = {
  mega: 'Mega Cap',
  large: 'Large Cap',
  mid: 'Mid Cap',
  small: 'Small Cap',
  micro: 'Micro Cap',
  unknown: 'Unranked',
};

export const CAP_TIER_ORDER: CapTier[] = ['mega', 'large', 'mid', 'small', 'micro', 'unknown'];

/**
 * Conventional cut-offs. Mega >= $10B, Large $1B-$10B, Mid $100M-$1B,
 * Small $10M-$100M, Micro < $10M.
 */
export function capTier(marketCap: number | undefined | null): CapTier {
  if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) return 'unknown';
  if (marketCap >= 10e9) return 'mega';
  if (marketCap >= 1e9) return 'large';
  if (marketCap >= 100e6) return 'mid';
  if (marketCap >= 10e6) return 'small';
  return 'micro';
}

type Cache = { at: number; bySymbol: Map<string, CapInfo> };

let cache: Cache | null = null;
let inflight: Promise<Map<string, CapInfo> | null> | null = null;

function normalize(sym: string): string {
  return sym.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

async function fetchPage(page: number): Promise<any[]> {
  const url =
    `${CG_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc` +
    `&per_page=${PER_PAGE}&page=${page}&price_change_percentage=24h`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'User-Agent': 'Althunter/2.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as any[];
  } finally {
    clearTimeout(timer);
  }
}

async function load(): Promise<Map<string, CapInfo>> {
  const bySymbol = new Map<string, CapInfo>();

  const pages = await Promise.allSettled(
    Array.from({ length: PAGES }, (_, i) => fetchPage(i + 1))
  );

  const ok = pages.filter((p) => p.status === 'fulfilled') as PromiseFulfilledResult<any[]>[];
  if (ok.length === 0) throw new Error('all coingecko pages failed');

  for (const page of ok) {
    for (const row of page.value ?? []) {
      const sym = typeof row?.symbol === 'string' ? normalize(row.symbol) : '';
      if (!sym) continue;
      const marketCap: number = Number(row.market_cap) || 0;
      const info: CapInfo = {
        marketCap,
        rank: Number.isFinite(row.market_cap_rank) ? row.market_cap_rank : null,
        volume24h: Number(row.total_volume) || 0,
        name: typeof row.name === 'string' ? row.name : sym,
        tier: capTier(marketCap),
      };
      // Ticker symbols are not unique across the long tail. Pages are ordered by
      // descending cap, so the first sighting is the dominant coin for that
      // ticker and later duplicates are different projects sharing the symbol.
      const existing = bySymbol.get(sym);
      if (!existing || (existing.marketCap === 0 && marketCap > 0)) {
        bySymbol.set(sym, info);
      }
    }
  }

  return bySymbol;
}

/**
 * Returns a market-cap lookup, or null when unavailable. Never throws: the
 * scanner must keep working (with "unknown" tiers) if this aggregator is down.
 */
export async function getMarketCaps(): Promise<Map<string, CapInfo> | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.bySymbol;
  if (inflight) return inflight;

  inflight = load()
    .then((bySymbol) => {
      cache = { at: Date.now(), bySymbol };
      inflight = null;
      return bySymbol;
    })
    .catch((err) => {
      inflight = null;
      console.warn('[marketcap] unavailable:', err instanceof Error ? err.message : err);
      // Serve a stale snapshot rather than dropping the column entirely.
      return cache ? cache.bySymbol : null;
    });

  return inflight;
}

export function lookupCap(
  bySymbol: Map<string, CapInfo> | null,
  symbol: string
): CapInfo | null {
  if (!bySymbol) return null;
  return bySymbol.get(normalize(symbol.replace(/USDT$/i, ''))) ?? null;
}
