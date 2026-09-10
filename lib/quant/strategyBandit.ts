export type StrategyArm = 'decoupling' | 'momentum' | 'spike';

export interface BanditArmState {
  arm: StrategyArm;
  pulls: number;
  totalReward: number;
  /** For UCB1 */
  avgReward: number;
}

export interface BanditState {
  arms: Record<StrategyArm, BanditArmState>;
  lastPicked?: StrategyArm;
  updatedAt: number;
}

export function createBanditState(): BanditState {
  const mk = (arm: StrategyArm): BanditArmState => ({
    arm,
    pulls: 0,
    totalReward: 0,
    avgReward: 0,
  });
  return {
    arms: {
      decoupling: mk('decoupling'),
      momentum: mk('momentum'),
      spike: mk('spike'),
    },
    updatedAt: Date.now(),
  };
}

function armList(state: BanditState): BanditArmState[] {
  return Object.values(state.arms);
}

/**
 * UCB1 strategy bandit (paper §5.5).
 * reward should be roughly in [-1, 1] — e.g. pnlPercent/5 clipped.
 */
export function pickStrategyUCB(state: BanditState): StrategyArm {
  const arms = armList(state);
  const totalPulls = arms.reduce((a, x) => a + x.pulls, 0);

  // Explore unpulled arms first
  for (const a of arms) {
    if (a.pulls === 0) {
      state.lastPicked = a.arm;
      state.updatedAt = Date.now();
      return a.arm;
    }
  }

  let best: BanditArmState = arms[0];
  let bestScore = -Infinity;
  for (const a of arms) {
    const explore = Math.sqrt((2 * Math.log(totalPulls + 1)) / a.pulls);
    const score = a.avgReward + explore;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  state.lastPicked = best.arm;
  state.updatedAt = Date.now();
  return best.arm;
}

export function updateBandit(
  state: BanditState,
  arm: StrategyArm,
  reward: number
): BanditState {
  const a = state.arms[arm];
  if (!a) return state;
  const r = Math.max(-1, Math.min(1, reward));
  a.pulls += 1;
  a.totalReward += r;
  a.avgReward = a.totalReward / a.pulls;
  state.updatedAt = Date.now();
  return state;
}

export function banditSummary(state: BanditState): string {
  return armList(state)
    .map((a) => `${a.arm}: n=${a.pulls} avg=${a.avgReward.toFixed(2)}`)
    .join(' · ');
}
