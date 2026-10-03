import { Candle } from './types';
import { BINANCE_BASE_URL } from './config';
import { fetchWithRetry, fetchBinanceKlines } from './api';
import { fetchGateCandles, fetchHyperliquidCandles } from './marketData/index';

export type UniverseSource = 'binance' | 'gate' | 'hyperliquid';

export interface UniverseEntry {
  /** Internal/display symbol, e.g. LINKUSDT, XYZUSDT, HYPEUSDT */
  symbol: string;
  source: UniverseSource;
  /** Exact identifier the source understands: LINKUSDT / XYZ_USDT / kPEPE */
  rawPair: string;
  base: string;
  /** 24h quote volume in USD (0 when the source has no volume stat) */
  quoteVolume: number;
}

export interface UniverseSnapshot {
  /** Stable id derived from the ordered symbol list; clients pass it to detect universe changes mid-scan. */
  id: string;
  entries: UniverseEntry[];
  sourceCounts: Record<UniverseSource, number>;
  universeTotal: number;
  fetchedAt: number;
}

const UNIVERSE_TTL_MS = 60 * 60 * 1000;
const CACHE_KEY = 'v1';

const SOURCE_ORDER: UniverseSource[] = ['binance', 'gate', 'hyperliquid'];

const STABLE_BASES = new Set([
  'USDC', 'USDT', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDD', 'USDS', 'PYUSD',
  'USD1', 'USDE', 'USDK', 'XUSD', 'USDEX', 'EUR', 'EURI', 'AEUR', 'EURT', 'EURS',
  'TRY', 'BRL', 'ARS', 'GBP', 'AUD', 'UAH', 'COP', 'NGN', 'ZAR', 'RON', 'PLN',
  'CZK', 'JPY', 'IDRT', 'BIDR', 'RUB', 'MDL', 'MXN', 'USTC',
]);

interface RawListing {
  source: UniverseSource;
  symbol: string;
  rawPair: string;
  base: string;
  quoteVolume: number;
}

let cache: UniverseSnapshot | null = null;
let symbolIndex = new Map<string, UniverseEntry>();
let inflight: Promise<UniverseSnapshot> | null = null;

function hashId(symbols: string[]): string {
  // djb2 over the ordered symbol list
  let h1 = 5381;
  let h2 = 52711;
  const joined = symbols.join(',');
  for (let i = 0; i < joined.length; i++) {
    const c = joined.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) >>> 0;
    h2 = ((h2 << 5) + h2 + c) >>> 0;
  }
  return `${CACHE_KEY}${h1.toString(36)}${h2.toString(36)}`;
}

/**
 * Stable id for a caller-defined ORDERING of a symbol list.
 *
 * The scan protocol resumes by absolute position in a sorted list, so the id
 * must change whenever the order changes — otherwise a client resumes against
 * a reordered universe and silently mixes results from two different sequences.
 * Ordering by market cap (rather than the default volume order) therefore needs
 * its own id, not the volume one.
 */
export function orderId(symbols: string[]): string {
  let h1 = 5381;
  let h2 = 52711;
  const joined = symbols.join(',');
  for (let i = 0; i < joined.length; i++) {
    const c = joined.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) >>> 0;
    h2 = ((h2 << 5) + h2 + c) >>> 0;
  }
  return `ord${h1.toString(36)}${h2.toString(36)}`;
}

