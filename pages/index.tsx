import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/router';
import Layout from '../components/Layout/Layout';
import ParameterPanel from '../components/Controls/ParameterPanel';
import DecouplingChart from '../components/Chart/DecouplingChart';
import StatsCard from '../components/Dashboard/StatsCard';
import SignalList from '../components/Dashboard/SignalList';
import RankingTable from '../components/Dashboard/RankingTable';
import BacktestResults from '../components/Dashboard/BacktestResults';
import RegimeIndicator from '../components/Dashboard/RegimeIndicator';
import AutonomousRanking, {
  SignalFilter,
  SortState,
} from '../components/Dashboard/AutonomousRanking';
import MultiTimeframePanel from '../components/Dashboard/MultiTimeframePanel';
import NarrativeRadar from '../components/Dashboard/NarrativeRadar';
import EarlyWarningFeed from '../components/Dashboard/EarlyWarningFeed';
import TradeableList from '../components/Dashboard/TradeableList';
import ScanHistory from '../components/Dashboard/ScanHistory';
import TopBacktests from '../components/Dashboard/TopBacktests';
import { SkeletonStats } from '../components/Dashboard/Skeleton';
import { buildSectorHeat } from '../lib/algorithms/narrativeHeat';
import { buildEarlyWarnings } from '../lib/algorithms/earlyWarning';
import { notifyNewWarnings } from '../lib/telegram';
import {
  loadSectorHistory,
  recordSectorSnapshot,
  type SectorHistory,
} from '../lib/sectorHistory';
import { ScanConfig, AssetScanResult, Candle, DecouplingSignal, BacktestResult } from '../lib/types';
import { DEFAULT_SCAN_CONFIG, ASSET_UNIVERSE } from '../lib/config';
import { buildRanges, parseRanges } from '../lib/ranges';
import { RegimeResult } from '../lib/algorithms/marketRegime';
import { AutonomousParams } from '../lib/algorithms/autonomousParams';
import { MultiTimeframeResult } from '../lib/algorithms/multiTimeframe';
import {
  ScanHistoryEntry,
  fetchScanHistory,
  loadLocalScanHistory,
  mergeHistory,
  recordScan,
} from '../lib/scanHistory';
import { readUrlState, writeUrlState, sameQuery } from '../lib/urlState';

const AUTO_CACHE_KEY = 'althunter:last-autonomous';
const AUTO_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

type Depth = 'all' | '100' | '500';

interface AutonomousCache {
  scannedAt: number;
  indexSymbol: string;
  depth: Depth;
  universeId?: string;
  /** Which ordering the sweep used. Changing it invalidates the resume cursor. */
  scanOrder?: 'cap' | 'volume';
  /** Resume cursor: first universe position not yet scanned. */
  offset: number;
  /** Compact ranges of every position already scanned (enables gap-free resume). */
  doneRanges?: string;
  /** True when the sweep finished the whole (depth-sliced) universe. */
  done: boolean;
  regime: RegimeResult;
  autonomousParams: AutonomousParams;
  rankings: MultiTimeframeResult[];
  totalScanned: number;
}

