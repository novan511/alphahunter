export interface StressTrade {
  pnl: number;
  pnlPercent?: number;
}

export interface StressResult {
  iterations: number;
  baseReturnPct: number;
  baseProfitFactor: number;
  meanReturnPct: number;
  stdReturnPct: number;
  p5ReturnPct: number;
  p95ReturnPct: number;
  worstReturnPct: number;
  bestReturnPct: number;
  probabilityPositive: number;
  meanProfitFactor: number;
  scenario: string;
  notes: string[];
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function profitFactor(pnls: number[]): number {
  const gp = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  if (gl === 0) return gp > 0 ? 99 : 0;
  return gp / gl;
}

function pctile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/**
 * Monte Carlo stress on a trade PnL vector (paper §8 robustness).
 * Scenarios: order_shuffle, lag_penalty, vol_surge.
 */
export function runStressTest(
  trades: StressTrade[],
  options: {
    iterations?: number;
    scenario?: 'order_shuffle' | 'lag_penalty' | 'vol_surge' | 'all';
    seed?: number;
    initialCapital?: number;
  } = {}
): StressResult {
  const iterations = Math.min(options.iterations ?? 500, 5000);
  const initialCapital = options.initialCapital ?? 1000;
  const scenario = options.scenario ?? 'all';
  const notes: string[] = [];

  const basePnls = trades.map((t) => t.pnl);
  const baseReturn =
    (basePnls.reduce((a, b) => a + b, 0) / initialCapital) * 100;
  const basePF = profitFactor(basePnls);

  if (trades.length < 5) {
    notes.push('Sample < 5 trades — stress numbers are noisy.');
  }

  // Simple LCG for reproducibility without deps
  let s = options.seed ?? 42;
  const rng = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const returns: number[] = [];
  const pfs: number[] = [];

  for (let i = 0; i < iterations; i++) {
    let pnls = basePnls.map((p) => p);

    if (scenario === 'order_shuffle' || scenario === 'all') {
      pnls = shuffle(pnls, rng);
    }
    if (scenario === 'lag_penalty' || scenario === 'all') {
      // assume 15% of wins slip to slightly smaller
      pnls = pnls.map((p) => (p > 0 ? p * (0.85 + rng() * 0.1) : p * (1 + rng() * 0.1)));
    }
    if (scenario === 'vol_surge' || scenario === 'all') {
      // inject occasional larger loss days
      pnls = pnls.map((p) => (rng() < 0.08 ? p * (1 + rng() * 1.5) : p));
    }

    const total = pnls.reduce((a, b) => a + b, 0);
    returns.push((total / initialCapital) * 100);
    pfs.push(profitFactor(pnls));
  }

  const sorted = [...returns].sort((a, b) => a - b);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / returns.length;
  const std = Math.sqrt(variance);
  const probPos = returns.filter((r) => r > 0).length / returns.length;

  notes.push(`Scenario mix: ${scenario}. Fees/slippage already in original trades if applied.`);

  return {
    iterations,
    baseReturnPct: Math.round(baseReturn * 100) / 100,
    baseProfitFactor: Math.round(basePF * 100) / 100,
    meanReturnPct: Math.round(mean * 100) / 100,
    stdReturnPct: Math.round(std * 100) / 100,
    p5ReturnPct: Math.round(pctile(sorted, 5) * 100) / 100,
    p95ReturnPct: Math.round(pctile(sorted, 95) * 100) / 100,
    worstReturnPct: Math.round(sorted[0] * 100) / 100,
    bestReturnPct: Math.round(sorted[sorted.length - 1] * 100) / 100,
    probabilityPositive: Math.round(probPos * 1000) / 10,
    meanProfitFactor: Math.round((pfs.reduce((a, b) => a + b, 0) / pfs.length) * 100) / 100,
    scenario,
    notes,
  };
}
