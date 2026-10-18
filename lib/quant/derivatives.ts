/**
 * Free derivatives / order-flow context.
 *
 * Two signals the candle engine cannot see, both from keyless public endpoints:
 *   - funding rate   → who pays whom on perps (crowd positioning)
 *   - spot CVD       → taker buy vs sell base volume (who is lifting offers)
 *
 * Sources:
 *   - Binance USDⓈ-M futures  /fapi/v1/premiumIndex   → funding for every symbol
 *   - Binance spot klines     taker buy volume        → spot order flow
 *   - Hyperliquid             metaAndAssetCtxs        → funding fallback
 *
 * Best-effort by design: an exchange outage or a geo block returns null for
 * that field, never an exception. Consumers must treat null as "unknown".
 */

import { fetchWithRetry, fetchBinanceKlines } from '../api';

const FAPI_URL = 'https://fapi.binance.com/fapi/v1/premiumIndex';
const HL_URL = process.env.HYPERLIQUID_BASE_URL || 'https://api.hyperliquid.xyz';
const CACHE_TTL_MS = 3 * 60_000;
const MAX_COINS = 8;
const CVD_BARS = 24;

export interface CoinFlow {
  base: string;
  /** Funding rate in percent per 8h. null when no venue lists the coin. */
  fundingPct: number | null;
  fundingSource: 'binance' | 'hyperliquid' | null;
  /** Spot taker delta over the window as a share of traded volume, -1..1. */
  netDeltaShare: number | null;
  /** Taker buy share of spot volume, 0..1. */
  buyRatio: number | null;
  /** Bars the CVD window actually used. */
  cvdBars: number;
}

let cache: { key: string; at: number; data: Map<string, CoinFlow> } | null = null;

function baseOf(symbol: string): string {
  return symbol.replace(/USDT$|USDC$/, '').toUpperCase();
}

/** Funding for every Binance futures symbol in one call. Empty on geo block. */
async function binanceFunding(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await fetchWithRetry(FAPI_URL, {}, 2, 400, 8000);
    if (!res.ok) return map;
    const rows = (await res.json()) as Array<{ symbol?: string; lastFundingRate?: string }>;
    for (const row of rows) {
      const v = parseFloat(row.lastFundingRate ?? '');
      if (row.symbol && Number.isFinite(v)) map.set(baseOf(row.symbol), v * 100);
    }
  } catch {
    // fetchWithRetry exhausted — fall through to the Hyperliquid fallback.
  }
  return map;
}

/**
 * Fallback funding from Hyperliquid. HL charges hourly, Binance every 8h, so
 * the hourly rate is scaled to an 8h-equivalent to keep the two comparable.
 */
async function hyperliquidFunding(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await fetchWithRetry(
      `${HL_URL}/info`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      },
      2,
      400,
      8000,
    );
    if (!res.ok) return map;
    const payload = (await res.json()) as [
      { universe?: { name?: string }[] },
      Array<{ funding?: string }>,
    ];
    const universe = payload?.[0]?.universe ?? [];
    const ctxs = payload?.[1] ?? [];
    universe.forEach((u, i) => {
      const v = parseFloat(ctxs[i]?.funding ?? '');
      if (u?.name && Number.isFinite(v)) map.set(u.name.toUpperCase(), v * 8 * 100);
    });
  } catch {
    // no venue answered — funding stays unknown for every coin
  }
  return map;
}

/** Spot taker delta over the last CVD_BARS hourly candles. */
async function spotCvd(base: string): Promise<{ netDeltaShare: number; buyRatio: number; bars: number } | null> {
  try {
    const candles = await fetchBinanceKlines(`${base}USDT`, '1h', CVD_BARS);
    let buy = 0;
    let total = 0;
    let bars = 0;
    for (const c of candles) {
      if (c.takerBuyVolume == null) continue;
      buy += c.takerBuyVolume;
      total += c.volume;
      bars++;
    }
    if (bars < 6 || !(total > 0)) return null;
    return { netDeltaShare: (2 * buy - total) / total, buyRatio: buy / total, bars };
  } catch {
    return null;
  }
}

/**
 * Funding + spot order flow for up to MAX_COINS bases.
 *
 * The input is a scan's symbol list (BTCUSDT, hyperliquid:BTC, …); anything
 * after a source prefix is ignored. Cached briefly — this runs on every AI
 * question, and funding moves slowly.
 */
export async function fetchCoinFlow(symbols: string[]): Promise<Map<string, CoinFlow>> {
  const bases = Array.from(
    new Set(symbols.map((s) => baseOf(s.includes(':') ? s.slice(s.indexOf(':') + 1) : s))),
  )
    .filter((b) => /^[A-Z0-9]{2,12}$/.test(b))
    .slice(0, MAX_COINS);

  if (bases.length === 0) return new Map();
  const key = bases.join(',');
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  const [binance, hyper] = await Promise.all([binanceFunding(), hyperliquidFunding()]);
  const settled = await Promise.allSettled(bases.map((b) => spotCvd(b)));

  const out = new Map<string, CoinFlow>();
  bases.forEach((base, i) => {
    const cvd = settled[i].status === 'fulfilled' ? settled[i].value : null;
    // Hyperliquid lists meme coins under a 1000x alias (kPEPE), and the funding
    // rate is a rate on notional, so the alias carries the same value.
    const fromBinance = binance.get(base);
    const fromHyper = hyper.get(base) ?? hyper.get(`K${base}`);
    const fundingPct = fromBinance ?? fromHyper ?? null;
    out.set(base, {
      base,
      fundingPct,
      fundingSource: fundingPct == null ? null : fromBinance != null ? 'binance' : 'hyperliquid',
      netDeltaShare: cvd?.netDeltaShare ?? null,
      buyRatio: cvd?.buyRatio ?? null,
      cvdBars: cvd?.bars ?? 0,
    });
  });

  cache = { key, at: Date.now(), data: out };
  return out;
}

/** One compact line per coin for the AI prompt; null when nothing is known. */
export function flowLine(f: CoinFlow): string | null {
  const parts: string[] = [];
  if (f.fundingPct != null) {
    const venue = f.fundingSource === 'binance' ? 'Binance' : 'Hyperliquid';
    const tone = f.fundingPct > 0.02 ? 'long bayar short (crowd long)' : f.fundingPct < -0.02 ? 'short bayar long (crowd short)' : 'netral';
    parts.push(`funding ${f.fundingPct >= 0 ? '+' : ''}${f.fundingPct.toFixed(4)}%/8j (${venue}, ${tone})`);
  }
  if (f.netDeltaShare != null) {
    const tone = f.netDeltaShare > 0.05 ? 'net buying' : f.netDeltaShare < -0.05 ? 'net selling' : 'seimbang';
    parts.push(
      `CVD spot ${f.cvdBars}j ${f.netDeltaShare >= 0 ? '+' : ''}${(f.netDeltaShare * 100).toFixed(1)}% (${tone}, buy ${Math.round((f.buyRatio ?? 0.5) * 100)}%)`,
    );
  }
  return parts.length ? `${f.base}: ${parts.join(' · ')}` : null;
}
