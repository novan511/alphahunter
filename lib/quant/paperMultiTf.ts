import { Candle } from '../types';
import { fetchAssetCandles, AssetRef } from '../marketData';
import { generateQuantSignals } from './signals';
import { detectSpikes } from './spikeSignal';
import { PaperSignal, StepMarketSnapshot } from './paperEngine';
import { intervalToSeconds } from '../algorithms/signalFreshness';

/** Timeframes the agent always looks at (paper execution still on primary TF). */
export const PAPER_TIMEFRAMES = ['15m', '1h', '4h', '1d', '1w'] as const;
export type PaperTF = (typeof PAPER_TIMEFRAMES)[number];

const TF_WEIGHT: Record<string, number> = {
  '15m': 0.08,
  '1h': 0.15,
  '4h': 0.25,
  '1d': 0.32,
  '1w': 0.20,
};

/** Bars per TF — deeper history for broader context. */
const TF_LIMIT: Record<string, number> = {
  '15m': 200,
  '1h': 250,
  '4h': 300,
  '1d': 200,
  '1w': 120,
  '1mo': 60,
};

/** Keep the arena on completed OHLC bars; the newest candle from most feeds is still forming. */
function completedBars(candles: Candle[], interval: string, nowSeconds = Math.floor(Date.now() / 1000)): Candle[] {
  const duration = intervalToSeconds(interval);
  const completed = candles.filter((candle) => candle.time + duration <= nowSeconds);
  if (completed.length) return completed;
  // Defensive fallback for providers that timestamp bars at their close or return
  // only a single candle; prefer one-bar latency over acting on a partial OHLC bar.
  return candles.length > 1 ? candles.slice(0, -1) : candles;
}

function resampleFourHour(candles: Candle[]): Candle[] {
  const bucketSeconds = 4 * 60 * 60;
  const result: Candle[] = [];
  for (const candle of candles) {
    const bucket = Math.floor(candle.time / bucketSeconds) * bucketSeconds;
    const current = result[result.length - 1];
    if (current?.time === bucket) {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.volume += candle.volume;
    } else {
      result.push({ ...candle, time: bucket });
    }
  }
  return result;
}

function normalizeTimeframeBars(asset: AssetRef, interval: string, candles: Candle[], nowSeconds: number): Candle[] {
  const timeframeBars = asset.source === 'yahoo' && interval === '4h' ? resampleFourHour(candles) : candles;
  return completedBars(timeframeBars, interval, nowSeconds);
}

function timeframesForPrimary(primary: string): string[] {
  if (primary === '1d') return ['1h', '4h', '1d', '1w'];
  if (primary === '4h') return ['15m', '1h', '4h', '1d'];
  if (primary === '1h') return ['15m', '1h', '4h'];
  if (primary === '1w') return ['4h', '1d', '1w'];
  if (primary === '15m') return ['15m', '1h'];
  if (primary === '1mo') return ['1d', '1w', '1mo'];
  return ['1h', '4h', '1d'];
}

