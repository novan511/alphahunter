/**
 * "What can I actually trade" — derived from the current scan snapshot.
 *
 * The ranking table already lists every coin with a score. What it does not
 * answer is the question a trader asks before clicking: is this name
 * executable, at what size, and what kills the idea. This module turns the
 * score into a short, explicit list with the risk surfaced instead of hidden.
 *
 * Design rules, all of which exist to stop this list from lying:
 *
 * 1. Hard gates, not a weighted score. A coin that fails any gate is rejected
 *    and never reaches the list. Averaging a good signal against terrible
 *    liquidity produces a mid-ranked coin that is still untradeable, which is
 *    the worst possible outcome for a "what should I trade" panel.
 * 2. Peg assets are excluded. A stablecoin's "signal" is a depeg, not a
 *    direction. Listing it as a long is a category error, not a trade.
 * 3. Every entry carries its invalidation. A trade without a stated
 *    falsifier is an opinion.
 * 4. Sizing is expressed as a risk budget (max % of equity to lose), not a
 *    position size — position size needs the entry price and stop distance,
 *    which a single snapshot cannot supply.
 */

import { clamp01 } from './indicators';
import { MultiTimeframeResult, tfSigned } from './multiTimeframe';
import { SectorHeat } from './narrativeHeat';
import { CategoryId, categoryMeta, isNonDirectional } from '../assetCategory';

export type TradeDirection = 'long' | 'short';
export type RiskTier = 'low' | 'medium' | 'high';
export type TradeHorizon = 'scalp' | 'intraday' | 'swing' | 'position';

/** Daily quote volume below which a book is not executable. Mirrors liquidityFactor(). */
export const MIN_QUOTE_VOLUME_USD = 250_000;

/** Hard gate: minimum liquidity multiplier (0.45 == ~$250k/24h). */
const MIN_LIQ = 0.45;
/** Hard gate: minimum confluence score to be considered a setup at all. */
const MIN_CONFLUENCE = 40;

/** Per-category risk, 0-1. Reflects how the asset behaves, not its quality. */
const CATEGORY_RISK: Partial<Record<CategoryId, number>> = {
  meme: 1.0,
  ai: 0.8,
  gaming: 0.7,
  nft: 0.7,
  storage: 0.65,
  other: 0.6,
  l2: 0.55,
  perps: 0.55,
  privacy: 0.55,
  rwa: 0.5,
  defi: 0.5,
  exchange: 0.45,
  oracle: 0.4,
  l1: 0.35,
  infra: 0.35,
  payments: 0.3,
  liquid_staking: 0.4,
  stablecoin: 0.1,
};

/** Cap-tier risk, 0-1. Gap and liquidity risk rise as size falls. */
const TIER_RISK: Record<string, number> = {
  mega: 0.08,
  large: 0.18,
  mid: 0.4,
  small: 0.7,
  micro: 1.0,
  unknown: 0.6,
};

export interface RejectReason {
  asset: string;
  reasons: string[];
}

/** Why a coin is on the list, in plain language. */
export interface TradeableCoin {
  asset: string;
  ticker: string;
  direction: TradeDirection;
  signal: MultiTimeframeResult['finalSignal'];
  /** 0-100 execution quality. High = good signal on a deep book, aligned. */
  tradability: number;
  confluenceScore: number;
  conviction: number;
  agreement: number;
  liquidityFactor: number;
  quoteVolume: number | null;
  marketCap: number | null;
  capTier: string;
  category: CategoryId;
  categoryLabel: string;
  categoryIcon: string;
  categoryColor: string;
  /** Which timeframe pattern the setup implies. */
  horizon: TradeHorizon;
  riskTier: RiskTier;
  /** 0-1 composite risk. Higher is riskier; `riskTier` is its label. */
  riskScore: number;
  /** Suggested max equity at risk, as % — a cap, not a recommendation. */
  riskBudgetPct: number;
  /** Signed per-timeframe evidence for the mini sparkline, 1h/4h/1d. */
  tfTilt: number[];
  /** Evidence trail: why this passed. */
  why: string[];
  /** What would prove the idea wrong. */
  invalidation: string[];
  /** Sector this coin belongs to, when the sector read is bullish. */
  sectorPhase?: string;
  /** True when the coin's own daily disagrees with the trade. */
  counterTrend: boolean;
}

export interface TradeableResult {
  trades: TradeableCoin[];
  /** Near-misses: same gates, but no confirmed signal yet. */
  watchlist: WatchItem[];
  /** Coins that failed the gates, with the reason — used by the UI's audit note. */
  rejects: RejectReason[];
  /** Volume figures behind the liquidity gate, for display. */
  gates: {
    minLiquidity: number;
    minQuoteVolume: number;
    minConfluence: number;
    excludedPegAssets: number;
  };
}

