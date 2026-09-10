import { Candle } from '../types';
import { fetchAssetCandles, AssetRef } from '../marketData';
import { generateQuantSignals } from './signals';
import { detectSpikes } from './spikeSignal';
import { PaperSignal, StepMarketSnapshot } from './paperEngine';

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

  // Benchmark on primary + daily for RS
  const benchCache = new Map<string, Candle[] | null>();
  if (benchmark) {
    for (const tf of tfs) {
      try {
        benchCache.set(tf, await fetchAssetCandles(benchmark, tf, TF_LIMIT[tf] || 200));
      } catch {
        benchCache.set(tf, null);
      }
    }
  }

  // Fetch assets: primary history for engine + multi-TF signals
  for (let i = 0; i < universe.length; i += 2) {
    const batch = universe.slice(i, i + 2);
    const results = await Promise.allSettled(
      batch.map(async (asset) => {
        const primaryLimit = TF_LIMIT[primaryInterval] || 300;
        const primaryCandles = await fetchAssetCandles(asset, primaryInterval, primaryLimit);
        const tfCandles: Record<string, Candle[]> = { [primaryInterval]: primaryCandles };

        for (const tf of tfs) {
          if (tf === primaryInterval) continue;
          try {
            tfCandles[tf] = await fetchAssetCandles(asset, tf, TF_LIMIT[tf] || 200);
          } catch {
            /* skip tf */
          }
        }
        return { asset, primaryCandles, tfCandles };
      })
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { asset, primaryCandles, tfCandles } = r.value;
      if (!primaryCandles || primaryCandles.length < 5) continue;

      history[asset.id] = primaryCandles;
      latest[asset.id] = primaryCandles[primaryCandles.length - 1];

      for (const [tf, candles] of Object.entries(tfCandles)) {
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
    }
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
  };
}