export async function buildMultiTfSnapshot(
  universe: AssetRef[],
  benchmark: AssetRef | null,
  primaryInterval: string
): Promise<StepMarketSnapshot> {
  const tfs = timeframesForPrimary(primaryInterval);
  const latest: Record<string, Candle> = {};
  const history: Record<string, Candle[]> = {};
  const signals: PaperSignal[] = [];
  const missingSymbols: string[] = [];
  const benchmarkMissingTimeframes: string[] = [];
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Per-symbol aggregated strength by side
  const score = new Map<string, { buy: number; sell: number; reasons: string[]; best: PaperSignal | null }>();

  const bump = (symbol: string, sig: PaperSignal, tf: string) => {
    const w = TF_WEIGHT[tf] ?? 0.15;
    const entry = score.get(symbol) || { buy: 0, sell: 0, reasons: [], best: null };
    const weighted = sig.strength * w;
    if (sig.type === 'buy') entry.buy += weighted;
    else entry.sell += weighted;
    if (entry.reasons.length < 6) {
      entry.reasons.push(`${tf}:${sig.type} ${sig.strength.toFixed(1)}`);
    }
    if (!entry.best || sig.strength > entry.best.strength) {
      entry.best = { ...sig, symbol, reason: `[${tf}] ${sig.reason}` };
    }
    score.set(symbol, entry);
  };

  // Benchmark + asset/timeframe requests dijalankan paralel. Sebelumnya benchmark
  // dan TF per asset serial sehingga snapshot bisa mengambil puluhan detik.
  const benchCache = new Map<string, Candle[] | null>();
  if (benchmark) {
    const benchResults = await Promise.allSettled(tfs.map((tf) => fetchAssetCandles(benchmark, tf, TF_LIMIT[tf] || 200)));
    benchResults.forEach((result, index) => {
      const candles = result.status === 'fulfilled' ? normalizeTimeframeBars(benchmark, tfs[index], result.value, nowSeconds) : null;
      benchCache.set(tfs[index], candles);
      if (!candles || candles.length < 5) benchmarkMissingTimeframes.push(tfs[index]);
    });
  }

  // Fetch assets: primary history for engine + multi-TF signals
  for (let i = 0; i < universe.length; i += 4) {
    const batch = universe.slice(i, i + 4);
    const assetResults = await Promise.allSettled(batch.map(async (asset) => {
        const primaryLimit = TF_LIMIT[primaryInterval] || 300;
        const tfResults = await Promise.allSettled(tfs.map((tf) => fetchAssetCandles(asset, tf, tf === primaryInterval ? primaryLimit : TF_LIMIT[tf] || 200)));
        const tfCandles: Record<string, Candle[]> = {};
        tfResults.forEach((result, index) => {
          if (result.status === 'fulfilled') tfCandles[tfs[index]] = normalizeTimeframeBars(asset, tfs[index], result.value, nowSeconds);
        });
        const primaryCandles = tfCandles[primaryInterval] || [];
        return { asset, primaryCandles, tfCandles };
    }));

    assetResults.forEach((r, resultIndex) => {
      if (r.status !== 'fulfilled') {
        missingSymbols.push(batch[resultIndex]?.id || 'unknown');
        return;
      }
      const { asset, primaryCandles, tfCandles } = r.value;
      if (!primaryCandles || primaryCandles.length < 5) {
        missingSymbols.push(asset.id);
        return;
      }

      history[asset.id] = primaryCandles;
      latest[asset.id] = primaryCandles[primaryCandles.length - 1];

      for (const [tf, candles] of Object.entries(tfCandles) as Array<[string, Candle[]]>) {
        if (!candles || candles.length < 30) continue;
        const bench = benchCache.get(tf) || null;
        const sigs = generateQuantSignals(asset, candles, benchmark, bench, tf);
        // Spike agent overlay on primary-ish TFs
        if (tf === primaryInterval || tf === '4h' || tf === '1d') {
          const spikes = detectSpikes(candles, { volZThreshold: 1.8, momThreshold: 0.006 });
          for (const sp of spikes.slice(-3)) {
            sigs.push({
              time: sp.time,
              price: candles[candles.length - 1].close,
              type: sp.type,
              strength: sp.strength,
              rsZScore: sp.volumeZ,
              indexReturn: 0,
              assetReturn: sp.momentum,
              volumeRatio: sp.volumeZ,
              reason: `[${tf}] ${sp.reason}`,
            });
          }
        }
        // last 12 bars of each TF for candidate window
        const recentFrom = candles[Math.max(0, candles.length - 12)]?.time ?? 0;
        for (const s of sigs) {
          if (s.time < recentFrom) continue;
          const ps: PaperSignal = {
            time: s.time,
            symbol: asset.id,
            type: s.type,
            price: s.price,
            strength: s.strength,
            reason: s.reason,
          };
          bump(asset.id, ps, tf);
        }
      }
    });
  }

  // Emit confluence signals: combined buy/sell score as strength
  score.forEach((entry, symbol) => {
    const last = latest[symbol];
    if (!last) return;

    if (entry.buy > 0 && entry.buy >= entry.sell) {
      const strength = Math.min(entry.buy, 10);
      signals.push({
        time: last.time,
        symbol,
        type: 'buy',
        price: last.close,
        strength: Math.round(strength * 100) / 100,
        reason: `MTF confluence buy · ${entry.reasons.join(' | ')}`,
      });
    }
    if (entry.sell > 0 && entry.sell > entry.buy) {
      const strength = Math.min(entry.sell, 10);
      signals.push({
        time: last.time,
        symbol,
        type: 'sell',
        price: last.close,
        strength: Math.round(strength * 100) / 100,
        reason: `MTF confluence sell · ${entry.reasons.join(' | ')}`,
      });
    }
  });

  return {
    latest,
    history,
    benchmarkSymbol: benchmark?.id ?? null,
    benchmarkHistory: benchCache.get(primaryInterval) || benchCache.get('1d') || null,
    signals,
    diagnostics: {
      capturedAt: Date.now(),
      primaryInterval,
      requestedAssets: universe.length,
      availableAssets: Object.keys(latest).length,
      missingSymbols,
      newestBarAt: Object.values(latest).length ? Math.max(...Object.values(latest).map((c) => c.time)) : null,
      oldestBarAt: Object.values(latest).length ? Math.min(...Object.values(latest).map((c) => c.time)) : null,
      benchmarkMissingTimeframes,
    },
  };
}
