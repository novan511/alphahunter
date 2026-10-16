/**
 * Free macro data feed for the analyst.
 *
 * Pulls a small, always-fresh macro snapshot from sources that need no API key:
 *   - Yahoo Finance  → DXY, S&P 500, VIX, 10Y yield, gold
 *   - CoinGecko      → BTC dominance
 *   - FRED           → Fed funds effective rate (DFF) and CPI level
 *
 * Design rules:
 *   - Fetch in parallel; one source failing must not sink the rest.
 *   - Cache to disk with a TTL (macro is slow-moving; 6h default).
 *   - Return null only when nothing at all was fetched — the analyst's macro
 *     guard then forces the model to say the data is unavailable.
 *
 * Honest limits: FRED is daily/monthly, not intraday. There is no reliable
 * keyless economic calendar here, so `upcomingEvents` is left unset.
 */

import fs from 'fs';
import path from 'path';
import { fetchWithRetry } from '../api';
import { MacroContext, hasMacroContent } from './marketAnalyst';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CACHE_FILE = path.join(process.cwd(), '.cache', 'macro', 'context.json');
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

interface YahooQuote {
  price: number | null;
  changePct: number | null;
}

interface CachedMacro {
  expires: number;
  data: MacroContext;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function readCache(): MacroContext | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as CachedMacro;
    if (!parsed?.data || parsed.expires < Date.now()) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeCache(data: MacroContext, ttlMs: number): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const payload: CachedMacro = { expires: Date.now() + ttlMs, data };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload), 'utf8');
  } catch {
    /* cache is best-effort; never block the fetch */
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function fetchYahooQuote(symbol: string): Promise<YahooQuote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const res = await fetchWithRetry(
    url,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
    2,
    400,
    12_000
  );
  if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  const price = typeof meta?.regularMarketPrice === 'number' ? meta.regularMarketPrice : null;
  const changePct =
    typeof meta?.regularMarketChangePercent === 'number' ? meta.regularMarketChangePercent : null;
  return { price, changePct };
}

async function fetchBtcDominance(): Promise<number | null> {
  const res = await fetchWithRetry('https://api.coingecko.com/api/v3/global', {}, 2, 400, 12_000);
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();
  const d = data?.data?.market_cap_percentage?.btc;
  return typeof d === 'number' ? d : null;
}

/** Latest numeric observation from a FRED CSV series (e.g. "DFF", "CPIAUCSL"). */
export function parseFredLatest(text: string): number | null {
  const lines = text.trim().split('\n').slice(1);
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = parseFloat(lines[i].split(',')[1]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

async function fetchFredLatest(seriesId: string): Promise<number | null> {
  const res = await fetchWithRetry(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`,
    {},
    2,
    400,
    12_000
  );
  if (!res.ok) throw new Error(`FRED ${seriesId} HTTP ${res.status}`);
  return parseFredLatest(await res.text());
}

// ---------------------------------------------------------------------------
// Derived note
// ---------------------------------------------------------------------------

export function buildLiquidityNote(
  vix: number | null,
  dxyChangePct: number | null,
  spxChangePct: number | null
): string | undefined {
  const parts: string[] = [];
  if (vix != null) {
    parts.push(
      vix < 15 ? `VIX ${vix.toFixed(1)} (tenang)` : vix <= 25 ? `VIX ${vix.toFixed(1)} (netral)` : `VIX ${vix.toFixed(1)} (cemas)`
    );
  }
  if (dxyChangePct != null) parts.push(dxyChangePct >= 0 ? 'dolar menguat' : 'dolar melemah');
  if (spxChangePct != null) parts.push(spxChangePct >= 0 ? 'ekuitas risk-on' : 'ekuitas risk-off');
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function fmtPct(n: number | null): string {
  if (n == null) return 'n/a';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function pick<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === 'fulfilled' ? r.value : null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface MacroFetchOptions {
  ttlMs?: number;
  skipCache?: boolean;
}

/**
 * Fetch a macro snapshot. Never throws: partial failures become missing fields,
 * and a total failure returns null (which the analyst handles honestly).
 */
export async function fetchMacroContext(
  options: MacroFetchOptions = {}
): Promise<MacroContext | null> {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!options.skipCache) {
    const cached = readCache();
    if (cached) return cached;
  }

  const [dxy, spx, vix, tnx, gold, dominance, funds, cpi] = await Promise.allSettled([
    fetchYahooQuote('DX-Y.NYB'),
    fetchYahooQuote('^GSPC'),
    fetchYahooQuote('^VIX'),
    fetchYahooQuote('^TNX'),
    fetchYahooQuote('GC=F'),
    fetchBtcDominance(),
    fetchFredLatest('DFF'),
    fetchFredLatest('CPIAUCSL'),
  ]);

  const dxyQ = pick(dxy);
  const spxQ = pick(spx);
  const vixQ = pick(vix);
  const tnxQ = pick(tnx);
  const goldQ = pick(gold);
  const dom = pick(dominance);
  const fundsRate = pick(funds);
  const cpiLevel = pick(cpi);

  const macro: MacroContext = {
    asOf: new Date().toISOString(),
    fedFundRate: fundsRate != null ? `Fed funds ${fundsRate.toFixed(2)}% (efektif, harian)` : undefined,
    dxy: dxyQ && dxyQ.price != null ? `DXY ${dxyQ.price.toFixed(2)} (${fmtPct(dxyQ.changePct)} 5 hari)` : undefined,
    btcDominance: dom != null ? `BTC dominance ${dom.toFixed(1)}%` : undefined,
    sp500Trend: spxQ ? `S&P 500 ${fmtPct(spxQ.changePct)} (5 hari)` : undefined,
    vix: vixQ && vixQ.price != null ? `VIX ${vixQ.price.toFixed(2)}` : undefined,
    treasury10y: tnxQ && tnxQ.price != null ? `US 10Y ${tnxQ.price.toFixed(2)}%` : undefined,
    gold: goldQ && goldQ.price != null ? `Gold ${goldQ.price.toFixed(0)} (${fmtPct(goldQ.changePct)} 5 hari)` : undefined,
    cpi: cpiLevel != null ? `CPI ${cpiLevel.toFixed(1)} (indeks)` : undefined,
    liquidityNote: buildLiquidityNote(
      vixQ?.price ?? null,
      dxyQ?.changePct ?? null,
      spxQ?.changePct ?? null
    ),
  };

  if (!hasMacroContent(macro)) return null;
  writeCache(macro, ttl);
  return macro;
}