export interface WatchItem {
  asset: string;
  ticker: string;
  category: CategoryId;
  categoryLabel: string;
  categoryIcon: string;
  categoryColor: string;
  confluenceScore: number;
  /** How far short of a signal the coin is. */
  netBias: number;
  riskTier: RiskTier;
  note: string;
}

interface GateResult {
  ok: boolean;
  reasons: string[];
  direction: TradeDirection;
}

function directionOf(r: MultiTimeframeResult): TradeDirection {
  return r.finalSignal.includes('sell') ? 'short' : 'long';
}

/**
 * Hard tradability gates. Returns the failures so the UI can explain why a
 * strong-looking coin is missing rather than silently omitting it.
 */
function checkGates(r: MultiTimeframeResult): GateResult {
  const reasons: string[] = [];
  const ticker = r.asset.replace('USDT', '');

  const liq = r.liquidityFactor ?? 0;
  if (liq < MIN_LIQ) {
    reasons.push('volume tipis');
  }

  const cat = (r.category ?? 'other') as CategoryId;
  if (isNonDirectional(cat)) {
    // Not a failure of quality — it is simply a different instrument.
    reasons.push('aset peg — bukan trade arah');
  }

  if ((r.confluenceScore ?? 0) < MIN_CONFLUENCE) {
    reasons.push(`confluence ${r.confluenceScore} < ${MIN_CONFLUENCE}`);
  }

  // Micro caps are rejected outright rather than merely flagged: a gap can
  // print through any stop, so the entry this list is recommending would not
  // be one the trader could actually honour. An *unknown* cap is NOT rejected —
  // fresh scans may have no cap source yet, and an empty list would be a worse
  // failure than an unverified size. Those stay in and say so.
  if (r.capTier === 'micro') {
    reasons.push('micro cap — gap risk, stop bisa tembus');
  }

  if (r.finalSignal === 'neutral') {
    reasons.push('belum ada signal');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    direction: directionOf(r),
  };
}

function horizonOf(r: MultiTimeframeResult, dir: TradeDirection): TradeHorizon {
  const sign = dir === 'long' ? 1 : -1;
  const agrees = r.timeframes
    .filter((t) => t.active)
    .filter((t) => tfSigned(t) * sign > 0.05)
    .map((t) => t.timeframe);

  const has = (tf: string) => agrees.indexOf(tf) >= 0;
  if (has('1d') && has('4h')) return 'swing';
  if (has('1d')) return 'position';
  if (has('4h')) return 'intraday';
  return 'scalp';
}

const HORIZON_LABEL: Record<TradeHorizon, string> = {
  scalp: 'Scalp (1h)',
  intraday: 'Intraday (4h)',
  swing: 'Swing (1d)',
  position: 'Position (daily only)',
};

const HORIZON_NOTE: Record<TradeHorizon, string> = {
  scalp: 'Hanya 1h searah — timeframe cepat, quick to reverse.',
  intraday: '1h+4h searah, harian belum — tahan intraday, jangan tahan overnight.',
  swing: '4h+1d searah — setup swing, boleh lintas hari.',
  position: 'Hanya harian searah, near-term belum dukung — risiko entry salah waktu tinggi.',
};

/**
 * Signed evidence per timeframe, rounded for display. Reads through `tfSigned`
 * so the horizon label, the risk score and the confluence score can never
 * disagree about which timeframe actually agrees.
 */
function tfTilts(r: MultiTimeframeResult): number[] {
  return r.timeframes.map((t) => (t.active ? Math.round(tfSigned(t) * 100) / 100 : 0));
}

function computeRisk(r: MultiTimeframeResult, dir: TradeDirection): { score: number; tier: RiskTier } {
  const liq = r.liquidityFactor ?? 0;
  const agree = r.agreement ?? 0;
  const tierRisk = TIER_RISK[r.capTier ?? 'unknown'] ?? 0.6;
  const catRisk = CATEGORY_RISK[(r.category ?? 'other') as CategoryId] ?? 0.6;
  const age = r.newestSignalAgeBars ?? 0;

  const thin = clamp01((0.85 - liq) / 0.55);
  const disagree = 1 - clamp01(agree);
  const stale = clamp01(age / 8);

  // Directional risk is asymmetric: being short a coin whose daily is still
  // up is riskier than being long one whose daily is still down, because a
  // squeeze against a short is unbounded while the reverse is not.
  const dailyTilt = tfTilts(r)[2] ?? 0;
  const counter = dir === 'short' && dailyTilt > 0.05 ? 1 : dir === 'long' && dailyTilt < -0.05 ? 1 : 0;
  const shortPenalty = dir === 'short' ? 0.06 : 0;

  const score = clamp01(
    0.28 * thin +
      0.24 * disagree +
      0.20 * tierRisk +
      0.16 * catRisk +
      0.07 * stale +
      0.05 * counter +
      shortPenalty
  );

  const tier: RiskTier = score < 0.4 ? 'low' : score < 0.65 ? 'medium' : 'high';
  return { score, tier };
}

