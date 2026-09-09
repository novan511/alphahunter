import React, { useState, useCallback } from 'react';
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
import { RegimeResult } from '../lib/algorithms/marketRegime';
import { AutonomousParams } from '../lib/algorithms/autonomousParams';
import { MultiTimeframeResult } from '../lib/algorithms/multiTimeframe';

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

  const [scanning, setScanning] = useState(false);
  const [backtesting, setBacktesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const runAutonomousScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    setAutoRankings([]);
    setRegime(null);
    setAutoParams(null);
    setBacktestResult(null);

    try {
      const url = `/api/autonomous?indexSymbol=${config.indexSymbol}&limit=200`;

      const response = await fetch(url);
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      setRegime(data.regime);
      setAutoParams(data.autonomousParams);
      setAutoRankings(data.rankings);
      setTotalScanned(data.totalScanned);

      if (data.rankings.length > 0) {
        const withSignals = data.rankings.filter((r: MultiTimeframeResult) => r.finalSignal !== 'neutral');
        setSelectedAsset(withSignals.length > 0 ? withSignals[0].asset : data.rankings[0].asset);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Autonomous scan failed');
    } finally {
      setScanning(false);
    }
  }, [config.indexSymbol]);

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
          <button
            onClick={runScan}
            disabled={scanning}
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
            {scanning ? 'Scanning...' : '🔍 Run Autonomous Scan'}
          </button>
        )}
      </div>

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

      {mode === 'autonomous' && autoRankings.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '20px' }}>
          <StatsCard label="Assets Scanned" value={totalScanned} icon="📊" />
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
              <h4 style={{ color: '#f59e0b', fontSize: '12px', marginBottom: '6px' }}>4. Expanded Asset Universe</h4>
              <p>Scans 70+ assets across Layer 1, DeFi, AI, Meme, Gaming, and Infrastructure categories. No manual selection needed.</p>
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