function loadAutonomousCache(): AutonomousCache | null {
  try {
    const raw = localStorage.getItem(AUTO_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutonomousCache;
    if (!parsed?.regime) return null;
    // Partial sweeps (offset > 0) are resumable even with few/no rankings yet.
    if (!parsed.rankings?.length && !(parsed.offset > 0)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveAutonomousCache(cache: AutonomousCache): void {
  try {
    localStorage.setItem(AUTO_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // storage full / private mode — ignore
  }
}

async function fetchLastScanFromSupabase(indexSymbol: string): Promise<AutonomousCache | null> {
  try {
    const res = await fetch(`/api/scans?indexSymbol=${encodeURIComponent(indexSymbol)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.found || !data.rankings?.length || !data.regime) return null;
    return {
      scannedAt: data.scannedAt,
      indexSymbol: data.indexSymbol || indexSymbol,
      depth: 'all',
      scanOrder: data.scanOrder,
      offset: data.rankings.length,
      done: true,
      regime: data.regime,
      autonomousParams: data.autonomousParams,
      rankings: data.rankings,
      totalScanned: data.totalScanned ?? data.rankings.length,
    };
  } catch {
    return null;
  }
}

async function saveScanToSupabase(cache: AutonomousCache): Promise<void> {
  try {
    await fetch('/api/scans-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cache),
    });
  } catch {
    // non-fatal — local cache still works
  }
}

/**
 * Compact one-row summary of a completed sweep for the history sparkline.
 * Deliberately not the full rankings: history only needs counts + top tickers.
 */
function toHistoryEntry(cache: AutonomousCache): ScanHistoryEntry {
  const buys: string[] = [];
  const sells: string[] = [];
  for (const r of cache.rankings) {
    if (r.finalSignal === 'strong_buy' || r.finalSignal === 'buy') {
      if (buys.length < 40) buys.push(r.asset.replace('USDT', ''));
    } else if (r.finalSignal === 'strong_sell' || r.finalSignal === 'sell') {
      if (sells.length < 40) sells.push(r.asset.replace('USDT', ''));
    }
  }
  return {
    scannedAt: cache.scannedAt,
    indexSymbol: cache.indexSymbol,
    regimeLabel: cache.regime?.regime ?? null,
    signalsCount: buys.length + sells.length,
    totalScanned: cache.totalScanned,
    buys,
    sells,
  };
}

const SORT_KEYS: ReadonlySet<string> = new Set([
  'signal', 'conf', 'rsz', 'conviction', 'agreement', 'liquidity', 'mcap', 'rank', 'category',
]);

/** One row of the batch backtest result table. */
interface BatchRow {
  asset: string;
  score: number;
  signal: string;
  result: BacktestResult | null;
}

interface BatchState {
  running: boolean;
  done: number;
  total: number;
  rows: BatchRow[];
}

/** `{ conf: 'desc', rsz: 'asc' }` → `conf.desc,rsz.asc` */
function serializeSortParam(sort: SortState): string {
  return Object.entries(sort)
    .filter(([key, dir]) => SORT_KEYS.has(key) && (dir === 'asc' || dir === 'desc'))
    .map(([key, dir]) => `${key}.${dir}`)
    .join(',');
}

/** `conf.desc,rsz.asc` → `{ conf: 'desc', rsz: 'asc' }`, junk keys dropped. */
function parseSortParam(raw: string): SortState {
  const out: SortState = {};
  for (const pair of raw.split(',')) {
    const [key, dir] = pair.split('.');
    if (!key || !SORT_KEYS.has(key)) continue;
    if (dir === 'asc' || dir === 'desc') {
      out[key as keyof SortState] = dir;
    }
  }
  return out;
}

export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<'manual' | 'autonomous'>('autonomous');
  const [config, setConfig] = useState<ScanConfig>(DEFAULT_SCAN_CONFIG);

  const [scanResults, setScanResults] = useState<AssetScanResult[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<string>('');
  const [chartCandles, setChartCandles] = useState<Candle[]>([]);
  const [chartSignals, setChartSignals] = useState<DecouplingSignal[]>([]);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);

  const [autoRankings, setAutoRankings] = useState<MultiTimeframeResult[]>([]);
  const [effectiveOrder, setEffectiveOrder] = useState<'cap' | 'volume' | null>(null);
  const [regime, setRegime] = useState<RegimeResult | null>(null);
  const [autoParams, setAutoParams] = useState<AutonomousParams | null>(null);
  const [totalScanned, setTotalScanned] = useState(0);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [backtesting, setBacktesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const didAutoScanRef = useRef(false);

  const [depth, setDepth] = useState<Depth>('all');
  /**
   * Universe ordering for the sweep. 'cap' walks largest market cap first, so a
   * truncated sweep still covers the most liquid, best-known names instead of
   * stalling in the long tail.
   */
  const [scanOrder, setScanOrder] = useState<'cap' | 'volume'>('cap');
  const [progress, setProgress] = useState<{ offset: number; total: number; etaSec: number | null } | null>(null);
  const [sourceCounts, setSourceCounts] = useState<{ binance: number; gate: number; hyperliquid: number } | null>(null);
  /**
   * Sector selected in the narrative radar. Lifted here because it narrows both
   * panels at once: the radar marks it, and the ranking table filters to it.
   */
  const [focusCategory, setFocusCategory] = useState<string | null>(null);
  /** Ranking table's signal filter + sort — lifted so the URL can carry them. */
  const [rankFilter, setRankFilter] = useState<SignalFilter>('all');
  const [rankSort, setRankSort] = useState<SortState>({});
  /** Merged Supabase + local scan timeline for the history sparkline. */
  const [scanHistory, setScanHistory] = useState<ScanHistoryEntry[]>([]);
  /** Batch backtest of the top signals — see runTopBacktest. */
  const [batch, setBatch] = useState<BatchState>({ running: false, done: 0, total: 0, rows: [] });
  /** Set when a shared link carries `?asset=`, so we know to run its backtest. */
  const urlAssetRef = useRef<string | null>(null);
  /** True once the shared link's query params have been applied. */
  const [urlReady, setUrlReady] = useState(false);
  /** Monotonic run id — a new run (or stop) invalidates any loop still in flight. */
  const runIdRef = useRef(0);
  /**
   * Set when a sweep completes. The Telegram effect consumes it (sends fresh
   * high-severity warnings once) then clears it — so cached history on page
   * load never triggers a notification.
   */
  const scanDoneRef = useRef(false);

  const runManualScan = useCallback(async () => {
    if (config.assetSymbols.length === 0) return;
    setScanning(true);
    setError(null);
    setScanResults([]);
    setBacktestResult(null);

    try {
      const assetsParam = config.assetSymbols.join(',');
      const url = `/api/scan?indexSymbol=${config.indexSymbol}&assets=${assetsParam}&interval=${config.interval}&limit=200&lookback=${config.lookback}&rsPeriod=${config.rsPeriod}&indexThreshold=${config.indexThreshold}&volumeMultiplier=${config.volumeMultiplier}&volumePeriod=${config.volumePeriod}`;

      const response = await fetch(url);
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const results: AssetScanResult[] = await response.json();
      setScanResults(results);
      if (results.length > 0) {
        const withSignals = results.filter((r) => r.signal !== null);
        setSelectedAsset(withSignals.length > 0 ? withSignals[0].symbol : results[0].symbol);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }, [config]);

  interface ScanResume {
    depth?: Depth;
    universeId?: string;
    doneRanges?: string;
    rankings?: MultiTimeframeResult[];
    order?: 'cap' | 'volume';
  }

  const runAutonomousScan = useCallback(async (opts: ScanResume = {}) => {
    const runDepth = opts.depth ?? depth;
    const runId = ++runIdRef.current;
    setScanning(true);
    setError(null);

    const donePositions = parseRanges(opts.doneRanges);
    let merged: MultiTimeframeResult[] = opts.rankings ? [...opts.rankings] : [];
    let universeId = opts.universeId;
    let total: number | null = null;
    let stallCount = 0;
    let stalled = false;
    /**
     * Symbols whose network fetch failed transiently more times than the budget
     * allows. Without this they are re-queued in every chunk forever and the
     * sweep can never finish.
     *
     * Plain Set, not useRef: hooks cannot be called inside a useCallback body,
     * which threw React error #321 and left scanning=true permanently.
     */
    const giveUp = new Set<number>();

    const firstUndone = () => {
      let p = 0;
      while (donePositions.has(p)) p++;
      return p;
    };

    if (donePositions.size === 0) {
      setAutoRankings([]);
      setRegime(null);
      setAutoParams(null);
      setBacktestResult(null);
    }
    setAutoRankings(merged);

    try {
      // Chunked sweep: each request scans a time-budgeted slice of the universe.
      // Already-scanned positions are sent back as ranges so the server skips them.
      while (true) {
        if (runIdRef.current !== runId) break;

        const offset = firstUndone();
        if (total !== null && offset >= total) break;

        // Bound the window by the known universe size. Comparing exhaustion
        // against the nominal 500-bar span instead made the check unreachable
        // whenever total < 500, so the loop could never retire a window and the
        // scan hung at scanning=true forever.
        const windowEnd = Math.min(offset + 500, total ?? offset + 500);
        const windowSize = windowEnd - offset;

        const skipPositions: number[] = [];
        for (let p = offset; p < windowEnd; p++) {
          if (donePositions.has(p) || giveUp.has(p)) skipPositions.push(p);
        }
        if (windowSize > 0 && skipPositions.length >= windowSize) {
          // Whole window retired (all done or abandoned) — close it out so the
          // cursor advances instead of re-requesting the same range.
          for (let p = offset; p < windowEnd; p++) donePositions.add(p);
          continue;
        }

        const params = new URLSearchParams({
          indexSymbol: config.indexSymbol,
          depth: runDepth,
          offset: String(offset),
          span: '500',
          budgetMs: '15000',
          order: scanOrder,
        });
        const skipStr = buildRanges(skipPositions);
        if (skipStr) params.set('skip', skipStr);
        if (universeId) params.set('universeId', universeId);

        const response = await fetch(`/api/autonomous?${params.toString()}`);
        if (runIdRef.current !== runId) break;
        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || `HTTP ${response.status}`);
        }
        const data = await response.json();

        // Universe was rediscovered, or the ORDER changed, mid-scan → restart cleanly.
        // Resuming against a reordered list would splice results from two
        // different sequences into one ranking.
        const orderChanged =
          data.scanOrder != null && data.scanOrder !== scanOrder;
        const universeChanged =
          (universeId !== undefined && data.universeId !== universeId) || orderChanged;
        universeId = data.universeId;
        if (universeChanged) {
          donePositions.clear();
          giveUp.clear();
          merged = [];
        }

        const deduped = new Map<string, MultiTimeframeResult>();
        for (const r of merged) deduped.set(r.asset, r);
        const positions: number[] = data.positions || [];
        const rankingsChunk: MultiTimeframeResult[] = data.rankings || [];
        const failed: number[] = data.failedPositions || [];

        for (let i = 0; i < rankingsChunk.length; i++) {
          deduped.set(rankingsChunk[i].asset, rankingsChunk[i]);
          if (positions[i] != null) donePositions.add(positions[i]);
        }
        // Positions the server closed out but produced no ranking for (dead
        // listings, exhausted retries) must also advance the cursor, otherwise
        // the sweep keeps re-requesting them and never reports done.
        for (const p of failed) {
          giveUp.add(p);
          donePositions.add(p);
        }

        merged = Array.from(deduped.values()).sort((a, b) => b.confluenceScore - a.confluenceScore);
        total = data.total;

        // Progress counts symbols retired from the retry queue too, otherwise a
        // run of dead listings looks exactly like a stall.
        const exhausted = failed.length;
        if (data.progress.scannedInChunk > 0 || exhausted > 0) {
          stallCount = 0;
        } else {
          stallCount += 1;
          if (stallCount >= 3) {
            stalled = true;
            break;
          }
        }

        setRegime(data.regime);
        setAutoParams(data.autonomousParams);
        setAutoRankings(merged);
        if (data.scanOrder) setEffectiveOrder(data.scanOrder);
        setTotalScanned(data.total);
        setLastScannedAt(Date.now());
        setSourceCounts(data.sources);
        setProgress({ offset: donePositions.size, total: data.total, etaSec: data.progress.etaSec });

        const done = donePositions.size >= (data.total ?? 0);
        const cachePayload: AutonomousCache = {
          scannedAt: Date.now(),
          indexSymbol: config.indexSymbol,
          depth: runDepth,
          universeId,
          scanOrder,
          offset: firstUndone(),
          doneRanges: buildRanges(donePositions),
          done,
          regime: data.regime,
          autonomousParams: data.autonomousParams,
          rankings: merged,
          totalScanned: data.total,
        };
        saveAutonomousCache(cachePayload);

        if (done) {
          scanDoneRef.current = true;
          void saveScanToSupabase(cachePayload);
          // Local history writes immediately; the Supabase fetch below merges
          // in the long tail on next load.
          setScanHistory((prev) => mergeHistory([], [...recordScan(toHistoryEntry(cachePayload)), ...prev]));
          break;
        }
      }

      if (stalled && merged.length === 0) {
        throw new Error(
          'Scan stalled: no symbols completed within the time budget. The data source may be rate-limiting — try again shortly or use a smaller coverage.'
        );
      }

      if (merged.length > 0) {
        const withSignals = merged.filter((r) => r.finalSignal !== 'neutral');
        setSelectedAsset(withSignals.length > 0 ? withSignals[0].asset : merged[0].asset);
      }
    } catch (err) {
      if (runIdRef.current === runId) {
        setError(err instanceof Error ? err.message : 'Autonomous scan failed');
      }
    } finally {
      if (runIdRef.current === runId) {
        setScanning(false);
        setProgress(null);
      }
    }
  }, [config.indexSymbol, depth, scanOrder]);

  const stopAutonomousScan = useCallback(() => {
    runIdRef.current += 1;
    setScanning(false);
    setProgress(null);
  }, []);

  const handleDepthChange = useCallback((next: Depth) => {
    setDepth(next);
    void runAutonomousScan({ depth: next });
  }, [runAutonomousScan]);

  const applyCachedScan = useCallback((cached: AutonomousCache) => {
    setRegime(cached.regime);
    setAutoParams(cached.autonomousParams);
    setAutoRankings(cached.rankings);
    setEffectiveOrder(cached.scanOrder ?? null);
    setTotalScanned(cached.totalScanned);
    setLastScannedAt(cached.scannedAt);
    saveAutonomousCache(cached);

    const withSignals = cached.rankings.filter((r) => r.finalSignal !== 'neutral');
    if (withSignals.length > 0) {
      setSelectedAsset(withSignals[0].asset);
    } else if (cached.rankings.length > 0) {
      setSelectedAsset(cached.rankings[0].asset);
    }
  }, []);

  useEffect(() => {
    setIsHydrated(true);
    const cached = loadAutonomousCache();
    if (cached && cached.indexSymbol === config.indexSymbol) {
      applyCachedScan(cached);
    }

    let cancelled = false;
    (async () => {
      const remote = await fetchLastScanFromSupabase(config.indexSymbol);
      if (cancelled || !remote) return;

      const local = loadAutonomousCache();
      if (!local || remote.scannedAt >= local.scannedAt) {
        applyCachedScan(remote);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [config.indexSymbol, applyCachedScan]);

  /**
   * Apply a shared link's query params exactly once, before the auto-scan
   * effect is allowed to run — otherwise the sweep would kick off with default
   * coverage/order and the URL would only repaint the toolbar afterwards.
   */
  useEffect(() => {
    if (!router.isReady || urlReady) return;
    const q = readUrlState(router.query);

    if (q.mode === 'manual') setMode('manual');
    if (q.depth) setDepth(q.depth as Depth);
    if (q.order) setScanOrder(q.order as 'cap' | 'volume');
    if (q.cat) setFocusCategory(q.cat);
    if (q.filter) setRankFilter(q.filter as SignalFilter);
    if (q.sort) setRankSort(parseSortParam(q.sort));
    if (q.asset) {
      urlAssetRef.current = q.asset;
      setSelectedAsset(q.asset);
    }
    setUrlReady(true);
  }, [router.isReady, urlReady, router.query]);

  /**
   * Mirror view state back into the URL so refreshes and pasted links restore
   * the same screen. `shallow` keeps this off the data path — no re-render of
   * the page tree, no history entry per asset click.
   */
  useEffect(() => {
    if (!router.isReady || !urlReady) return;
    const target = writeUrlState({
      mode,
      asset: selectedAsset || undefined,
      cat: focusCategory ?? undefined,
      depth,
      order: scanOrder,
      filter: rankFilter,
      sort: serializeSortParam(rankSort),
    });
    if (sameQuery(router.query, target)) return;
    void router.replace({ pathname: '/', query: target }, undefined, { shallow: true });
  }, [
    router, router.isReady, urlReady, mode, selectedAsset, focusCategory,
    depth, scanOrder, rankFilter, rankSort,
  ]);

  /** Load the scan timeline: local buffer first (instant), then Supabase. */
  useEffect(() => {
    if (!isHydrated) return;
    let cancelled = false;
    setScanHistory(loadLocalScanHistory());
    (async () => {
      const remote = await fetchScanHistory(config.indexSymbol);
      if (cancelled) return;
      setScanHistory((local) => mergeHistory(remote, local));
    })();
    return () => {
      cancelled = true;
    };
  }, [isHydrated, config.indexSymbol]);

  useEffect(() => {
    if (!isHydrated || didAutoScanRef.current || !urlReady) return;
    didAutoScanRef.current = true;

    const cached = loadAutonomousCache();
    const matches =
      cached &&
      cached.indexSymbol === config.indexSymbol &&
      (cached.depth ?? 'all') === depth;

    if (matches && cached.done === false) {
      // Interrupted sweep — resume only if the ordering still matches, otherwise
      // the saved cursor points into a differently-sorted list.
      if ((cached.scanOrder ?? 'volume') === scanOrder) {
        void runAutonomousScan({
          depth,
          doneRanges: cached.doneRanges,
          rankings: cached.rankings,
          universeId: cached.universeId,
        });
        return;
      }
    }

    const isFresh =
      matches &&
      (cached.scanOrder ?? 'volume') === scanOrder &&
      Date.now() - cached.scannedAt < AUTO_CACHE_MAX_AGE_MS &&
      cached.done !== false;

    if (!isFresh) {
      void runAutonomousScan({ depth });
    }
  }, [isHydrated, config.indexSymbol, depth, scanOrder, runAutonomousScan]);

  const runScan = useCallback(() => {
    if (mode === 'autonomous') {
      runAutonomousScan();
    } else {
      runManualScan();
    }
  }, [mode, runAutonomousScan, runManualScan]);

  const runBacktest = useCallback(async (symbol: string) => {
    if (!symbol) return;
    setBacktesting(true);
    setError(null);
    setChartCandles([]);
    setChartSignals([]);
    setBacktestResult(null);

    try {
      const params = autoParams
        ? `lookback=${autoParams.lookback}&rsPeriod=${autoParams.rsPeriod}&indexThreshold=${autoParams.indexThreshold}&volumeMultiplier=${autoParams.volumeMultiplier}&volumePeriod=${autoParams.volumePeriod}`
        : `lookback=${config.lookback}&rsPeriod=${config.rsPeriod}&indexThreshold=${config.indexThreshold}&volumeMultiplier=${config.volumeMultiplier}&volumePeriod=${config.volumePeriod}`;

      const url = `/api/backtest?indexSymbol=${config.indexSymbol}&assetSymbol=${symbol}&interval=${config.interval}&limit=500&${params}`;
      const response = await fetch(url);
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();

        const [indexResponse, assetResponse] = await Promise.all([
        fetch(`/api/klines?symbol=${config.indexSymbol}&interval=${config.interval}&limit=500`),
        fetch(`/api/klines?symbol=${symbol}&interval=${config.interval}&limit=500`),
      ]);
      const indexCandles: Candle[] = await indexResponse.json();
      const assetCandles: Candle[] = await assetResponse.json();

      const minLen = Math.min(assetCandles.length, indexCandles.length);
      setChartCandles(assetCandles.slice(-minLen));
      setChartSignals(data.signals);
      setBacktestResult(data.backtest);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backtest failed');
    } finally {
      setBacktesting(false);
    }
  }, [config, autoParams]);

  /**
   * A shared `?asset=ETHUSDT` should show that asset's chart, not just
   * highlight its row — so run the backtest once rankings exist.
   */
  useEffect(() => {
    const want = urlAssetRef.current;
    if (!want || autoRankings.length === 0 || backtesting) return;
    if (!autoRankings.some((r) => r.asset === want)) {
      // Not in this universe — the link is stale. Drop the intent silently.
      urlAssetRef.current = null;
      return;
    }
    urlAssetRef.current = null;
    runBacktest(want);
  }, [autoRankings, backtesting, runBacktest]);

  const handleSelectAsset = useCallback((symbol: string) => {
    setSelectedAsset(symbol);
    runBacktest(symbol);
  }, [runBacktest]);

  /**
   * Batch backtest of the top-N signals.
   *
   * Backtests normally run one-at-a-time on row click; the common question is
   * actually "are the *top* calls historically real?" — so this runs them as a
   * set and reports which survived. Sequential rather than parallel: each call
   * pulls 1000 candles, and firing five at once just earns a rate limit.
   */
  const runTopBacktest = useCallback(async (n: number) => {
    const candidates = autoRankings
      .filter((r) => r.finalSignal !== 'neutral')
      .slice(0, n);
    if (candidates.length === 0) return;

    setBatch({ running: true, done: 0, total: candidates.length, rows: [] });

    const params = autoParams
      ? `lookback=${autoParams.lookback}&rsPeriod=${autoParams.rsPeriod}&indexThreshold=${autoParams.indexThreshold}&volumeMultiplier=${autoParams.volumeMultiplier}&volumePeriod=${autoParams.volumePeriod}`
      : `lookback=${config.lookback}&rsPeriod=${config.rsPeriod}&indexThreshold=${config.indexThreshold}&volumeMultiplier=${config.volumeMultiplier}&volumePeriod=${config.volumePeriod}`;

    const rows: BatchRow[] = [];
    let failed = 0;

    for (let i = 0; i < candidates.length; i++) {
      const asset = candidates[i].asset;
      try {
        const url = `/api/backtest?indexSymbol=${config.indexSymbol}&assetSymbol=${asset}&interval=${config.interval}&limit=500&${params}`;
        const response = await fetch(url);
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${response.status}`);
        }
        const data = await response.json();
        rows.push({
          asset,
          score: candidates[i].confluenceScore,
          signal: candidates[i].finalSignal,
          result: data.backtest as BacktestResult,
        });
      } catch {
        // One dead pair must not abort the batch — record it and continue.
        failed++;
        rows.push({
          asset,
          score: candidates[i].confluenceScore,
          signal: candidates[i].finalSignal,
          result: null,
        });
      }
      setBatch({ running: true, done: i + 1, total: candidates.length, rows: [...rows] });
    }

    setBatch({ running: false, done: candidates.length, total: candidates.length, rows });
    if (failed > 0 && rows.every((r) => r.result === null)) {
      setError(`Backtest batch gagal total (${failed} aset) — coba lagi sebentar lagi.`);
    }
  }, [autoRankings, autoParams, config]);

  const selectedMTF = autoRankings.find((r) => r.asset === selectedAsset) || null;
  /** Sector-level read, shared by the narrative radar and the tradeable list. */
  const sectors = useMemo(() => buildSectorHeat(autoRankings), [autoRankings]);

  /**
   * Sector history across scans — the time dimension the early warnings need.
   * Appended once per completed scan (keyed by lastScannedAt, deduped by
   * minute inside recordSectorSnapshot), so re-renders never double-count.
   */
  const [sectorHistory, setSectorHistory] = useState<SectorHistory>({});
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setSectorHistory(loadSectorHistory());
  }, [isHydrated]);
  useEffect(() => {
    if (autoRankings.length === 0 || !lastScannedAt) return;
    setSectorHistory(recordSectorSnapshot(sectors, lastScannedAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastScannedAt]);

  /** Early warnings: phase flips + acceleration + persistence, with coins. */
  const warnings = useMemo(
    () => (autoRankings.length === 0 ? [] : buildEarlyWarnings(sectors, sectorHistory, autoRankings)),
    [sectors, sectorHistory, autoRankings]
  );
  const historyDepth = useMemo(() => {
    let max = 0;
    for (const pts of Object.values(sectorHistory)) {
      if (Array.isArray(pts) && pts.length > max) max = pts.length;
    }
    return max;
  }, [sectorHistory]);

  /**
   * Telegram push: only right after a sweep finishes, only unsent
   * high-severity warnings. notifyNewWarnings dedupes by warning id and
   * no-ops when unconfigured/disabled — it never throws.
   */
  useEffect(() => {
    if (warnings.length === 0 || !scanDoneRef.current) return;
    scanDoneRef.current = false;
    void notifyNewWarnings(warnings);
  }, [warnings]);
  const buySignals = mode === 'manual'
    ? scanResults.filter((r) => r.signal?.type === 'buy')
    : autoRankings.filter((r) => r.finalSignal.includes('buy'));
  const sellSignals = mode === 'manual'
    ? scanResults.filter((r) => r.signal?.type === 'sell')
    : autoRankings.filter((r) => r.finalSignal.includes('sell'));

  return (
    <Layout>
      {error && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: '8px',
          color: '#ef4444',
          fontSize: '13px',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '10px',
          flexWrap: 'wrap',
        }}>
          <span style={{ wordBreak: 'break-word', flex: '1 1 240px' }}>{error}</span>
          <span style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            {/* Most failures here are transient (rate limit, connect timeout) —
                the useful action is "try again", not "dismiss". */}
            {!scanning && (
              <button
                onClick={runScan}
                style={{
                  padding: '5px 14px',
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.45)',
                  borderRadius: '6px',
                  color: '#ef4444',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                ↻ Retry
              </button>
            )}
            <button
              onClick={() => setError(null)}
              aria-label="Tutup pesan error"
              style={{
                background: 'none',
                border: 'none',
                color: '#ef4444',
                cursor: 'pointer',
                fontSize: '18px',
                lineHeight: 1,
                padding: '0 4px',
              }}
            >
              ×
            </button>
          </span>
        </div>
      )}

      <div className="ah-toolbar">
        <div className="ah-mode-switch" style={{
          background: '#111827',
          borderRadius: '8px',
          border: '1px solid #374151',
          padding: '3px',
        }}>
          <button
            onClick={() => setMode('autonomous')}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: mode === 'autonomous' ? 'linear-gradient(135deg, #3b82f6, #8b5cf6)' : 'transparent',
              color: mode === 'autonomous' ? 'white' : '#6b7280',
              fontSize: '12px',
              fontWeight: '600',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            🤖 Autonomous
          </button>
          <button
            onClick={() => setMode('manual')}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: mode === 'manual' ? 'linear-gradient(135deg, #3b82f6, #8b5cf6)' : 'transparent',
              color: mode === 'manual' ? 'white' : '#6b7280',
              fontSize: '12px',
              fontWeight: '600',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            🎛️ Manual
          </button>
        </div>

        {mode === 'autonomous' && (
          <div className="ah-toolbar-group" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <label className="ah-field">
              Coverage
              <select
                value={depth}
                onChange={(e) => handleDepthChange(e.target.value as Depth)}
                disabled={scanning}
                style={{
                  padding: '7px 10px',
                  background: '#1f2937',
                  border: '1px solid #374151',
                  borderRadius: '6px',
                  color: '#f9fafb',
                  fontSize: '12px',
                  outline: 'none',
                  cursor: scanning ? 'not-allowed' : 'pointer',
                }}
              >
                <option value="all">All coins (full sweep)</option>
                <option value="500">Top 500 by volume</option>
                <option value="100">Top 100 by volume</option>
              </select>
            </label>
            <label className="ah-field">
              Order
              <select
                value={scanOrder}
                onChange={(e) => setScanOrder(e.target.value as 'cap' | 'volume')}
                disabled={scanning}
                style={{
                  padding: '7px 10px',
                  background: '#1f2937',
                  border: '1px solid #374151',
                  borderRadius: '6px',
                  color: '#f9fafb',
                  fontSize: '12px',
                  outline: 'none',
                  cursor: scanning ? 'not-allowed' : 'pointer',
                }}
              >
                <option value="cap">Market cap ↓ (largest first)</option>
                <option value="volume">Volume ↓</option>
              </select>
            </label>
            {lastScannedAt && (
              <span style={{ fontSize: '11px', color: '#6b7280' }}>
                Last scan: {new Date(lastScannedAt).toLocaleTimeString()}
              </span>
            )}
            {scanning ? (
              <button
                onClick={stopAutonomousScan}
                className="ah-action"
                style={{
                  padding: '8px 20px',
                  background: '#374151',
                  border: '1px solid #4b5563',
                  borderRadius: '8px',
                  color: '#f9fafb',
                  fontSize: '13px',
                  fontWeight: '600',
                  cursor: 'pointer',
                }}
              >
                ⏹ Stop
              </button>
            ) : (
              <button
                onClick={runScan}
                style={{
                  padding: '8px 20px',
                  background: 'linear-gradient(135deg, #10b981, #3b82f6)',
                  border: 'none',
                  borderRadius: '8px',
                  color: 'white',
                  fontSize: '13px',
                  fontWeight: '600',
                  cursor: 'pointer',
                }}
              >
                🔍 Run Autonomous Scan
              </button>
            )}
          </div>
        )}
      </div>

      {mode === 'autonomous' && scanning && progress && progress.total > 0 && (
        <div style={{
          background: '#111827',
          border: '1px solid #374151',
          borderRadius: '10px',
          padding: '12px 16px',
          marginBottom: '20px',
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '4px 12px',
            flexWrap: 'wrap',
            fontSize: '11px',
            color: '#9ca3af',
            marginBottom: '8px',
          }}>
            <span>
              Scanning universe…
              {' '}<strong style={{ color: '#f9fafb' }}>{progress.offset.toLocaleString()}</strong>
              {' / '}{progress.total.toLocaleString()} coins
              {progress.etaSec != null && progress.etaSec > 0 && (
                <span style={{ color: '#6b7280' }}>
                  {' · '}~{progress.etaSec >= 60
                    ? `${Math.ceil(progress.etaSec / 60)} min left`
                    : `${progress.etaSec}s left`}
                </span>
              )}
            </span>
            <span style={{ color: '#6b7280', wordBreak: 'break-word' }}>
              {sourceCounts && `Binance ${sourceCounts.binance.toLocaleString()} · Gate ${sourceCounts.gate.toLocaleString()} · Hyperliquid ${sourceCounts.hyperliquid.toLocaleString()}`}
            </span>
          </div>
          <div style={{ height: '6px', background: '#1f2937', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{
              width: `${Math.min(100, (progress.offset / Math.max(progress.total, 1)) * 100)}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)',
              borderRadius: '3px',
              transition: 'width 0.4s ease',
            }} />
          </div>
        </div>
      )}

      {mode === 'manual' && (
        <div style={{ marginBottom: '20px' }}>
          <ParameterPanel
            config={config}
            onChange={setConfig}
            onScan={runScan}
            loading={scanning}
          />
        </div>
      )}

      {mode === 'autonomous' && autoRankings.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <EarlyWarningFeed
            warnings={warnings}
            historyDepth={historyDepth}
            onFocusCategory={setFocusCategory}
            onSelectAsset={handleSelectAsset}
            focusedCategory={focusCategory}
          />
        </div>
      )}

      {mode === 'autonomous' && autoRankings.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <NarrativeRadar
            rankings={autoRankings}
            focusCategory={focusCategory}
            onFocusCategoryChange={setFocusCategory}
          />
        </div>
      )}

      {mode === 'autonomous' && autoRankings.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <TradeableList
            rankings={autoRankings}
            sectors={sectors}
            onSelectAsset={handleSelectAsset}
            selectedAsset={selectedAsset}
            loading={scanning}
          />
        </div>
      )}

      {mode === 'autonomous' && regime && autoParams && (
        <div className="ah-two-col" style={{ marginBottom: '20px' }}>
          <RegimeIndicator regime={regime} params={autoParams} />
          <MultiTimeframePanel result={selectedMTF} regime={regime} />
        </div>
      )}

      {mode === 'autonomous' && (autoRankings.length > 0 || (scanning && progress)) && (
        <div className="ah-stats" style={{ marginBottom: '20px' }}>
          <StatsCard
            label="Assets Scanned"
            value={
              scanning && progress
                ? `${progress.offset.toLocaleString()} / ${progress.total.toLocaleString()}`
                : autoRankings.length.toLocaleString()
            }
            subtext={
              totalScanned > 0
                ? `Universe: ${totalScanned.toLocaleString()} coins`
                : undefined
            }
            icon="📊"
          />
          <StatsCard label="BUY Signals" value={buySignals.length} color="#10b981" icon="🟢" />
          <StatsCard label="SELL Signals" value={sellSignals.length} color="#ef4444" icon="🔴" />
          <StatsCard label="Regime" value={regime?.regime?.replace(/_/g, ' ') || '—'} icon="📈" />
          <StatsCard
            label="Scan Order"
            value={effectiveOrder === 'cap' ? 'Cap ↓' : effectiveOrder === 'volume' ? 'Volume ↓' : '—'}
            subtext={effectiveOrder === 'cap' ? 'Largest first' : effectiveOrder === 'volume' ? 'By 24h turnover' : undefined}
            icon="🗂"
          />
        </div>
      )}

      {/* First load has no cached scan yet — placeholder grid instead of a jump.
          Only when the real stats block is also absent, to avoid a double row. */}
      {mode === 'autonomous' && scanning && autoRankings.length === 0 && !progress && (
        <SkeletonStats count={5} />
      )}

      {mode === 'autonomous' && scanHistory.length > 0 && (
        <ScanHistory entries={scanHistory} currentRegime={regime?.regime ?? null} />
      )}

      {mode === 'manual' && scanResults.length > 0 && (
        <div className="ah-stats" style={{ marginBottom: '20px' }}>
          <StatsCard label="Assets Scanned" value={scanResults.length} icon="📊" />
          <StatsCard label="BUY Signals" value={buySignals.length} color="#10b981" icon="🟢" />
          <StatsCard label="SELL Signals" value={sellSignals.length} color="#ef4444" icon="🔴" />
          <StatsCard label="Total" value={scanResults.length} icon="📋" />
        </div>
      )}

      {mode === 'autonomous' ? (
        <div style={{ marginBottom: '20px' }}>
          <AutonomousRanking
            rankings={autoRankings}
            onSelectAsset={handleSelectAsset}
            selectedAsset={selectedAsset}
            focusCategory={focusCategory}
            onFocusCategoryChange={setFocusCategory}
            filter={rankFilter}
            onFilterChange={setRankFilter}
            sort={rankSort}
            onSortChange={setRankSort}
            loading={scanning}
          />
        </div>
      ) : (
        <div className="ah-two-col" style={{ marginBottom: '20px' }}>
          <div>
            <RankingTable
              results={scanResults}
              onSelectAsset={handleSelectAsset}
              selectedAsset={selectedAsset}
            />
          </div>
          <div>
            <SignalList results={scanResults} />
          </div>
        </div>
      )}

      {mode === 'autonomous' && (
        <TopBacktests
          rows={batch.rows}
          running={batch.running}
          done={batch.done}
          total={batch.total}
          onRun={() => void runTopBacktest(5)}
          disabled={batch.running || autoRankings.length === 0}
        />
      )}

      {(chartCandles.length > 0 || backtesting) && (
        <div style={{ marginBottom: '20px' }}>
          <DecouplingChart
            assetCandles={chartCandles}
            signals={chartSignals}
            title={`${selectedAsset.replace('USDT', '')}/USDT — ${config.interval} Chart`}
          />
        </div>
      )}

      <div style={{ marginBottom: '20px' }}>
        <BacktestResults result={backtestResult} loading={backtesting} />
      </div>

      <div style={{
        background: '#111827',
        borderRadius: '12px',
        border: '1px solid #374151',
        padding: '20px',
      }}>
        <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', marginBottom: '12px' }}>
          {mode === 'autonomous' ? 'Autonomous Mode — How It Works' : 'Manual Mode — How It Works'}
        </h3>
        {mode === 'autonomous' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px', fontSize: '12px', color: '#9ca3af' }}>
            <div>
              <h4 style={{ color: '#8b5cf6', fontSize: '12px', marginBottom: '6px' }}>1. Market Regime Detection</h4>
              <p>Uses ADX, SMA/EMA alignment, and ATR percentile to classify market as trending, ranging, or volatile. Parameters adapt automatically.</p>
            </div>
            <div>
              <h4 style={{ color: '#3b82f6', fontSize: '12px', marginBottom: '6px' }}>2. Dynamic Parameter Optimization</h4>
              <p>Thresholds, volume filters, and lookback periods adjust based on regime. High volatility = wider thresholds. Low vol = tighter.</p>
            </div>
            <div>
              <h4 style={{ color: '#10b981', fontSize: '12px', marginBottom: '6px' }}>3. Multi-Timeframe Confluence</h4>
              <p>Scans 1h, 4h, and 1d simultaneously. Weights: 1h=20%, 4h=35%, 1d=45%. Requires alignment across timeframes for high-confidence signals.</p>
            </div>
            <div>
              <h4 style={{ color: '#f59e0b', fontSize: '12px', marginBottom: '6px' }}>4. Full-Exchange Universe</h4>
              <p>Auto-discovers every listed coin across Binance, Gate.io and Hyperliquid (2,000+ USDT pairs), ranked by 24h volume. Mid-caps like $LINK or $XPL are never dropped — the list refreshes hourly, so new listings appear on their own.</p>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px', fontSize: '12px', color: '#9ca3af' }}>
            <div>
              <h4 style={{ color: '#3b82f6', fontSize: '12px', marginBottom: '6px' }}>1. RS Z-Score Calculation</h4>
              <p>Computes Asset/Index price ratio, then calculates Z-Score against rolling mean. High Z = outperforming.</p>
            </div>
            <div>
              <h4 style={{ color: '#10b981', fontSize: '12px', marginBottom: '6px' }}>2. Decoupling Detection</h4>
              <p>When index moves ±threshold, scans for opposite/flat asset movement with above-average volume.</p>
            </div>
            <div>
              <h4 style={{ color: '#f59e0b', fontSize: '12px', marginBottom: '6px' }}>3. Volume Confirmation</h4>
              <p>Requires volume to exceed X× its N-period MA. High volume + price stability = institutional absorption.</p>
            </div>
            <div>
              <h4 style={{ color: '#8b5cf6', fontSize: '12px', marginBottom: '6px' }}>4. Backtest Engine</h4>
              <p>ATR-based position sizing, trailing stops, Sharpe/Sortino, Profit Factor, Alpha vs Buy & Hold.</p>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}