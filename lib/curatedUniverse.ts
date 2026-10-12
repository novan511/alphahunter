/**
 * Curated scan universe: top market cap + narrative leaders + high-volume
 * outsiders. Replaces the "scan all 1890 listings" default, whose tail is
 * mostly random micro-caps that burn budget and add noise.
 *
 * Composition (ordered — sweep scans in this order):
 *   1. Top N by market cap that trade on our venues (default 150).
 *   2. Top K per narrative by market cap (default 4), skipping anything
 *      already picked. This is what guarantees meme/AI/L2/DeFi/RWA coverage
 *      even when a narrative leader sits outside the top 150.
 *   3. Top M by 24h volume outside the picked set (default 25). Proxy for
 *      "new or hyped": a coin doing huge turnover without a top-250 cap is
 *      usually a fresh listing or an ongoing catalyst, which is exactly the
 *      "beberapa coin baru" slot.
 *
 * Deliberate non-goals:
 * - "Famous small caps" have no on-chain definition of fame. Volume is the
 *   measurable proxy, and anything truly famous shows up in volume.
 * - No listing-date source is available, so "new" is approximated by
 *   high-volume + outside-top-cap. Documented as a proxy, not a fact.
 * - Leveraged tokens, stablecoins and fiat pegs are already excluded by
 *   mergeListings and stay excluded here.
 */

import { getUniverse, UniverseEntry, orderId } from './universe';
import { getMarketCaps, lookupCap } from './marketCap';
import { categoryFor, isNonDirectional } from './assetCategory';

/**
 * Composition must be identical for every chunk of a sweep, because the client
 * resumes by absolute position. Recomputing it per request made the list drift
 * whenever a venue listing call failed (a partial Gate response drops coins),
 * which changed universeId mid-sweep and forced a restart — the sweep could
 * never reach `done` and re-ran on every page load.
 *
 * Held in module scope for COMPOSITION_TTL_MS so all chunks of a sweep share
 * one list. Long enough to cover a full sweep, short enough that a new hour
 * of listings eventually enters the rotation.
 */
const COMPOSITION_TTL_MS = 20 * 60 * 1000;
type CachedComposition = { at: number; result: CuratedUniverse };
let compositionCache: CachedComposition | null = null;

export interface CuratedUniverse {
  entries: UniverseEntry[];
  /** Stable id for resume protocol — changes when membership/order changes. */
  id: string;
  counts: {
    topCap: number;
    narrative: number;
    outsiders: number;
    total: number;
  };
}

export interface CuratedOptions {
  topCap?: number;
  perNarrative?: number;
  outsiders?: number;
  maxTotal?: number;
  /**
   * 24h quote-volume floor in USD. A top-cap rank with no turnover is either
   * a dead listing or an inflated-supply game — both are unscannable. Coins
   * below the floor are dropped from every bucket, not demoted.
   */
  minVolume?: number;
}

/** Narratives worth guaranteeing coverage for, in priority order. */
const NARRATIVES = [
  'meme',
  'ai',
  'l2',
  'defi',
  'gaming',
  'rwa',
  'liquid_staking',
  'perps',
  'oracle',
  'privacy',
  'storage',
  'nft',
  'exchange',
  'payments',
  'infra',
] as const;

function bareTicker(symbol: string): string {
  return symbol.replace(/USDT$|USDC$|FDUSD$|BUSD$/, '');
}

/** Drop the memo — used by tests and by a forced rebuild after a venue fix. */
export function resetCuratedCache(): void {
  compositionCache = null;
}

export async function buildCuratedUniverse(
  opts: CuratedOptions = {},
): Promise<CuratedUniverse> {
  const cached = compositionCache;
  if (cached && Date.now() - cached.at < COMPOSITION_TTL_MS) {
    return cached.result;
  }
  const fresh = await composeCuratedUniverse(opts);
  // Only a healthy composition is memoised. Caching the volume fallback would
  // pin a degraded basket for the whole TTL.
  if (!fresh.id.startsWith('volfallback:')) {
    compositionCache = { at: Date.now(), result: fresh };
  }
  return fresh;
}