/**
 * Suggested maximum equity at risk. Deliberately a ceiling scaled down by risk
 * tier and scaled up by conviction — a high-conviction, low-risk setup earns
 * the top of its band, and nothing ever exceeds the band.
 */
function riskBudget(tier: RiskTier, conviction: number): number {
  const c = clamp01(conviction);
  switch (tier) {
    case 'low':
      return Math.round(Math.min(2.5, 1.0 + c * 1.5) * 100) / 100;
    case 'medium':
      return Math.round(Math.min(1.5, 0.5 + c * 1.0) * 100) / 100;
    default:
      return Math.round(Math.min(0.75, 0.25 + c * 0.5) * 100) / 100;
  }
}

function buildWhy(r: MultiTimeframeResult, dir: TradeDirection, h: TradeHorizon): string[] {
  const tfs = r.timeframes.filter((t) => t.active);
  const aligned = tfs.filter((t) => {
    const tilt = tfTilts(r)[tfs.indexOf(t)];
    return tilt * (dir === 'long' ? 1 : -1) > 0;
  });
  const list = aligned.map((t) => t.timeframe).join(', ') || '—';

  return [
    `${r.finalSignal.replace('_', ' ').toUpperCase()} · confluence ${r.confluenceScore} · ${tfs.length}/3 timeframe aktif`,
    `Timeframe searah (${list}) → ${HORIZON_LABEL[h]}`,
    `Conviction ${Math.round((r.conviction ?? 0) * 100)}% dengan kesepakatan ${Math.round((r.agreement ?? 0) * 100)}%`,
  ];
}

function buildInvalidation(r: MultiTimeframeResult, dir: TradeDirection, risk: RiskTier): string[] {
  const out: string[] = [];
  const daily = tfTilts(r)[2] ?? 0;

  if (dir === 'long' && daily < -0.05) out.push('Tren harian masih turun — invalid kalau harian tidak berbalik dalam 1-2 candle.');
  if (dir === 'short' && daily > 0.05) out.push('Tren harian masih naik — short melawan daily, rawan squeeze.');

  const agree = r.agreement ?? 0;
  if (agree < 0.6) out.push(`Kesepakatan timeframe cuma ${Math.round(agree * 100)}% — kalau 1h berbalik, setup gagal.`);
  if (agree >= 0.8) out.push('Semua timeframe searah; yang paling sering gagal di sini adalah entry, bukan arah.');

  const liq = r.liquidityFactor ?? 0;
  if (liq < 0.7) out.push('Book tipis — slippage saat keluar bisa menghapus edge.');

  const age = r.newestSignalAgeBars;
  if (age != null && age > 4) out.push(`Sinyal sudah ${age} bar lama — chance-nya sudah sebagian hilang.`);
  if (age == null && r.finalSignal !== 'neutral') out.push('Tidak ada pemicu decoupling yang masih segar — purely continuation.');

  if (r.capTier === 'micro' || r.capTier === 'unknown') {
    out.push('Cap tidak terverifikasi — cek float dan unlock schedule sebelum sizing.');
  }

  if (risk === 'high') out.push('Profil risiko tinggi: half size normal, atau lewati.');

  return out;
}

export interface BuildTradeableOptions {
  /** Sector read, used to tag a coin with its narrative phase. */
  sectors?: SectorHeat[];
  /** Cap on returned trades, after ranking. */
  limit?: number;
}

/**
 * Build the tradeable list plus the near-miss watchlist.
 */
