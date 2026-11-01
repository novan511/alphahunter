/**
 * XGBoost JSON model inference in pure TypeScript — Arena-inspired.
 * Supports classification (long/short/flat) with regime filter, probability threshold,
 * exit ladder, loss streak de-risking, circuit breaker, and correlation guardrail.
 * No Python runtime, no npm ML deps.
 */

export interface XGBoostTreeNode {
  nodeid: number;
  feature?: number;
  threshold?: number;
  yes?: number;
  no?: number;
  missing?: number;
  leaf?: number;
}

export interface XGBoostTree {
  nodes: XGBoostTreeNode[];
  root: number;
}

export interface XGBoostModel {
  feature_names: string[];
  num_trees: number;
  trees: XGBoostTree[];
  base_score: number;
  objective: string;
  task_type?: string;
  num_class?: number;
}

export interface MlMeta {
  symbol?: string;
  interval?: string;
  trained_at?: string;
  forward_bars?: number;
  task_type?: string;
  regime_filter?: string;
  prob_threshold?: number;
  leverage?: number;
  allow_short?: boolean;
  rr_ratio?: number;
  risk_per_trade?: number;
  stop_loss_atr?: number;
  take_profit_atr?: number;
  max_hold_bars?: number;
  feature_cols?: string[];
  feature_importance?: Record<string, number>;
  oos_metrics?: any;
  gates_passed?: boolean;
  model_type?: string;
  base_score?: number;
  archetype?: string;
}

export interface PredictionResult {
  value: number; // raw model output (log-return estimate or class score)
  probabilityUp: number; // P(return > 0) in [0,1]
  probabilityDown: number; // P(return < 0) in [0,1]
  probabilityFlat: number; // P(flat) in [0,1]
  confidence: number; // distance from neutral in [0,0.5]
  signal: 'long' | 'short' | 'flat'; // signal direction
  regimePass: boolean; // whether regime filter passed
  source: 'model' | 'fallback';
  meta?: MlMeta | null | undefined;
}

/**
 * Traverse a single tree to its leaf value.
 */
function traverseTree(tree: XGBoostTree, features: number[]): number {
  let nodeId = tree.root;
  const nodes = tree.nodes;

  while (true) {
    const node = nodes.find((n) => n.nodeid === nodeId);
    if (!node) return 0;

    if (node.leaf !== undefined) return node.leaf;

    const featureIdx = node.feature!;
    const threshold = node.threshold!;
    const val = features[featureIdx];

    if (Number.isNaN(val)) {
      nodeId = node.missing!;
    } else if (val < threshold) {
      nodeId = node.yes!;
    } else {
      nodeId = node.no!;
    }
  }
}

/**
 * Sigmoid for probability calibration.
 */
function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

/**
 * Load model from a JSON object (already parsed).
 */
