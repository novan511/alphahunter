import React, { useState, useCallback, useEffect, useMemo } from 'react';
import Layout from '../components/Layout/Layout';
import StatsCard from '../components/Dashboard/StatsCard';
import { Candle } from '../lib/types';
import { IDX_STOCK_CATEGORIES, ALL_IDX_TICKERS, getYahooParams } from '../lib/idxConfig';
import DecouplingChart from '../components/Chart/DecouplingChart';
import BacktestResults from '../components/Dashboard/BacktestResults';
import { BacktestResult } from '../lib/types';
import { useAIExplanation } from '../lib/useAIExplanation';

interface IDXScanResult {
  ticker: string;
  currentRSZScore: number;
  rsMomentum: number;
  stockReturn: number;
  indexReturn: number;
  volumeRatio: number;
  signal: {
    type: 'buy' | 'sell';
    strength: number;
    rsZScore: number;
    indexReturn: number;
    assetReturn: number;
    volumeRatio: number;
    reason: string;
  } | null;
  rank: number;
}

interface IdxScanCache {
  scannedAt: number;
  interval: string;
  indexThreshold: number;
  volumeMultiplier: number;
  categories: string[];
  results: IDXScanResult[];
}

const IDX_CACHE_KEY = 'althunter:last-idx-scan';