export function buildTradeableList(
  rankings: MultiTimeframeResult[],
  options: BuildTradeableOptions = {}
): TradeableResult {
  const sectorById = new Map<CategoryId, SectorHeat>();
  for (const s of options.sectors ?? []) sectorById.set(s.id, s);

  const trades: TradeableCoin[] = [];
  const watchlist: WatchItem[] = [];
  const rejects: RejectReason[] = [];
  let pegExcluded = 0;

  for (const r of rankings) {
    const cat = (r.category ?? 'other') as CategoryId;
    const meta = categoryMeta(cat);
    const gate = checkGates(r);

    if (!gate.ok) {
      // Peg assets are a category exclusion, not a quality failure — counting
      // them as "rejects" would imply something is wrong with them.
      if (isNonDirectional(cat)) pegExcluded++;
      else rejects.push({ asset: r.asset.replace('USDT', ''), reasons: gate.reasons });
      continue;
    }

    const dir = gate.direction;
    const horizon = horizonOf(r, dir);
    const { score: riskScore, tier } = computeRisk(r, dir);
    const liq = r.liquidityFactor ?? 0;
    const conviction = r.conviction ?? 0;
    const agreement = r.agreement ?? 0;
    const tilts = tfTilts(r);
    const sector = sectorById.get(cat);

    // Signal quality is graded, not binary: a strong signal on a deep, fully
    // aligned book ranks above a weak signal on a thin one.
    const signalQuality = r.finalSignal.startsWith('strong') ? 1 : 0.7;
    const tradability = Math.round(
      100 *
        clamp01(
          0.3 * signalQuality +
            0.25 * conviction +
            0.2 * agreement +
            0.25 * clamp01(liq / 1)
        )
    );

    trades.push({
      asset: r.asset,
      ticker: r.asset.replace('USDT', ''),
      direction: dir,
      signal: r.finalSignal,
      tradability,
      confluenceScore: r.confluenceScore,
      conviction,
      agreement,
      liquidityFactor: liq,
      quoteVolume: r.quoteVolume ?? null,
      marketCap: r.marketCap ?? null,
      capTier: r.capTier ?? 'unknown',
      category: cat,
      categoryLabel: meta.label,
      categoryIcon: meta.icon,
      categoryColor: meta.color,
      horizon,
      riskTier: tier,
      riskScore,
      riskBudgetPct: riskBudget(tier, conviction),
      tfTilt: tilts,
      why: buildWhy(r, dir, horizon),
      invalidation: buildInvalidation(r, dir, tier),
      sectorPhase: sector?.phase,
      counterTrend: dir === 'long' ? (tilts[2] ?? 0) < -0.05 : (tilts[2] ?? 0) > 0.05,
    });
  }

  // Rank by tradability, then confluence. A coin at the same execution quality
  // should defer to the stronger underlying read.
  trades.sort((a, b) => b.tradability - a.tradability || b.confluenceScore - a.confluenceScore);

  // Watchlist: names that clear every gate except the signal itself, and whose
  // short-term evidence is genuinely turning up. This is the earliest honest
  // warning the snapshot can give — the trend exists, the trigger does not.
  for (const r of rankings) {
    if (r.finalSignal !== 'neutral') continue;
    const cat = (r.category ?? 'other') as CategoryId;
    if (isNonDirectional(cat)) continue;
    const liq = r.liquidityFactor ?? 0;
    if (liq < MIN_LIQ) continue;
    if ((r.confluenceScore ?? 0) < MIN_CONFLUENCE - 15) continue;

    const tilts = tfTilts(r);
    const shortUp = (tilts[0] ?? 0) + (tilts[1] ?? 0);
    const bias = r.netBias ?? 0;
    if (bias <= 0.05 || shortUp <= 0.05) continue;

    const meta = categoryMeta(cat);
    const { tier } = computeRisk(r, 'long');
    watchlist.push({
      asset: r.asset,
      ticker: r.asset.replace('USDT', ''),
      category: cat,
      categoryLabel: meta.label,
      categoryIcon: meta.icon,
      categoryColor: meta.color,
      confluenceScore: r.confluenceScore,
      netBias: bias,
      riskTier: tier,
      note: `Net bias +${Math.round(bias * 100)}% dan 1h/4h sudah positif (${shortUp.toFixed(2)}) — tren ada, pemicunya belum. Kalau konfluensi tembus ${MIN_CONFLUENCE} dengan alignment 1h+4h, masuk daftar trade.`,
    });
  }

  watchlist.sort((a, b) => b.netBias - a.netBias);

  return {
    trades: options.limit ? trades.slice(0, options.limit) : trades,
    watchlist: watchlist.slice(0, 12),
    rejects,
    gates: {
      minLiquidity: MIN_LIQ,
      minQuoteVolume: MIN_QUOTE_VOLUME_USD,
      minConfluence: MIN_CONFLUENCE,
      excludedPegAssets: pegExcluded,
    },
  };
}

export { HORIZON_LABEL, HORIZON_NOTE };
