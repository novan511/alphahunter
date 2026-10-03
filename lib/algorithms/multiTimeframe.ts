import {
  Candle,
  DecouplingSignal,
  ScanConfig,
} from '../types';
import { detectDecoupling } from './decouplingDetector';
import { calculateRSData } from './relativeStrength';
import {
  sma,
  ema,
  atr,
  clamp01,
  clampRange,
  zScorePValue,
} from './indicators';
import {
  DEFAULT_MAX_SIGNAL_AGE_BARS,
  getFreshLatestSignal,
} from './signalFreshness';
import {
  categoryFor,
  categoryMeta,
  categoryNarrative,
  isNonDirectional,
  CategoryId,
} from '../assetCategory';

/** Weights by timeframe. Higher timeframes carry more information. */
const TF_WEIGHTS: Record<string, number> = { '1h': 0.2, '4h': 0.35, '1d': 0.45 };

/**
 * Z-score band that maps onto [0,1] evidence.
 *
 * Measured against the live universe (32 majors x 3 timeframes, rsPeriod=20,
 * 200 bars), the RS z-score distribution is far narrower than a textbook
 * assumption suggests: |z|>1.0 occurs ~16-47% of the time depending on
 * timeframe, but |z|>2.0 is essentially never observed (0-3%).
 *
 * So the previous floor of 1.5 / ceiling of 3.5 made `strong_buy` unreachable
 * — real outliers peaked around 1.5-2.0. The band below is calibrated so that
 * |z|=0.8 (the ~66-78th percentile) is the entry floor, |z|=1.0 sits at the
 * low end of meaningful evidence, and |z|>=1.6 saturates. The *gates* in
 * decideStrongSignal() still require multi-timeframe agreement, so a single
 * inflated z-score cannot produce a strong signal on its own.
 */
const Z_FLOOR = 0.8;
const Z_CEILING = 1.6;

export interface TimeframeEvidence {
  timeframe: string;
  /** Signed relative-strength z-score on the primary benchmark. */
  rsZScore: number;
  /** Two-sided p-value of that z-score. */
  rsPValue: number;
  /** Volatility-normalised trend strength in [0,1]. */
  trendScore: number;
  /** Decoupling evidence in [0,1]; 0 when no fresh signal. */
  signalScore: number;
  trendDirection: 'bullish' | 'bearish' | 'neutral';
  signal: DecouplingSignal | null;
  signalAgeBars: number | null;
  /** Net directional evidence in [0,1]. */
  evidence: number;
  /** True when this timeframe has usable data at all. */
  active: boolean;
}

export interface MultiTimeframeResult {
  asset: string;
  timeframes: TimeframeEvidence[];
  /** Kept 0-100 for backward compatibility with the existing UI column. */
  confluenceScore: number;
  confluenceDirection: 'bullish' | 'bearish' | 'none';
  finalSignal: 'strong_buy' | 'buy' | 'strong_sell' | 'sell' | 'neutral';
  /** Min age (in bars) among contributing signals; null if none. */
  newestSignalAgeBars: number | null;

  // --- added diagnostics (the UI reads these optionally) ---
  /** Strength of evidence on the dominant side, 0-1. */
  conviction: number;
  /** Share of the timeframe stack that agrees, 0-1. */
  agreement: number;
  /** Signed conviction difference (bullish positive), -1..1. */
  netBias: number;
  /** Score before liquidity damping, 0-100. */
  rawScore: number;
  /** Applied liquidity multiplier in [0,1]. */
  liquidityFactor: number;
  /** Plain-language summary of why this signal fired (or did not). */
  narrative: string;
  /** 24h market cap in USD, null when unknown. */
  marketCap?: number | null;
  /**
   * 24h quote volume in USD. Optional and additive: cached scans from before
   * this field existed simply lack it, and consumers must fall back to
   * `liquidityFactor`. Prefer this when present — liquidityFactor is a
   * bucketed score, so it cannot answer "is this book deep enough to enter?".
   */
  quoteVolume?: number | null;
  /** Cap tier: mega | large | mid | small | micro | unknown. */
  capTier?: string;
  /** Sector/narrative bucket: l1, l2, defi, meme, ai, ... */
  category?: string;
  /** Category label, e.g. "Layer 1". */
  categoryLabel?: string;
  rationale: string;
}

