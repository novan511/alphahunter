import {
  Candle,
  DecouplingSignal,
  ScanConfig,
} from '../types';
import { detectDecoupling } from './decouplingDetector';
import { calculateRSData } from './relativeStrength';
import { sma } from './indicators';
import {
  DEFAULT_MAX_SIGNAL_AGE_BARS,
  getFreshLatestSignal,
} from './signalFreshness';

export interface TimeframeSignal {
  timeframe: string;
  signal: DecouplingSignal | null;
  rsZScore: number;
  trendDirection: 'bullish' | 'bearish' | 'neutral';
  signalAgeBars: number | null;
}

export interface MultiTimeframeResult {
  asset: string;
  timeframes: TimeframeSignal[];
  confluenceScore: number;
  confluenceDirection: 'bullish' | 'bearish' | 'none';
  finalSignal: 'strong_buy' | 'buy' | 'strong_sell' | 'sell' | 'neutral';
  /** Min age (in bars) among contributing signals; null if none. */
  newestSignalAgeBars: number | null;
}

export interface MultiTimeframeOptions {
  maxSignalAgeBars?: number;
}

function determineTrend(candles: Candle[], period: number = 20): 'bullish' | 'bearish' | 'neutral' {
  if (candles.length < period) return 'neutral';

  const closes = candles.map((c) => c.close);
  const ma = sma(closes, period);
  const lastClose = closes[closes.length - 1];
  const lastMA = ma[ma.length - 1];

  const momentum = (lastClose - closes[closes.length - 3]) / closes[closes.length - 3];

  if (lastClose > lastMA && momentum > 0.005) return 'bullish';
  if (lastClose < lastMA && momentum < -0.005) return 'bearish';
  return 'neutral';
}

export function analyzeMultiTimeframe(
  assetSymbol: string,
  timeframeData: { [timeframe: string]: { asset: Candle[]; index: Candle[] } },
  baseConfig: ScanConfig,
  options: MultiTimeframeOptions = {}
): MultiTimeframeResult {
  const maxSignalAgeBars = options.maxSignalAgeBars ?? DEFAULT_MAX_SIGNAL_AGE_BARS;
  const timeframes = ['1h', '4h', '1d'];
  const tfSignals: TimeframeSignal[] = [];

  for (const tf of timeframes) {
    const data = timeframeData[tf];
    if (!data || data.asset.length < 50 || data.index.length < 50) {
      tfSignals.push({
        timeframe: tf,
        signal: null,
        rsZScore: 0,
        trendDirection: 'neutral',
        signalAgeBars: null,
      });
      continue;
    }

    const minLen = Math.min(data.asset.length, data.index.length);
    const trimmedAsset = data.asset.slice(-minLen);
    const trimmedIndex = data.index.slice(-minLen);

    const tfConfig: ScanConfig = {
      ...baseConfig,
      interval: tf,
    };

    const signals = detectDecoupling(trimmedAsset, trimmedIndex, tfConfig);
    const rsData = calculateRSData(trimmedAsset, trimmedIndex, tfConfig.rsPeriod);
    const lastRS = rsData[rsData.length - 1];
    const trend = determineTrend(trimmedAsset);

    const { signal: latestSignal, ageBars } = getFreshLatestSignal(
      signals,
      trimmedAsset,
      tf,
      maxSignalAgeBars
    );

    tfSignals.push({
      timeframe: tf,
      signal: latestSignal,
      rsZScore: lastRS.rsZScore,
      trendDirection: trend,
      signalAgeBars: ageBars,
    });
  }

  let buyScore = 0;
  let sellScore = 0;

  const tfWeights: { [tf: string]: number } = {
    '1h': 0.2,
    '4h': 0.35,
    '1d': 0.45,
  };

  const signalAges: number[] = [];

  for (const tfSig of tfSignals) {
    const weight = tfWeights[tfSig.timeframe] || 0.3;

    if (tfSig.signal?.type === 'buy') {
      buyScore += weight * (1 + tfSig.signal.strength / 10);
      if (tfSig.signalAgeBars != null) signalAges.push(tfSig.signalAgeBars);
    } else if (tfSig.signal?.type === 'sell') {
      sellScore += weight * (1 + tfSig.signal.strength / 10);
      if (tfSig.signalAgeBars != null) signalAges.push(tfSig.signalAgeBars);
    }

    if (tfSig.rsZScore > 1) buyScore += weight * 0.5;
    if (tfSig.rsZScore < -1) sellScore += weight * 0.5;

    if (tfSig.trendDirection === 'bullish') buyScore += weight * 0.3;
    if (tfSig.trendDirection === 'bearish') sellScore += weight * 0.3;
  }

  const totalScore = buyScore + sellScore;
  const confluenceScore = totalScore > 0 ? Math.round((Math.max(buyScore, sellScore) / totalScore) * 100) : 0;

  let confluenceDirection: 'bullish' | 'bearish' | 'none';
  let finalSignal: MultiTimeframeResult['finalSignal'];

  if (buyScore > sellScore && buyScore > 0.5) {
    confluenceDirection = 'bullish';
    if (confluenceScore >= 80) {
      finalSignal = 'strong_buy';
    } else if (confluenceScore >= 50) {
      finalSignal = 'buy';
    } else {
      finalSignal = 'neutral';
    }
  } else if (sellScore > buyScore && sellScore > 0.5) {
    confluenceDirection = 'bearish';
    if (confluenceScore >= 80) {
      finalSignal = 'strong_sell';
    } else if (confluenceScore >= 50) {
      finalSignal = 'sell';
    } else {
      finalSignal = 'neutral';
    }
  } else {
    confluenceDirection = 'none';
    finalSignal = 'neutral';
  }

  return {
    asset: assetSymbol,
    timeframes: tfSignals,
    confluenceScore,
    confluenceDirection,
    finalSignal,
    newestSignalAgeBars: signalAges.length > 0 ? Math.min(...signalAges) : null,
  };
}
