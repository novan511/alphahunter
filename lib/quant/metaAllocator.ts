import { MarketId, getMarketProfile } from './marketProfiles';

export interface DeskPerf {
  agentId: MarketId | string;
  equity: number;
  capitalStart: number;
  pnlPercent: number;
  winRate: number;
  totalTrades: number;
  maxDrawdownPct: number;
  running: boolean;
}

export interface MetaAllocation {
  /** Next paper capital share per desk, sums ~1 */
  weights: Record<string, number>;
  /** Suggested capital $ per desk for next start / size scaling */
  suggestedCapital: Record<string, number>;
  reason: string;
  utility: Record<string, number>;
  generatedAt: number;
}

const DESKS: MarketId[] = ['crypto', 'commodities', 'gold-silver'];
const LAMBDA_DD = 1.5;
const MIN_SAMPLE = 5;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Meta-agent capital rebalancer (paper §6).
 * Reward per desk ≈ Sharpe-proxy − λ · MaxDD, then softmax weights.
 * Still paper-only: scales suggested capital & size hints, not live orders.
 */
export function allocateMetaCapital(
  desks: DeskPerf[],
  baseCapital = 1000
): MetaAllocation {
  const byId = new Map(desks.map((d) => [d.agentId, d]));
  const utility: Record<string, number> = {};
  const weights: Record<string, number> = {};
  const suggestedCapital: Record<string, number> = {};

  const reasons: string[] = [];

  for (const id of DESKS) {
    const d = byId.get(id);
    const profile = getMarketProfile(id as MarketId);

    if (!d || !d.running) {
      utility[id] = -0.5;
      reasons.push(`${id}: offline → low weight`);
      continue;
    }

    // Sharpe-ish proxy from PnL and win rate (no bar returns here)
    const win = clamp(d.winRate / 100, 0, 1);
    const pnlScore = clamp(d.pnlPercent / 10, -1, 1);
    const samplePenalty = d.totalTrades < MIN_SAMPLE ? 0.3 : 1;
    const ddPenalty = (d.maxDrawdownPct / 100) * LAMBDA_DD;

    // Prefer desks that are actually profitable. The previous expression used
    // `targetMid * 0.05`, which silently rewrote a 30% monthly target into
    // "be at +1.5% P&L" — so 20% of the utility rewarded desks for being flat.
    const kpiFit = clamp(d.pnlPercent / 10, 0, 1);

    const u =
      samplePenalty * (0.45 * pnlScore + 0.35 * (win - 0.5) + 0.2 * kpiFit) - ddPenalty;
    utility[id] = Math.round(u * 1000) / 1000;

    if (d.totalTrades < MIN_SAMPLE) {
      reasons.push(`${id}: small sample → capped`);
    }
    if (d.pnlPercent < -3) {
      reasons.push(`${id}: under pressure → de-risk`);
    }
    if (d.pnlPercent > 1 && d.winRate >= 40) {
      reasons.push(`${id}: healthy → more share`);
    }
  }

  // Softmax on utilities.
  const exps: Record<string, number> = {};
  let sumExp = 0;
  for (const id of DESKS) {
    const e = Math.exp(utility[id] * 2);
    exps[id] = e;
    sumExp += e;
  }

  // Allocate only across RUNNING desks.
  //
  // A desk that is not running cannot execute anything, so it gets no capital.
  // Clamping a small non-zero weight then renormalising gave offline desks ~46%
  // of the book whenever two were stopped — capital pointed at nothing.
  const running = DESKS.filter((id) => byId.get(id)?.running);

  if (running.length === 0) {
    for (const id of DESKS) weights[id] = 0;
    return {
      weights,
      suggestedCapital,
      reason: 'no desk running — no allocation',
      utility,
      generatedAt: Date.now(),
    };
  }

  // Bounds only matter once there is genuine competition for capital. With one
  // desk live it must take everything; with two, neither should be starved.
  const LO = running.length >= 3 ? 0.15 : 0.2;
  const HI = running.length >= 3 ? 0.55 : 0.7;

  const liveRaw: Record<string, number> = {};
  let liveSumExp = 0;
  for (const id of running) {
    const raw = exps[id] / (sumExp || 1);
    liveRaw[id] = raw;
    liveSumExp += raw;
  }

  for (const id of DESKS) {
    if (!byId.get(id)?.running) {
      weights[id] = 0;
      continue;
    }
    weights[id] = clamp(liveSumExp > 0 ? liveRaw[id] / liveSumExp : 1 / running.length, LO, HI);
  }

  // Renormalise within the running set only.
  const wSum = running.reduce((acc, id) => acc + weights[id], 0) || 1;
  for (const id of running) {
    weights[id] = Math.round((weights[id] / wSum) * 1000) / 1000;
    suggestedCapital[id] = Math.round(baseCapital * weights[id] * 100) / 100;
  }
  for (const id of DESKS) {
    if (!byId.get(id)?.running) suggestedCapital[id] = 0;
  }

  return {
    weights,
    suggestedCapital,
    reason: reasons.length ? reasons.join(' · ') : 'balanced across running desks',
    utility,
    generatedAt: Date.now(),
  };
}

/** Scale riskPerTrade hint from meta weight (relative to equal 1/3). */
export function metaRiskScale(allocation: MetaAllocation, agentId: string): number {
  const w = allocation.weights[agentId];
  if (w === undefined) return 1;
  const equal = 1 / 3;
  return clamp(w / equal, 0.6, 1.4);
}