function isLeveraged(base: string, bases: Set<string>): boolean {
  for (const suffix of ['UP', 'DOWN', 'BULL', 'BEAR']) {
    if (base.length > suffix.length && base.endsWith(suffix)) {
      if (bases.has(base.slice(0, -suffix.length))) return true;
    }
  }
  // Leveraged tokens: BTC5L, ETH3S, SOXL3S … (no real coin ends in digits+L/S)
  if (/\d+(L|S)$/.test(base)) return true;
  return false;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetchWithRetry(url, {
    ...init,
    headers: { 'User-Agent': 'Althunter/2.0', ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function listBinance(): Promise<RawListing[]> {
  const bases = [
    BINANCE_BASE_URL,
    'https://data-api.binance.vision',
    'https://api1.binance.com',
  ].filter((b, i, arr) => b && arr.indexOf(b) === i);

  let lastErr: unknown = null;
  for (const base of bases) {
    try {
      const raw = (await fetchJson(`${base}/api/v3/ticker/24hr`)) as {
        symbol: string;
        quoteVolume: string;
      }[];
      return raw
        .filter((t) => t.symbol.endsWith('USDT'))
        .map((t) => ({
          source: 'binance' as const,
          symbol: t.symbol,
          rawPair: t.symbol,
          base: t.symbol.slice(0, -4),
          quoteVolume: parseFloat(t.quoteVolume) || 0,
        }));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('binance ticker fetch failed');
}

async function listGate(): Promise<RawListing[]> {
  const raw = (await fetchJson('https://api.gateio.ws/api/v4/spot/tickers')) as {
    currency_pair: string;
    quote_volume: string;
  }[];
  return raw
    .filter((t) => t.currency_pair && t.currency_pair.endsWith('_USDT'))
    .map((t) => {
      const base = t.currency_pair.slice(0, -5);
      return {
        source: 'gate' as const,
        symbol: `${base}USDT`,
        rawPair: t.currency_pair,
        base,
        quoteVolume: parseFloat(t.quote_volume) || 0,
      };
    });
}

async function listHyperliquid(): Promise<RawListing[]> {
  const payload = (await fetchJson('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  })) as [{ universe: { name: string }[] }, { dayNtlVlm?: string }[]];

  const universe = payload?.[0]?.universe || [];
  const ctxs = payload?.[1] || [];
  return universe
    .filter((u) => u?.name && !u.name.startsWith('@') && !u.name.includes('/'))
    .map((u, i) => {
      const coin = u.name;
      const base = coin.toUpperCase();
      return {
        source: 'hyperliquid' as const,
        symbol: `${base}USDT`,
        rawPair: coin,
        base,
        quoteVolume: parseFloat(ctxs[i]?.dayNtlVlm || '0') || 0,
      };
    });
}

function mergeListings(lists: (RawListing[] | null)[]): UniverseSnapshot {
  const bases = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const l of list) bases.add(l.base);
  }

  const bySymbol = new Map<string, UniverseEntry>();
  const sourceCounts: Record<UniverseSource, number> = { binance: 0, gate: 0, hyperliquid: 0 };

  for (let rank = 0; rank < SOURCE_ORDER.length; rank++) {
    const source = SOURCE_ORDER[rank];
    const list = lists[rank];
    if (!list) continue;

    for (const l of list) {
      if (STABLE_BASES.has(l.base)) continue;
      if (isLeveraged(l.base, bases)) continue;
      if (bySymbol.has(l.symbol)) continue;
      // Hyperliquid unit-scaled names (kPEPE) should merge into the plain listing (PEPE) when present
      if (source === 'hyperliquid' && l.rawPair.startsWith('k')) {
        const alias = `${l.base.slice(1)}USDT`;
        if (bySymbol.has(alias)) continue;
      }
      const entry: UniverseEntry = {
        symbol: l.symbol,
        source: l.source,
        rawPair: l.rawPair,
        base: l.base,
        quoteVolume: l.quoteVolume,
      };
      bySymbol.set(l.symbol, entry);
      sourceCounts[l.source]++;
    }
  }

  const entries = Array.from(bySymbol.values()).sort(
    (a, b) => b.quoteVolume - a.quoteVolume || (a.symbol < b.symbol ? -1 : 1)
  );

  return {
    id: hashId(entries.map((e) => e.symbol)),
    entries,
    sourceCounts,
    universeTotal: entries.length,
    fetchedAt: Date.now(),
  };
}

async function discover(): Promise<UniverseSnapshot> {
  const results = await Promise.allSettled([listBinance(), listGate(), listHyperliquid()]);
  const lists = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
  if (lists.every((l) => l === null)) {
    const firstError = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    throw firstError?.reason instanceof Error
      ? firstError.reason
      : new Error('All universe sources failed');
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      console.warn(`universe: source ${SOURCE_ORDER[i]} failed:`, r.reason?.message || r.reason);
    }
  }
  return mergeListings(lists);
}

/** Cached universe discovery. Deduplicates concurrent callers. */
export async function getUniverse(): Promise<UniverseSnapshot> {
  if (cache && Date.now() - cache.fetchedAt < UNIVERSE_TTL_MS) return cache;
  if (inflight) return inflight;
  const t0 = Date.now();
  console.log('[universe] discovery started');
  inflight = discover()
    .then((snap) => {
      console.log(`[universe] discovery done in ${Date.now() - t0}ms: ${snap.universeTotal} symbols`);
      cache = snap;
      symbolIndex = new Map(snap.entries.map((e) => [e.symbol, e]));
      inflight = null;
      return snap;
    })
    .catch((err) => {
      inflight = null;
      if (cache) return cache; // stale snapshot beats a dead scan
      throw err;
    });
  return inflight;
}

export function lookupUniverseEntry(symbol: string): UniverseEntry | null {
  const clean = normalizeSymbol(symbol);
  return symbolIndex.get(clean) || null;
}

/**
 * Normalize a symbol for registry lookup: drop spaces/slashes/punctuation,
 * keep letters of any script (Gate lists pairs like 牛来USDT), uppercase Latin.
 */
export function normalizeSymbol(symbol: string): string {
  return symbol.replace(/[\s_/\\().\[\]-]/g, '').toUpperCase();
}

function deriveGatePair(symbolBase: string): string {
  return `${symbolBase}_USDT`;
}

/**
 * Fetch klines for a symbol from the exchange that actually lists it.
 * Uses the universe registry when available, otherwise probes sources in order.
 */
export async function fetchKlinesRouted(
  symbol: string,
  interval: string,
  limit: number,
  options: { deep?: boolean; skipCache?: boolean } = {}
): Promise<Candle[]> {
  const clean = normalizeSymbol(symbol);
  const base = clean.replace(/USDT$/, '');

  if (!symbolIndex.size) {
    try {
      await getUniverse();
    } catch {
      // registry unavailable — probe below
    }
  }

  const entry = lookupUniverseEntry(clean);
  // Exact source first (registry holds the raw pair). Gate/Binance symbols may
  // cross-fallback between those two, but never probe Hyperliquid with a guessed
  // coin name — HL answers unknown coins with slow HTTP 500s.
  const order: UniverseSource[] = entry
    ? [entry.source, ...SOURCE_ORDER.filter((s) => s !== entry.source && s !== 'hyperliquid')]
    : SOURCE_ORDER;

  let lastErr: unknown = null;
  for (const source of order) {
    try {
      let candles: Candle[];
      if (source === 'binance') {
        candles = await fetchBinanceKlines(clean, interval, limit, options);
      } else if (source === 'gate') {
        const pair = entry?.source === 'gate' ? entry.rawPair : deriveGatePair(base);
        candles = await fetchGateCandles(pair, interval, limit);
      } else {
        const coin = entry?.source === 'hyperliquid' ? entry.rawPair : base;
        candles = await fetchHyperliquidCandles(coin, interval, limit);
      }
      if (candles.length > 0) return candles;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`No market data found for ${symbol} on any source`);
}
