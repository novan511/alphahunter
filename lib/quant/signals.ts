import { Candle, DecouplingSignal, ScanConfig } from '../types';
import { detectDecoupling } from '../algorithms/decouplingDetector';
import { sma } from '../algorithms/indicators';
import { AssetRef } from '../marketData';

/**
 * Generate signals for portfolio / paper quant engine.
 * Always combines:
 *  1) Decoupling RS (same venue crypto vs benchmark)
 *  2) Momentum+volume (all markets, including commodities)
 * so the agent is never stuck with empty candidates for long stretches.
 */
export function generateQuantSignals(
  asset: AssetRef,
  candles: Candle[],
  benchmark: AssetRef | null,
  benchmarkCandles: Candle[] | null,
  interval: string
): DecouplingSignal[] {
  if (candles.length < 30) return [];

  const out: DecouplingSignal[] = [];

  const canDecouple =
    benchmark &&
    benchmarkCandles &&
    benchmarkCandles.length >= 40 &&
    benchmark.source === asset.source &&
    benchmark.id !== asset.id;

  if (canDecouple && benchmarkCandles) {
    const minLen = Math.min(candles.length, benchmarkCandles.length);
    const a = candles.slice(-minLen);
    const b = benchmarkCandles.slice(-minLen);
    const config: ScanConfig = {
      indexSymbol: benchmark.symbol,
      assetSymbols: [asset.symbol],
      interval,
      lookback: interval === '1d' || interval === '1w' ? 4 : 6,
      rsPeriod: interval === '1d' || interval === '1w' ? 14 : 20,
      // looser thresholds so paper agent sees more candidates
      indexThreshold: interval === '4h' || interval === '1h' ? 0.015 : 0.012,
      volumeMultiplier: 1.15,
      volumePeriod: 20,
    };
    try {
      out.push(...detectDecoupling(a, b, config));
    } catch {
      /* ignore */
    }
  }

  // Always add momentum signals (critical for commodities & when decoupling is quiet)
  out.push(...momentumVolumeSignals(asset, candles, interval));

  // Dedupe by time+type+price
  const seen = new Set<string>();
  return out.filter((s) => {
    const k2 = `${s.time}|${s.type}|${s.price}`;
    if (seen.has(k2)) return false;
    seen.add(k2);
    return true;
  });
}

function momentumVolumeSignals(
  asset: AssetRef,
  candles: Candle[],
  interval: string
): DecouplingSignal[] {
  const isSlow = interval === '1d' || interval === '1w' || interval === '1mo';
  const momLookback = isSlow ? 3 : 5;
  // lower gates for slow markets / paper visibility
  const buyMom = isSlow ? 0.008 : 0.01;
  const sellMom = isSlow ? -0.015 : -0.02;
  const buyVol = isSlow ? 1.05 : 1.1;
  const sellVol = isSlow ? 1.15 : 1.25;
  const maPeriod = isSlow ? 10 : 15;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ma = sma(closes, maPeriod);
  const volMa = sma(volumes, maPeriod);
  const signals: DecouplingSignal[] = [];

  const start = Math.max(maPeriod + 2, momLookback + 1);

  for (let i = start; i < candles.length; i++) {
    const maV = ma[i];
    const vm = volMa[i];
    if (isNaN(maV) || isNaN(vm) || vm <= 0) continue;

    const close = closes[i];
    const prev = closes[i - momLookback];
    if (prev <= 0) continue;
    const mom = (close - prev) / prev;
    const volRatio = volumes[i] / vm;
    const aboveMa = close > maV;
    const belowMa = close < maV;

    // long: pullback-hold or breakout with volume
    if (aboveMa && mom >= buyMom && volRatio >= buyVol) {
      const strength = Math.min(2.5 + Math.abs(mom) * 100 + volRatio, 10);
      signals.push({
        time: candles[i].time,
        price: close,
        type: 'buy',
        strength: Math.round(strength * 100) / 100,
        rsZScore: Math.round(mom * 100) / 100,
        indexReturn: 0,
        assetReturn: Math.round(mom * 10000) / 100,
        volumeRatio: Math.round(volRatio * 100) / 100,
        reason: `${asset.symbol} mom+vol: ${(mom * 100).toFixed(2)}% / Vol ${volRatio.toFixed(1)}x`,
      });
    }

    // secondary long: strong volume even if barely above MA
    if (aboveMa && mom >= buyMom * 0.6 && volRatio >= 1.4) {
      const strength = Math.min(2.8 + Math.abs(mom) * 80 + volRatio, 10);
      signals.push({
        time: candles[i].time,
        price: close,
        type: 'buy',
        strength: Math.round(strength * 100) / 100,
        rsZScore: Math.round(mom * 100) / 100,
        indexReturn: 0,
        assetReturn: Math.round(mom * 10000) / 100,
        volumeRatio: Math.round(volRatio * 100) / 100,
        reason: `${asset.symbol} vol surge: ${(mom * 100).toFixed(2)}% / Vol ${volRatio.toFixed(1)}x`,
      });
    }

    if (belowMa && mom <= sellMom && volRatio >= sellVol) {
      const strength = Math.min(2.5 + Math.abs(mom) * 100 + volRatio, 10);
      signals.push({
        time: candles[i].time,
        price: close,
        type: 'sell',
        strength: Math.round(strength * 100) / 100,
        rsZScore: Math.round(mom * 100) / 100,
        indexReturn: 0,
        assetReturn: Math.round(mom * 10000) / 100,
        volumeRatio: Math.round(volRatio * 100) / 100,
        reason: `${asset.symbol} breakdown: ${(mom * 100).toFixed(2)}% / Vol ${volRatio.toFixed(1)}x`,
      });
    }
  }

  return signals;
}