async function composeCuratedUniverse(opts: CuratedOptions): Promise<CuratedUniverse> {
  const topCapN = opts.topCap ?? 150;
  const perNarrative = opts.perNarrative ?? 4;
  const outsidersN = opts.outsiders ?? 25;
  const maxTotal = opts.maxTotal ?? 260;
  const minVolume = opts.minVolume ?? 500_000;

  const [universe, caps] = await Promise.all([
    getUniverse(),
    Promise.race([
      getMarketCaps(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]).catch(() => null),
  ]);

  // No CoinGecko → no cap ranking possible. Falling back to raw volume order
  // is deliberately NOT cached: a degraded composition cached for 20 minutes
  // would silently replace the curated basket with a worse one for the rest of
  // the TTL. A one-off degraded run is better than a durable wrong one.
  if (!caps) {
    console.warn('[curated] market caps unavailable — falling back to top-volume slice (not cached)');
    const entries = universe.entries.slice(0, maxTotal);
    return {
      entries,
      id: `volfallback:${universe.id}`,
      counts: { topCap: entries.length, narrative: 0, outsiders: 0, total: entries.length },
    };
  }

  const bySymbol = new Map<string, UniverseEntry>();
  for (const e of universe.entries) bySymbol.set(e.symbol, e);

  const picked: UniverseEntry[] = [];
  const pickedSyms = new Set<string>();
  const dropped = { thin: 0, peg: 0, weird: 0, obscure: 0 };
  /**
   * Famous but thin or venue-exclusive. Hand-curated, deliberately tiny:
   * every entry here is a judgment call, so the list must stay short enough
   * to review at a glance. Anything that can pass the measurable rules
   * below does not belong here.
   */
  const KEEP = new Set(['GNO', 'TRAC']);
  /** One gate for every bucket: liquid, directional, sane symbol. */
  const eligible = (e: UniverseEntry): boolean => {
    if (!/^[A-Z0-9]+USDT$/.test(e.symbol)) { dropped.weird++; return false; }
    if (isNonDirectional(categoryFor(e.symbol))) { dropped.peg++; return false; }
    if ((e.quoteVolume ?? 0) < minVolume) { dropped.thin++; return false; }
    return true;
  };
  /**
   * Fame proxy for the core buckets (top-cap + narrative). A Binance spot
   * listing means it passed a listing review; $5M+ daily turnover means the
   * market watches it regardless of venue. Gate-only micro-caps with
   * mid-range volume fail here — that is the "terlalu random" filter.
   * Outsiders are exempt: thin-but-hyped is their entire job description.
   */
  const famous = (e: UniverseEntry): boolean => {
    if (e.source === 'binance') return true;
    if ((e.quoteVolume ?? 0) >= 5_000_000) return true;
    return KEEP.has(bareTicker(e.symbol));
  };
  const pick = (e: UniverseEntry, core = true): boolean => {
    if (pickedSyms.has(e.symbol)) return false;
    if (picked.length >= maxTotal) return false;
    const bare = bareTicker(e.symbol);
    if (!KEEP.has(bare)) {
      if (!eligible(e)) return false;
      if (core && !famous(e)) { dropped.obscure++; return false; }
    }
    pickedSyms.add(e.symbol);
    picked.push(e);
    return true;
  };

  // Cap-ranked CoinGecko entries that actually trade on our venues.
  const ranked: Array<{ entry: UniverseEntry; cap: number }> = [];
  caps.forEach((info, cgSym) => {
    const entry = bySymbol.get(`${cgSym}USDT`) ?? bySymbol.get(`${cgSym}USDC`);
    if (!entry) return;
    ranked.push({ entry, cap: info.marketCap });
  });
  ranked.sort((a, b) => b.cap - a.cap);

  let topCap = 0;
  for (const r of ranked) {
    if (topCap >= topCapN) break;
    if (pick(r.entry)) topCap++;
  }

  // Narrative leaders by cap within each category.
  let narrative = 0;
  const capOf = (e: UniverseEntry): number =>
    lookupCap(caps, bareTicker(e.symbol))?.marketCap ?? 0;
  for (const narrativeId of NARRATIVES) {
    const members = universe.entries
      .filter((e) => !pickedSyms.has(e.symbol) && categoryFor(e.symbol) === narrativeId)
      .map((e) => ({ e, cap: capOf(e) }))
      .sort((a, b) => b.cap - a.cap)
      .slice(0, perNarrative);
    for (const m of members) {
      if (m.cap <= 0) continue; // unknown cap = cannot rank = skip, not guess
      if (pick(m.e)) narrative++;
    }
  }

  // High-volume outsiders: turnover without top-cap status. Higher bar here
  // on purpose — these are picked on attention alone, so demand real flow.
  let outsiders = 0;
  const byVol = [...universe.entries]
    .filter((e) => !pickedSyms.has(e.symbol) && (e.quoteVolume ?? 0) >= Math.max(minVolume, 1_000_000))
    .sort((a, b) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0));
  for (const e of byVol) {
    if (outsiders >= outsidersN) break;
    if (pick(e, false)) outsiders++;
  }

  console.log(
    `[curated] dropped: ${dropped.thin} thin-volume, ${dropped.peg} pegs, ` +
    `${dropped.weird} nonstandard symbols, ${dropped.obscure} obscure (gate-only, low flow)`,
  );

  return {
    entries: picked,
    id: `curated:${orderId(picked.map((e) => e.symbol))}`,
    counts: { topCap, narrative, outsiders, total: picked.length },
  };
}