export interface MultiTimeframeOptions {
  maxSignalAgeBars?: number;
  /** 24h quote volume in USD, used to damp thin books. */
  quoteVolume?: number;
  /** Real 24h market cap in USD, used for cap-tier context. */
  marketCap?: number;
  /** Sector bucket for narrative context. Resolved from the symbol if omitted. */
  category?: string;
  /** Cap tier label for narrative context. */
  capTier?: string;
}

/**
 * Liquidity multiplier in [0,1]. A coin that can print a +40% "decoupling" on
 * a $30k daily book is not a signal, it is a wick. The scanner sweeps 2,000+
 * pairs including micro-caps, so without this the top of the ranking is
 * dominated by the least tradeable names in the universe.
 */
export function liquidityFactor(quoteVolume: number | undefined): number {
  if (quoteVolume === undefined || !Number.isFinite(quoteVolume)) return 0.7;
  if (quoteVolume >= 50_000_000) return 1.0;
  if (quoteVolume >= 10_000_000) return 0.95;
  if (quoteVolume >= 1_000_000) return 0.85;
  if (quoteVolume >= 250_000) return 0.65;
  if (quoteVolume >= 50_000) return 0.45;
  return 0.3;
}

/**
 * Volatility-normalised trend. Compares the EMA slope to ATR over the same
 * span, so the same threshold means the same thing on a calm major and on a
 * 15%-ATR memecoin. The previous implementation used a hardcoded 0.5% move,
 * which is noise on 1h and meaningful on 1d.
 */
function trendEvidence(
  candles: Candle[],
  period: number = 20
): { direction: 'bullish' | 'bearish' | 'neutral'; score: number } {
  if (candles.length < period + 10) return { direction: 'neutral', score: 0 };

  const closes = candles.map((c) => c.close);
  const emaSeries = ema(closes, period);
  const maSeries = sma(closes, period);
  const atrSeries = atr(candles, 14);

  const lastEma = emaSeries[emaSeries.length - 1];
  const lastMa = maSeries[maSeries.length - 1];
  const lastClose = closes[closes.length - 1];
  const lastAtr = atrSeries[atrSeries.length - 1];
  const emaBack = emaSeries[emaSeries.length - 6];

  if (
    !Number.isFinite(lastEma) || !Number.isFinite(lastMa) ||
    !Number.isFinite(emaBack) || !Number.isFinite(lastAtr) ||
    lastAtr <= 0 || lastClose <= 0
  ) {
    return { direction: 'neutral', score: 0 };
  }

  // Slope measured in ATR units over a 5-bar span.
  const slopeAtr = (lastEma - emaBack) / (lastAtr * Math.sqrt(5));
  // Price must also sit on the correct side of its moving average.
  const aboveMa = lastClose > lastMa;
  const belowMa = lastClose < lastMa;

  // Calibrated against the live universe: a 5-bar EMA slope normalised by ATR
  // typically spans 0.03-0.25, so the saturation point is 0.25 (a full ATR of
  // drift across the window). Dividing by 0.8 instead left every real coin
  // pinned below 0.3 and suppressed conviction across the board.
  const magnitude = clamp01(Math.abs(slopeAtr) / 0.25);

  if (slopeAtr > 0 && aboveMa) {
    return { direction: 'bullish', score: magnitude };
  }
  if (slopeAtr < 0 && belowMa) {
    return { direction: 'bearish', score: magnitude };
  }
  return { direction: 'neutral', score: magnitude * 0.3 };
}

/**
 * Converts a raw z-score into evidence in [0,1] with a real significance floor.
 * Below Z_FLOOR there is no evidence at all; above Z_CEILING it saturates.
 */