export function loadModelFromJSON(obj: unknown): XGBoostModel | null {
  try {
    const m = obj as XGBoostModel;
    if (!m || !Array.isArray(m.trees) || !Array.isArray(m.feature_names)) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Load meta from a JSON object.
 */
export function loadMetaFromJSON(obj: unknown): MlMeta | null {
  try {
    return obj as MlMeta;
  } catch {
    return null;
  }
}

/**
 * Arena-style guardrail state — maintained across predictions.
 */
export interface GuardrailState {
  lossStreak: number;
  openPositions: OpenPosition[];
  symbolTrades: Record<string, number[]>; // symbol -> list of R multiples
  exitReasonCounts: Record<string, number>;
  account: number;
  peakEquity: number;
  circuitBlocked: boolean;
  knockout: boolean;
}

export interface OpenPosition {
  side: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskUnit: number;
  barsHeld: number;
  tookPartial: boolean;
  qty: number;
  entryTime: number;
  riskDollar: number;
}

export function createGuardrailState(initialCapital: number = 1000): GuardrailState {
  return {
    lossStreak: 0,
    openPositions: [],
    symbolTrades: {},
    exitReasonCounts: {},
    account: initialCapital,
    peakEquity: initialCapital,
    circuitBlocked: false,
    knockout: false,
  };
}

/**
 * Predict using an XGBoost JSON model with classification support, regime filter,
 * probability threshold, and guardrail-aware signal gating.
 */
export function predict(
  model: XGBoostModel | null,
  meta: MlMeta | null,
  features: number[],
  btcBullFilter: number = 1,
  guardrail?: GuardrailState | null,
): PredictionResult {
  const probThreshold = meta?.prob_threshold ?? 0.53;
  const regimeFilter = meta?.regime_filter ?? 'none';
  const allowShort = meta?.allow_short ?? true;
  const taskType = meta?.task_type ?? 'regression';

  if (!model) {
    return {
      value: 0,
      probabilityUp: 0.5,
      probabilityDown: 0.5,
      probabilityFlat: 0.0,
      confidence: 0,
      signal: 'flat',
      regimePass: true,
      source: 'fallback',
      meta,
    };
  }

  let raw = model.base_score;
  for (const tree of model.trees) {
    raw += traverseTree(tree, features);
  }

  // Calibrate probability from raw model output
  const SIGMOID_SCALE = 300.0;
  const scaled = raw * SIGMOID_SCALE;
  const sigmoidUp = sigmoid(scaled);
  const sigmoidDown = 1 - sigmoidUp;

  let probabilityUp: number;
  let probabilityDown: number;
  let probabilityFlat: number;

  if (taskType === 'classification') {
    // For classification, softmax over 3 classes: raw output is log-odds proxy
    // We approximate: prob_up = sigmoid(raw), prob_down = sigmoid(-raw), flat = remaining
    probabilityUp = sigmoidUp;
    probabilityDown = sigmoidDown;
    probabilityFlat = Math.max(0, 1 - probabilityUp - probabilityDown);
    // Normalize to sum to 1
    const total = probabilityUp + probabilityDown + probabilityFlat;
    probabilityUp /= total;
    probabilityDown /= total;
    probabilityFlat /= total;
  } else {
    // Regression: treat raw as log-return estimate
    probabilityUp = sigmoidUp;
    probabilityDown = sigmoidDown;
    probabilityFlat = 0;
  }

  const confidence = Math.abs(probabilityUp - probabilityDown);

  // Regime filter
  // Feature index 7 = btc_bull_filter in our feature vector
  const btcBullFeature = features.length > 7 ? features[7] : 1;
  let regimePass = true;
  if (regimeFilter === 'bull_only') {
    regimePass = btcBullFeature === 1 || btcBullFilter === 1;
  } else if (regimeFilter === 'bear_only') {
    regimePass = btcBullFeature === 0 || btcBullFilter === 0;
  }

  // Guardrail checks
  const gr = guardrail || createGuardrailState();
  const streakCap = (
    gr.lossStreak >= 5 ? 0.005 :
    gr.lossStreak >= 4 ? 0.0075 :
    gr.lossStreak >= 3 ? 0.01 :
    gr.lossStreak >= 2 ? 0.015 :
    gr.lossStreak >= 1 ? 0.02 : 0.03
  );
  const effRisk = Math.min(meta?.risk_per_trade ?? 0.01, streakCap);

  // Circuit breaker check
  const openUnrealizedR = gr.openPositions.reduce((sum, pos) => {
    // We don't have current price here; skip circuit calc in predict
    return sum;
  }, 0);

  // Signal determination
  let signal: 'long' | 'short' | 'flat' = 'flat';

  const takeLong = probabilityUp > probThreshold && regimePass;
  const takeShort = allowShort && probabilityDown > probThreshold && regimePass;

  if (taskType === 'classification') {
    // Class encoding: 0=down, 1=flat, 2=up
    const predClass = raw > 0 ? 2 : raw < 0 ? 0 : 1;
    if (takeLong && predClass === 2) signal = 'long';
    else if (takeShort && predClass === 0) signal = 'short';
    else signal = 'flat';
  } else {
    if (takeLong && takeShort) {
      signal = probabilityUp >= probabilityDown ? 'long' : 'short';
    } else if (takeLong) {
      signal = 'long';
    } else if (takeShort) {
      signal = 'short';
    }
  }

  // Apply guardrail: if circuit blocked or knockout, force flat
  if (gr.circuitBlocked || gr.knockout) {
    signal = 'flat';
  }

  return {
    value: raw,
    probabilityUp,
    probabilityDown,
    probabilityFlat,
    confidence,
    signal,
    regimePass,
    source: 'model',
    meta,
  };
}

/**
 * Apply exit ladder and guardrails to an open position.
 * Returns updated position and optional exit action.
 */
export function managePosition(
  pos: {
    side: 'long' | 'short';
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    riskUnit: number;
    barsHeld: number;
    tookPartial: boolean;
    qty: number;
  },
  currentPrice: number,
  currentATR: number,
  maxHoldBars: number,
  partialR: number = 1.5,
  trailR: number = 1.0,
): {
  pos: typeof pos;
  exitReason: 'tp' | 'sl' | 'time' | 'partial' | null;
  exitPrice: number | null;
  liveR: number;
} {
  const dir = pos.side === 'long' ? 1 : -1;
  const liveR = (currentPrice - pos.entryPrice) * dir / Math.max(1e-9, pos.riskUnit);

  let exitReason: 'tp' | 'sl' | 'time' | 'partial' | null = null;
  let exitPrice: number | null = null;

  // Check stop loss first (conservative)
  if (pos.side === 'long') {
    if (currentPrice <= pos.stopLoss) {
      exitReason = 'sl';
      exitPrice = pos.stopLoss;
    } else if (currentPrice >= pos.takeProfit) {
      exitReason = 'tp';
      exitPrice = pos.takeProfit;
    }
  } else {
    if (currentPrice >= pos.stopLoss) {
      exitReason = 'sl';
      exitPrice = pos.stopLoss;
    } else if (currentPrice <= pos.takeProfit) {
      exitReason = 'tp';
      exitPrice = pos.takeProfit;
    }
  }

  // Time stop
  if (!exitReason && pos.barsHeld >= maxHoldBars) {
    exitReason = 'time';
    exitPrice = currentPrice;
  }

  // Exit ladder: breakeven at +1R
  if (!exitReason && liveR >= trailR) {
    const be = pos.side === 'long' ? Math.max(pos.stopLoss, pos.entryPrice) : Math.min(pos.stopLoss, pos.entryPrice);
    pos.stopLoss = pos.side === 'long' ? Math.max(pos.stopLoss, be) : Math.min(pos.stopLoss, be);
    // Trailing ATR
    if (currentATR > 0) {
      const trail = (currentPrice - trailR * currentATR) as number;
      const trailShort = (currentPrice + trailR * currentATR) as number;
      pos.stopLoss = pos.side === 'long'
        ? Math.max(pos.stopLoss, trail)
        : Math.min(pos.stopLoss, trailShort);
    }
  }

  // Partial exit at +1.5R
  if (!exitReason && liveR >= partialR && !pos.tookPartial && pos.qty > 0) {
    exitReason = 'partial';
    exitPrice = currentPrice;
    pos.tookPartial = true;
    pos.qty = pos.qty / 2;
    pos.stopLoss = pos.side === 'long' ? Math.max(pos.stopLoss, pos.entryPrice) : Math.min(pos.stopLoss, pos.entryPrice);
  }

  pos.barsHeld += 1;

  return { pos, exitReason, exitPrice, liveR };
}

/**
 * Calculate position size using risk-based formula.
 */
export function calculatePositionSize(
  account: number,
  riskPerTrade: number,
  stopDist: number,
  entryPrice: number,
): { qty: number; notional: number; riskDollar: number } {
  const riskAmount = account * riskPerTrade;
  const qty = riskAmount / stopDist;
  const notional = qty * entryPrice;
  return { qty, notional, riskDollar: riskAmount };
}

/**
 * Check correlation guardrail: reject if |corr| ≥ 0.8 with open position same direction.
 * This is a placeholder — actual correlation computed in backtest engine.
 */
export function checkCorrelationGuardrail(
  openPositions: Array<{ side: 'long' | 'short' }>,
  candidateSide: 'long' | 'short',
  correlation: number,
): boolean {
  if (Math.abs(correlation) < 0.8) return true; // pass
  const sameDir = openPositions.some((p) => p.side === candidateSide);
  return !sameDir; // reject if same direction and high correlation
}
