import React, { useState, useCallback, useEffect, useRef } from 'react';
import Layout from '../components/Layout/Layout';
import ParameterPanel from '../components/Controls/ParameterPanel';
import DecouplingChart from '../components/Chart/DecouplingChart';
import StatsCard from '../components/Dashboard/StatsCard';
import SignalList from '../components/Dashboard/SignalList';
import RankingTable from '../components/Dashboard/RankingTable';
import BacktestResults from '../components/Dashboard/BacktestResults';
import RegimeIndicator from '../components/Dashboard/RegimeIndicator';
import AutonomousRanking from '../components/Dashboard/AutonomousRanking';
import MultiTimeframePanel from '../components/Dashboard/MultiTimeframePanel';
import { ScanConfig, AssetScanResult, Candle, DecouplingSignal, BacktestResult } from '../lib/types';
import { DEFAULT_SCAN_CONFIG, ASSET_UNIVERSE } from '../lib/config';
import { buildRanges, parseRanges } from '../lib/ranges';
import { RegimeResult } from '../lib/algorithms/marketRegime';
import { AutonomousParams } from '../lib/algorithms/autonomousParams';
import { MultiTimeframeResult } from '../lib/algorithms/multiTimeframe';

const AUTO_CACHE_KEY = 'althunter:last-autonomous';
const AUTO_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

type Depth = 'all' | '100' | '500';

interface AutonomousCache {
  scannedAt: number;
  indexSymbol: string;
  depth: Depth;
  universeId?: string;
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

export default function Home() {
  const [mode, setMode] = useState<'manual' | 'autonomous'>('autonomous');
  const [config, setConfig] = useState<ScanConfig>(DEFAULT_SCAN_CONFIG);

  const [scanResults, setScanResults] = useState<AssetScanResult[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<string>('');
  const [chartCandles, setChartCandles] = useState<Candle[]>([]);
  const [chartSignals, setChartSignals] = useState<DecouplingSignal[]>([]);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);

  const [autoRankings, setAutoRankings] = useState<MultiTimeframeResult[]>([]);
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
  const [progress, setProgress] = useState<{ offset: number; total: number; etaSec: number | null } | null>(null);
  const [sourceCounts, setSourceCounts] = useState<{ binance: number; gate: number; hyperliquid: number } | null>(null);
  /** Monotonic run id — a new run (or stop) invalidates any loop still in flight. */
  const runIdRef = useRef(0);

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

        const windowEnd = offset + 500;
        const skipPositions: number[] = [];
        for (let p = offset; p < windowEnd; p++) {
          if (donePositions.has(p)) skipPositions.push(p);
        }

        const params = new URLSearchParams({
          indexSymbol: config.indexSymbol,
          depth: runDepth,
          offset: String(offset),
          span: '500',
          budgetMs: '15000',
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

        // Universe was rediscovered mid-scan (server restart / TTL) → restart cleanly.
        const universeChanged = universeId !== undefined && data.universeId !== universeId;
        universeId = data.universeId;
        if (universeChanged) {
          donePositions.clear();
          merged = [];
        }

        const deduped = new Map<string, MultiTimeframeResult>();
        for (const r of merged) deduped.set(r.asset, r);
        const positions: number[] = data.positions || [];
        const rankingsChunk: MultiTimeframeResult[] = data.rankings || [];
        for (let i = 0; i < rankingsChunk.length; i++) {
          deduped.set(rankingsChunk[i].asset, rankingsChunk[i]);
          if (positions[i] != null) donePositions.add(positions[i]);
        }
        merged = Array.from(deduped.values()).sort((a, b) => b.confluenceScore - a.confluenceScore);
        total = data.total;

        // Stall guard: three consecutive chunks with zero progress → abort.
        if (data.progress.scannedInChunk > 0) {
          stallCount = 0;
        } else {
          stallCount += 1;
          if (stallCount >= 3) {
            throw new Error('Scan stalled: no symbols completed within the time budget');
          }
        }

        setRegime(data.regime);
        setAutoParams(data.autonomousParams);
        setAutoRankings(merged);
        setTotalScanned(data.total);
        setLastScannedAt(Date.now());
        setSourceCounts(data.sources);
        setProgress({ offset: donePositions.size, total: data.total, etaSec: data.progress.etaSec });

        const done = donePositions.size >= data.total;
        const cachePayload: AutonomousCache = {
          scannedAt: Date.now(),
          indexSymbol: config.indexSymbol,
          depth: runDepth,
          universeId,
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
          void saveScanToSupabase(cachePayload);
          break;
        }
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
  }, [config.indexSymbol, depth]);

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

  useEffect(() => {
    if (!isHydrated || didAutoScanRef.current) return;
    didAutoScanRef.current = true;

    const cached = loadAutonomousCache();
    const matches =
      cached &&
      cached.indexSymbol === config.indexSymbol &&
      (cached.depth ?? 'all') === depth;

    if (matches && cached.done === false) {
      // Interrupted sweep — resume from the saved cursor instead of starting over.
      void runAutonomousScan({
        depth,
        doneRanges: cached.doneRanges,
        rankings: cached.rankings,
        universeId: cached.universeId,
      });
      return;
    }

    const isFresh =
      matches && Date.now() - cached.scannedAt < AUTO_CACHE_MAX_AGE_MS && cached.done !== false;

    if (!isFresh) {
      void runAutonomousScan({ depth });
    }
  }, [isHydrated, config.indexSymbol, depth, runAutonomousScan]);

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

  const handleSelectAsset = useCallback((symbol: string) => {
    setSelectedAsset(symbol);
    runBacktest(symbol);
  }, [runBacktest]);

  const selectedMTF = autoRankings.find((r) => r.asset === selectedAsset) || null;
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
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button onClick={() => setError(null)} style={{
            background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '16px',
          }}>×</button>
        </div>
      )}

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        marginBottom: '20px',
      }}>
        <div style={{
          display: 'flex',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#9ca3af', fontWeight: 600 }}>
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
            {lastScannedAt && (
              <span style={{ fontSize: '11px', color: '#6b7280' }}>
                Last scan: {new Date(lastScannedAt).toLocaleTimeString()}
              </span>
            )}
            {scanning ? (
              <button
                onClick={stopAutonomousScan}
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
            <span style={{ color: '#6b7280' }}>
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

      {mode === 'autonomous' && regime && autoParams && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
          <RegimeIndicator regime={regime} params={autoParams} />
          <MultiTimeframePanel result={selectedMTF} regime={regime} />
        </div>
      )}

      {mode === 'autonomous' && (autoRankings.length > 0 || (scanning && progress)) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '20px' }}>
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
        </div>
      )}

      {mode === 'manual' && scanResults.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '20px' }}>
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
          />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
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