function zEvidence(z: number): number {
  const mag = Math.abs(z);
  if (!Number.isFinite(mag) || mag <= Z_FLOOR) return 0;
  return clamp01((mag - Z_FLOOR) / (Z_CEILING - Z_FLOOR));
}

/**
 * Freshness decay. A signal 8 bars old is not worth the same as one that just
 * printed — the old code weighted them identically, so stale setups ranked
 * alongside live ones.
 */
function freshness(ageBars: number | null, maxAge: number): number {
  if (ageBars === null) return 0;
  if (maxAge <= 0) return 1;
  return clamp01(1 - ageBars / (maxAge + 1));
}

/**
 * Plain-language explanation of a signal. A trader should be able to read why
 * a coin ranked where it did without reverse-engineering four sub-scores, so
 * this names the dominant driver, the timeframe agreement, and the main caveat.
 */
function buildNarrative(ctx: {
  finalSignal: string;
  confluenceScore: number;
  conviction: number;
  agreement: number;
  tfSignals: TimeframeEvidence[];
  liq: number;
  capTier?: string;
  marketCap?: number;
  catId: CategoryId;
  catLabel: string;
  stable_: boolean;
}): string {
  const { finalSignal, conviction, agreement, tfSignals, liq, catId, catLabel, stable_ } = ctx;
  const parts: string[] = [];

  // What kind of asset this is — the first thing a trader needs to know.
  parts.push(`[${catLabel}] ${categoryNarrative(catId)}`);

  if (finalSignal === 'neutral') {
    if (conviction < 0.2) {
      parts.push('No meaningful relative strength against the benchmark on any timeframe.');
    } else if (agreement < 0.5) {
      parts.push(
        `Evidence is split across timeframes (only ${Math.round(agreement * 100)}% agree), so no directional bias is confirmed.`
      );
    } else {
      parts.push(
        `Directional lean of ${Math.round(conviction * 100)}% conviction is below the threshold for a tradable signal.`
      );
    }
    return parts.join(' ');
  }

  const dir = confluenceDirectionHint(finalSignal);
  const activeCount = tfSignals.filter((t) => t.active).length;
  const agreeing = tfSignals.filter(
    (t) => t.active && tfSigned(t) * (dir === 'bullish' ? 1 : -1) > 0
  );

  parts.push(
    `${agreeing.length}/${activeCount} timeframes align ${dir} ` +
    `(${Math.round(agreement * 100)}% agreement, ${Math.round(conviction * 100)}% conviction).`
  );

  const strongest = tfSignals
    .filter((t) => t.active)
    .sort((a, b) => b.evidence - a.evidence)[0];

  if (strongest) {
    const mag = Math.abs(strongest.rsZScore);
    const sig =
      mag >= 2 ? 'extreme' : mag >= 1.3 ? 'strong' : mag >= 0.8 ? 'moderate' : 'mild';
    parts.push(
      `Strongest read is ${strongest.timeframe}: relative strength ${sig} at ${strongest.rsZScore > 0 ? '+' : ''}${strongest.rsZScore}σ.`
    );
  }

  const withSignal = tfSignals.filter((t) => t.signal);
  if (withSignal.length > 0) {
    const freshest = withSignal.reduce((a, b) =>
      (a.signalAgeBars ?? 99) <= (b.signalAgeBars ?? 99) ? a : b
    );
    const ageTxt =
      freshest.signalAgeBars === 0 ? 'this bar' : `${freshest.signalAgeBars} bar(s) ago`;
    parts.push(`Decoupling trigger on ${freshest.timeframe} ${ageTxt}.`);
  } else {
    parts.push('No fresh decoupling trigger — this is momentum/RS continuation, not a flush.');
  }

  // Category-specific risk framing: the same score means different things here.
  if (stable_) {
    parts.push('Peg asset: treat any directional signal as a depeg read, not a trend bet.');
  } else if (catId === 'meme') {
    parts.push('Meme asset: reflexivity dominates, so this setup can reverse on a single post.');
  } else if (catId === 'l2') {
    parts.push('L2 economics depend on the host chain and sequencer revenue sharing.');
  } else if (catId === 'ai') {
    parts.push('AI narrative: valuation is forward-looking, so flows can front-run any revenue.');
  } else if (catId === 'defi' || catId === 'perps') {
    parts.push('DeFi beta: TVL and fee revenue are the anchors — check unlock schedules before sizing.');
  } else if (catId === 'exchange') {
    parts.push('Exchange token: largely tracks its venue, so read fees and volumes, not the chart alone.');
  }

  const caveats: string[] = [];
  if (liq < 0.65) caveats.push('thin volume, expect slippage');
  if (ctx.capTier === 'micro') caveats.push('micro cap, wide swings and gap risk');
  if (ctx.capTier === 'small') caveats.push('small cap, higher volatility');
  if (ctx.capTier === 'unknown') caveats.push('cap unverified');
  if (agreement < 0.6) caveats.push('timeframes not fully aligned');
  if (caveats.length > 0) parts.push(`Caveats: ${caveats.join('; ')}.`);

  return parts.join(' ');
}