function loadIdxCache(): IdxScanCache | null {
  try {
    const raw = localStorage.getItem(IDX_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as IdxScanCache;
    if (!parsed?.results?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveIdxCache(cache: IdxScanCache): void {
  try {
    localStorage.setItem(IDX_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // storage full / private mode — ignore
  }
}

async function fetchLastIdxScanFromSupabase(): Promise<IdxScanCache | null> {
  try {
    const res = await fetch('/api/idx-scan-history');
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.found || !data.results?.length) return null;
    return {
      scannedAt: data.scannedAt,
      interval: data.interval || '1d',
      indexThreshold: data.indexThreshold ?? 2,
      volumeMultiplier: data.volumeMultiplier ?? 1.5,
      categories: data.categories ?? [],
      results: data.results,
    };
  } catch {
    return null;
  }
}

async function saveIdxScanToSupabase(cache: IdxScanCache): Promise<void> {
  try {
    await fetch('/api/idx-scan-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cache),
    });
  } catch {
    // non-fatal — local cache still works
  }
}

const TF_OPTIONS = [
  { value: '1d', label: 'Daily' },
  { value: '1w', label: 'Weekly' },
  { value: '1mo', label: 'Monthly' },
];

const SIGNAL_COLORS: Record<string, string> = {
  buy: '#10b981',
  sell: '#ef4444',
};

export default function IDXPage() {
  const [results, setResults] = useState<IDXScanResult[]>([]);
  const [selectedTicker, setSelectedTicker] = useState<string>('');
  const [selectedName, setSelectedName] = useState<string>('');
  const [chartCandles, setChartCandles] = useState<Candle[]>([]);
  const [chartSignals, setChartSignals] = useState<any[]>([]);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedInterval, setSelectedInterval] = useState('1d');
  const [selectedCategories, setSelectedCategories] = useState<string[]>(['Blue Chips', 'Bank', 'Telco & Tech']);
  const [indexThreshold, setIndexThreshold] = useState(2);
  const [volumeMultiplier, setVolumeMultiplier] = useState(1.5);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);
  const { explanation, loading: aiLoading, fetchExplanation } = useAIExplanation();

  const toggleCategory = (cat: string) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const getTickerList = useCallback(() => {
    const matched = IDX_STOCK_CATEGORIES.filter((cat) =>
      selectedCategories.includes(cat.name)
    );
    return Array.from(new Set(matched.flatMap((c) => c.stocks.map((s) => s.ticker))));
  }, [selectedCategories]);

  const applyCachedScan = useCallback((cached: IdxScanCache) => {
    setResults(cached.results);
    setLastScannedAt(cached.scannedAt);
    setSelectedInterval(cached.interval || '1d');
    setIndexThreshold(cached.indexThreshold ?? 2);
    setVolumeMultiplier(cached.volumeMultiplier ?? 1.5);
    if (cached.categories?.length) {
      setSelectedCategories(cached.categories);
    }

    const withSignals = cached.results.filter((r) => r.signal !== null);
    if (withSignals.length > 0) {
      setSelectedTicker(withSignals[0].ticker);
    } else if (cached.results.length > 0) {
      setSelectedTicker(cached.results[0].ticker);
    }
    saveIdxCache(cached);
  }, []);

  useEffect(() => {
    const cached = loadIdxCache();
    if (cached) {
      applyCachedScan(cached);
    }

    let cancelled = false;
    (async () => {
      const remote = await fetchLastIdxScanFromSupabase();
      if (cancelled || !remote) return;

      const local = loadIdxCache();
      if (!local || remote.scannedAt >= local.scannedAt) {
        applyCachedScan(remote);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyCachedScan]);

  const runScan = useCallback(async () => {
    const tickerList = getTickerList();
    if (tickerList.length === 0) return;

    setScanning(true);
    setError(null);
    setResults([]);

    try {
      const tickersParam = tickerList.join(',');
      const url = `/api/idx-scan?tickers=${tickersParam}&interval=${selectedInterval}&lookback=6&indexThreshold=${indexThreshold / 100}&volumeMultiplier=${volumeMultiplier}&volumePeriod=20`;

      const response = await fetch(url);
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const data: IDXScanResult[] = await response.json();
      const scannedAt = Date.now();
      const cachePayload: IdxScanCache = {
        scannedAt,
        interval: selectedInterval,
        indexThreshold,
        volumeMultiplier,
        categories: selectedCategories,
        results: data,
      };

      setResults(data);
      setLastScannedAt(scannedAt);
      saveIdxCache(cachePayload);
      void saveIdxScanToSupabase(cachePayload);

      if (data.length > 0) {
        const withSignals = data.filter((r) => r.signal !== null);
        if (withSignals.length > 0) {
          setSelectedTicker(withSignals[0].ticker);
          setSelectedName('');
        } else {
          setSelectedTicker(data[0].ticker);
          setSelectedName('');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }, [getTickerList, selectedInterval, indexThreshold, volumeMultiplier, selectedCategories]);

  const runBacktest = useCallback(async (ticker: string) => {
    if (!ticker) return;

    setLoading(true);
    setError(null);
    setChartCandles([]);
    setChartSignals([]);
    setBacktestResult(null);

    try {
      const yahooParams = getYahooParams(selectedInterval);
      const url = `/api/idx-klines?symbol=${ticker}&interval=${selectedInterval}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch stock data');

      const stockCandles: Candle[] = await response.json();

      const indexUrl = `/api/idx-klines?symbol=^JKSE&interval=${selectedInterval}`;
      const indexResponse = await fetch(indexUrl);
      const indexCandles: Candle[] = await indexResponse.json();

      const minLen = Math.min(stockCandles.length, indexCandles.length);
      const trimmedStock = stockCandles.slice(-minLen);
      const trimmedIndex = indexCandles.slice(-minLen);

      setChartCandles(trimmedStock);

      setBacktestResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chart data');
    } finally {
      setLoading(false);
    }
  }, [selectedInterval]);

  const handleSelectTicker = (ticker: string) => {
    setSelectedTicker(ticker);
    runBacktest(ticker);

    const selectedResult = results.find((r) => r.ticker === ticker);
    if (selectedResult?.signal) {
      fetchExplanation({
        asset: ticker,
        timeframes: [{
          timeframe: selectedInterval,
          signal: null,
          rsZScore: selectedResult.currentRSZScore,
          trendDirection: selectedResult.currentRSZScore > 0 ? 'bullish' : selectedResult.currentRSZScore < 0 ? 'bearish' : 'neutral',
          signalAgeBars: null,
        }],
        confluenceScore: Math.min(Math.abs(selectedResult.currentRSZScore) * 50, 100),
        confluenceDirection: selectedResult.currentRSZScore > 0 ? 'bullish' : 'bearish',
        finalSignal: selectedResult.signal.type === 'buy' ? 'buy' : 'sell',
        newestSignalAgeBars: null,
      });
    }
  };

  const [signalSort, setSignalSort] = useState<'desc' | 'asc' | null>(null);

  const sortedResults = useMemo(() => {
    if (!signalSort) return results;

    const dir = signalSort === 'desc' ? 1 : -1;
    const signalRank = (r: IDXScanResult) => {
      if (!r.signal) return 0;
      const base = r.signal.type === 'buy' ? 10 : -10;
      return base + (r.signal.strength || 0);
    };

    return [...results].sort((a, b) => {
      const diff = (signalRank(a) - signalRank(b)) * dir;
      if (diff !== 0) return diff;
      return b.currentRSZScore - a.currentRSZScore;
    });
  }, [results, signalSort]);

  const buySignals = results.filter((r) => r.signal?.type === 'buy');
  const sellSignals = results.filter((r) => r.signal?.type === 'sell');

  const handleSignalSort = () => {
    setSignalSort((prev) => {
      if (prev === null) return 'desc';
      if (prev === 'desc') return 'asc';
      return null;
    });
  };

  const signalSortLabel =
    signalSort === 'desc' ? ' ▼' : signalSort === 'asc' ? ' ▲' : '';

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
        background: '#111827',
        borderRadius: '12px',
        border: '1px solid #374151',
        padding: '16px',
        marginBottom: '20px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: '16px', fontWeight: '600', color: '#f9fafb', margin: 0 }}>
              🇮🇩 IDX / IHSG — Relative Strength Scanner
            </h2>
            {lastScannedAt && (
              <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                Last scan: {new Date(lastScannedAt).toLocaleString()}
              </div>
            )}
          </div>
          <button
            onClick={runScan}
            disabled={scanning || getTickerList().length === 0}
            style={{
              padding: '8px 20px',
              background: scanning ? '#374151' : 'linear-gradient(135deg, #10b981, #3b82f6)',
              border: 'none',
              borderRadius: '8px',
              color: 'white',
              fontSize: '13px',
              fontWeight: '600',
              cursor: scanning ? 'not-allowed' : 'pointer',
              opacity: scanning ? 0.6 : 1,
            }}
          >
            {scanning ? 'Scanning...' : `🔍 Scan ${getTickerList().length} Stocks`}
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: '600' }}>
              Timeframe
            </label>
            <select
              value={selectedInterval}
              onChange={(e) => setSelectedInterval(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '6px',
                color: '#f9fafb',
                fontSize: '13px',
                outline: 'none',
              }}
            >
              {TF_OPTIONS.map((tf) => (
                <option key={tf.value} value={tf.value}>{tf.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: '600' }}>
              Index Threshold (%)
            </label>
            <input
              type="number"
              value={indexThreshold}
              onChange={(e) => setIndexThreshold(parseFloat(e.target.value) || 2)}
              step={0.5}
              min={0.5}
              max={10}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '6px',
                color: '#f9fafb',
                fontSize: '13px',
                outline: 'none',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: '600' }}>
              Volume Multiplier
            </label>
            <input
              type="number"
              value={volumeMultiplier}
              onChange={(e) => setVolumeMultiplier(parseFloat(e.target.value) || 1.5)}
              step={0.1}
              min={1}
              max={5}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '6px',
                color: '#f9fafb',
                fontSize: '13px',
                outline: 'none',
              }}
            />
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <label style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600' }}>
              Sectors ({selectedCategories.length} selected)
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setSelectedCategories(IDX_STOCK_CATEGORIES.map((c) => c.name))} style={{
                padding: '2px 8px', background: '#374151', border: 'none', borderRadius: '4px',
                color: '#9ca3af', fontSize: '10px', cursor: 'pointer',
              }}>All</button>
              <button onClick={() => setSelectedCategories([])} style={{
                padding: '2px 8px', background: '#374151', border: 'none', borderRadius: '4px',
                color: '#9ca3af', fontSize: '10px', cursor: 'pointer',
              }}>None</button>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {IDX_STOCK_CATEGORIES.map((cat) => {
              const isSelected = selectedCategories.includes(cat.name);
              return (
                <button
                  key={cat.name}
                  onClick={() => toggleCategory(cat.name)}
                  style={{
                    padding: '4px 10px',
                    background: isSelected ? 'rgba(16, 185, 129, 0.2)' : '#1f2937',
                    border: `1px solid ${isSelected ? '#10b981' : '#374151'}`,
                    borderRadius: '4px',
                    color: isSelected ? '#10b981' : '#6b7280',
                    fontSize: '11px',
                    cursor: 'pointer',
                    fontWeight: isSelected ? '600' : '400',
                  }}
                >
                  {cat.name} ({cat.stocks.length})
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {results.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '20px' }}>
          <StatsCard label="Stocks Scanned" value={results.length} icon="📊" />
          <StatsCard label="BUY Signals" value={buySignals.length} color="#10b981" icon="🟢" />
          <StatsCard label="SELL Signals" value={sellSignals.length} color="#ef4444" icon="🔴" />
          <StatsCard label="Index" value="IHSG" subtext="^JKSE" icon="🇮🇩" />
        </div>
      )}

      {results.length > 0 && (
        <div style={{
          background: '#111827',
          borderRadius: '12px',
          border: '1px solid #374151',
          overflow: 'hidden',
          marginBottom: '20px',
        }}>
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid #374151',
          }}>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', margin: 0 }}>
              IDX Ranking ({results.length} stocks)
            </h3>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #374151' }}>
                  <th style={thStyle}>#</th>
                  <th style={thStyle}>Ticker</th>
                  <th style={thStyle}>RS Z-Score</th>
                  <th style={thStyle}>RS Mom</th>
                  <th style={thStyle}>Stock Ret</th>
                  <th style={thStyle}>IHSG Ret</th>
                  <th style={thStyle}>Vol Ratio</th>
                  <th
                    style={{
                      ...thStyle,
                      cursor: 'pointer',
                      userSelect: 'none',
                      color: signalSort ? '#3b82f6' : '#6b7280',
                    }}
                    onClick={handleSignalSort}
                    title="Click to sort by signal (best → worst → default)"
                  >
                    Signal{signalSortLabel}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedResults.map((result) => {
                  const isSelected = result.ticker === selectedTicker;
                  return (
                    <tr
                      key={result.ticker}
                      onClick={() => handleSelectTicker(result.ticker)}
                      style={{
                        borderBottom: '1px solid #1f2937',
                        cursor: 'pointer',
                        background: isSelected ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = 'rgba(59, 130, 246, 0.05)';
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <td style={tdStyle}>{result.rank}</td>
                      <td style={{ ...tdStyle, fontWeight: '600', color: '#f9fafb' }}>
                        {result.ticker}
                      </td>
                      <td style={{ ...tdStyle, color: getZScoreColor(result.currentRSZScore) }}>
                        {result.currentRSZScore.toFixed(2)}
                      </td>
                      <td style={{ ...tdStyle, color: result.rsMomentum > 0 ? '#10b981' : '#ef4444' }}>
                        {result.rsMomentum > 0 ? '+' : ''}{result.rsMomentum.toFixed(4)}
                      </td>
                      <td style={{ ...tdStyle, color: result.stockReturn > 0 ? '#10b981' : '#ef4444' }}>
                        {result.stockReturn > 0 ? '+' : ''}{result.stockReturn.toFixed(2)}%
                      </td>
                      <td style={{ ...tdStyle, color: result.indexReturn > 0 ? '#10b981' : '#ef4444' }}>
                        {result.indexReturn > 0 ? '+' : ''}{result.indexReturn.toFixed(2)}%
                      </td>
                      <td style={{ ...tdStyle, color: '#f59e0b' }}>
                        {result.volumeRatio.toFixed(2)}x
                      </td>
                      <td style={tdStyle}>
                        {result.signal ? (
                          <span style={{
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontSize: '10px',
                            fontWeight: '700',
                            background: `${SIGNAL_COLORS[result.signal.type]}20`,
                            color: SIGNAL_COLORS[result.signal.type],
                          }}>
                            {result.signal.type.toUpperCase()}
                          </span>
                        ) : (
                          <span style={{ color: '#6b7280' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(chartCandles.length > 0 || loading) && (
        <div style={{ marginBottom: '20px' }}>
          <DecouplingChart
            assetCandles={chartCandles}
            signals={chartSignals}
            title={`${selectedTicker} — ${selectedInterval.toUpperCase()} Chart vs IHSG`}
          />
        </div>
      )}

      {(explanation || aiLoading) && selectedTicker && (
        <div style={{
          background: '#111827',
          borderRadius: '12px',
          border: '1px solid #374151',
          padding: '16px',
          marginBottom: '20px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <span style={{ fontSize: '14px' }}>✨</span>
            <span style={{ fontSize: '12px', fontWeight: '600', color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              AI Analysis — {selectedTicker}
            </span>
          </div>
          {aiLoading ? (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', padding: '8px 0' }}>
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#3b82f6', animation: 'pulse 1s infinite' }} />
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#3b82f6', animation: 'pulse 1s infinite 0.2s' }} />
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#3b82f6', animation: 'pulse 1s infinite 0.4s' }} />
              <span style={{ fontSize: '12px', color: '#6b7280', marginLeft: '8px' }}>Analysing {selectedTicker}...</span>
            </div>
          ) : (
            <div style={{ fontSize: '13px', color: '#d1d5db', lineHeight: '1.7' }}>
              {explanation}
            </div>
          )}
        </div>
      )}

      <div style={{
        background: '#111827',
        borderRadius: '12px',
        border: '1px solid #374151',
        padding: '20px',
        marginTop: '20px',
      }}>
        <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', marginBottom: '12px' }}>
          IDX Relative Strength — How It Works
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px', fontSize: '12px', color: '#9ca3af' }}>
          <div>
            <h4 style={{ color: '#3b82f6', fontSize: '12px', marginBottom: '6px' }}>1. IHSG as Index</h4>
            <p>Uses IHSG (JCI / ^JKSE) as the benchmark index. Compares each stock&apos;s performance against IHSG using RS Z-Score.</p>
          </div>
          <div>
            <h4 style={{ color: '#10b981', fontSize: '12px', marginBottom: '6px' }}>2. Sector Scanning</h4>
            <p>Scan by sector: Blue Chips, Banks, Telco, Consumer, Mining, Plantation, Property, Industry, Infrastructure, Auto.</p>
          </div>
          <div>
            <h4 style={{ color: '#f59e0b', fontSize: '12px', marginBottom: '6px' }}>3. Volume Confirmation</h4>
            <p>Requires above-average volume to confirm institutional absorption. Detects when large buyers are accumulating against IHSG weakness.</p>
          </div>
          <div>
            <h4 style={{ color: '#8b5cf6', fontSize: '12px', marginBottom: '6px' }}>4. Daily/Weekly/Monthly</h4>
            <p>Supports multiple timeframes via Yahoo Finance. Daily for short-term, Weekly for swing, Monthly for positional.</p>
          </div>
        </div>
      </div>
    </Layout>
  );
}

function getZScoreColor(z: number): string {
  if (z > 1.5) return '#10b981';
  if (z > 0.5) return '#34d399';
  if (z > -0.5) return '#9ca3af';
  if (z > -1.5) return '#f87171';
  return '#ef4444';
}

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  fontSize: '10px',
  fontWeight: '700',
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const tdStyle: React.CSSProperties = {
  padding: '8px 10px',
  color: '#9ca3af',
  fontSize: '12px',
};