function confluenceDirectionHint(signal: string): 'bullish' | 'bearish' {
  return signal.includes('buy') ? 'bullish' : 'bearish';
}

/**
 * Same signed blend used in the aggregation loop.
 *
 * Exported so sector-level aggregation (narrative heat) reads a timeframe the
 * exact same way the per-coin score does. A second, locally-defined copy of
 * this blend would silently drift from the score and rank a sector off
 * evidence the score never used.
 */
export function tfSigned(t: TimeframeEvidence): number {
  return (
    0.40 * Math.sign(t.rsZScore) * zEvidence(t.rsZScore) +
    0.35 * (t.trendDirection === 'bullish' ? 1 : t.trendDirection === 'bearish' ? -1 : 0) * t.trendScore +
    0.25 * (t.signal ? (t.signal.type === 'buy' ? 1 : -1) : 0) * t.signalScore
  );
}

export function analyzeMultiTimeframe(
  assetSymbol: string,
  timeframeData: { [timeframe: string]: { asset: Candle[]; index: Candle[] } },
  baseConfig: ScanConfig,
  options: MultiTimeframeOptions = {}
): MultiTimeframeResult {
  const maxSignalAgeBars = options.maxSignalAgeBars ?? DEFAULT_MAX_SIGNAL_AGE_BARS;
  const timeframes = ['1h', '4h', '1d'];
  const tfSignals: TimeframeEvidence[] = [];

  for (const tf of timeframes) {
    const data = timeframeData[tf];
    if (!data || data.asset.length < 50 || data.index.length < 50) {
      tfSignals.push({
        timeframe: tf,
        rsZScore: 0,
        rsPValue: 1,
        trendScore: 0,
        signalScore: 0,
        trendDirection: 'neutral',
        signal: null,
        signalAgeBars: null,
        evidence: 0,
        active: false,
      });
      continue;
    }

    const minLen = Math.min(data.asset.length, data.index.length);
    const trimmedAsset = data.asset.slice(-minLen);
    const trimmedIndex = data.index.slice(-minLen);

    const tfConfig: ScanConfig = { ...baseConfig, interval: tf };

    const signals = detectDecoupling(trimmedAsset, trimmedIndex, tfConfig);
    const rsData = calculateRSData(trimmedAsset, trimmedIndex, tfConfig.rsPeriod);
    const lastRS = rsData[rsData.length - 1];
    const trend = trendEvidence(trimmedAsset);

    const { signal: latestSignal, ageBars } = getFreshLatestSignal(
      signals,
      trimmedAsset,
      tf,
      maxSignalAgeBars
    );

    const z = Number.isFinite(lastRS.rsZScore) ? lastRS.rsZScore : 0;
    const pValue = zScorePValue(z);

    const zEv = zEvidence(z);
    const fresh = freshness(ageBars, maxSignalAgeBars);

    // A decoupling signal is only evidence if its own z-score was significant,
    // otherwise we are double-counting the same RS reading.
    const sigBase = latestSignal ? clamp01(latestSignal.strength / 10) : 0;
    const sigScore = latestSignal ? sigBase * fresh * (0.4 + 0.6 * zEv) : 0;

    // Direction of this timeframe's net contribution.
    const dirSign = trend.direction === 'bullish' ? 1 : trend.direction === 'bearish' ? -1 : 0;
    const zSign = z > 0 ? 1 : z < 0 ? -1 : 0;
    const sigSign = latestSignal
      ? latestSignal.type === 'buy' ? 1 : -1
      : 0;

    // Weighted blend; RS leads, then trend, then the explicit signal.
    const signed =
      0.40 * zSign * zEv +
      0.35 * dirSign * trend.score +
      0.25 * sigSign * sigScore;

    const evidence = clamp01(Math.abs(signed));

    tfSignals.push({
      timeframe: tf,
      rsZScore: Math.round(z * 100) / 100,
      rsPValue: Math.round(pValue * 10000) / 10000,
      trendScore: Math.round(trend.score * 1000) / 1000,
      signalScore: Math.round(sigScore * 1000) / 1000,
      trendDirection: trend.direction,
      signal: latestSignal,
      signalAgeBars: ageBars,
      evidence: Math.round(evidence * 1000) / 1000,
      active: true,
    });
  }

  // ---- Cross-timeframe aggregation -------------------------------------
  //
  // The previous implementation computed max(buy, sell) / (buy + sell), which
  // returns exactly 100 whenever the opposing side is zero. That meant a coin
  // with one bullish timeframe out of three scored identically to a coin with
  // three — the score measured the absence of dissent, not confluence.
  //
  // Now: conviction = weighted evidence on the dominant side.
  //      agreement  = weighted share of the timeframe stack that agrees.
  // A high score therefore requires BOTH strong evidence AND real agreement.
  //
  // Every timeframes' signed contribution is computed once, up front, so the
  // aggregation loop below and the score cannot drift out of sync.

  interface Weighted {
    weight: number;
    signed: number;
  }
  const weighted: Weighted[] = [];

  for (const tfSig of tfSignals) {
    if (!tfSig.active) continue;
    const w = TF_WEIGHTS[tfSig.timeframe] ?? 0.3;

    const signed =
      0.40 * Math.sign(tfSig.rsZScore) * zEvidence(tfSig.rsZScore) +
      0.35 * (tfSig.trendDirection === 'bullish' ? 1 : tfSig.trendDirection === 'bearish' ? -1 : 0) *
        tfSig.trendScore +
      0.25 * (tfSig.signal ? (tfSig.signal.type === 'buy' ? 1 : -1) : 0) * tfSig.signalScore;

    weighted.push({ weight: w, signed });
  }

  const totalWeight = weighted.reduce((a, x) => a + x.weight, 0);
  let buyWeight = 0;
  let sellWeight = 0;
  let buyEvidence = 0;
  let sellEvidence = 0;

  for (const { weight: w, signed } of weighted) {
    if (signed > 0) {
      buyWeight += w;
      buyEvidence += w * signed;
    } else if (signed < 0) {
      sellWeight += w;
      sellEvidence += w * Math.abs(signed);
    }
  }

  const bullish = buyEvidence > sellEvidence && buyEvidence > 0;
  const bearish = sellEvidence > buyEvidence && sellEvidence > 0;

  const domWeight = bullish ? buyWeight : bearish ? sellWeight : 0;
  const domEvidence = bullish ? buyEvidence : bearish ? sellEvidence : 0;

  // Normalise evidence over the timeframes that actually spoke, not all three.
  const conviction = domWeight > 0 ? clamp01(domEvidence / domWeight) : 0;
  // Share of the whole stack (all active TFs) that agrees with the direction.
  const agreement = totalWeight > 0 ? clamp01(domWeight / totalWeight) : 0;
  const netBias =
    buyEvidence + sellEvidence > 0
      ? (buyEvidence - sellEvidence) / (buyEvidence + sellEvidence)
      : 0;

  // Conviction carries the score; agreement gates how much of it counts.
  // Zero evidence -> 0. Full evidence but only 1/3 of TFs agreeing -> capped
  // well below the strong threshold instead of printing 100.
  const base = Math.pow(conviction, 0.85);
  // Single agreement multiplier:
  //   all TFs agree (agreement=1) -> 1.00x
  //   1 of 3 agrees (agreement~0.2) -> 0.56x
  // This is what separates real confluence from a lone timeframe firing.
  const blended = base * (0.45 + 0.55 * agreement);
  const rawScore = clamp01(blended);

  const liq = liquidityFactor(options.quoteVolume);
  const confluenceScore = Math.round(rawScore * liq * 100);

  let confluenceDirection: 'bullish' | 'bearish' | 'none';
  let finalSignal: MultiTimeframeResult['finalSignal'];

  const STRONG = 72;
  const BUY = 48;

  if (bullish && conviction >= 0.35) {
    confluenceDirection = 'bullish';
    if (confluenceScore >= STRONG && agreement >= 0.6 && conviction >= 0.55) {
      finalSignal = 'strong_buy';
    } else if (confluenceScore >= BUY && agreement >= 0.4) {
      finalSignal = 'buy';
    } else {
      finalSignal = 'neutral';
    }
  } else if (bearish && conviction >= 0.35) {
    confluenceDirection = 'bearish';
    if (confluenceScore >= STRONG && agreement >= 0.6 && conviction >= 0.55) {
      finalSignal = 'strong_sell';
    } else if (confluenceScore >= BUY && agreement >= 0.4) {
      finalSignal = 'sell';
    } else {
      finalSignal = 'neutral';
    }
  } else {
    confluenceDirection = 'none';
    finalSignal = 'neutral';
  }

  const signalAges = tfSignals
    .filter((t) => t.signalAgeBars != null)
    .map((t) => t.signalAgeBars as number);

  const catId = (options.category ?? categoryFor(assetSymbol)) as CategoryId;
  const catMeta = categoryMeta(catId);
  const stable_ = isNonDirectional(catId);

  const narrative = buildNarrative({
    finalSignal,
    confluenceScore,
    conviction,
    agreement,
    tfSignals,
    liq,
    capTier: options.capTier as string | undefined,
    marketCap: options.marketCap,
    catId,
    catLabel: catMeta.label,
    stable_,
  });

  const rationale = [
    `conf=${confluenceScore}`,
    `conviction=${(conviction * 100).toFixed(0)}%`,
    `agreement=${(agreement * 100).toFixed(0)}%`,
    `net=${netBias >= 0 ? '+' : ''}${(netBias * 100).toFixed(0)}%`,
    `tfs=${tfSignals.filter((t) => t.active).length}/3`,
    `liq=${(liq * 100).toFixed(0)}%`,
  ].join(' · ');

  return {
    asset: assetSymbol,
    timeframes: tfSignals,
    confluenceScore,
    confluenceDirection,
    finalSignal,
    newestSignalAgeBars: signalAges.length > 0 ? Math.min(...signalAges) : null,
    conviction: Math.round(conviction * 1000) / 1000,
    agreement: Math.round(agreement * 1000) / 1000,
    netBias: Math.round(netBias * 1000) / 1000,
    rawScore: Math.round(rawScore * 100),
    liquidityFactor: liq,
    narrative,
    marketCap: options.marketCap ?? null,
    quoteVolume: options.quoteVolume ?? null,
    capTier: options.capTier ?? 'unknown',
    category: catId,
    categoryLabel: catMeta.label,
    rationale,
  };
}
