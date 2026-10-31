/**
 * XGBoost JSON model inference in pure TypeScript.
 * Traverses boosted tree ensemble: each tree outputs a leaf value, summed across trees,
 * plus base_score. No Python runtime, no npm ML deps.
 *
 * Supports probability threshold and regime filter (BTC bull) for signal gating.
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
}

export interface MlMeta {
  symbol?: string;
  interval?: string;
  trained_at?: string;
  forward_bars?: number;
  regime_filter?: string;
  prob_threshold?: number;
  feature_cols?: string[];
  feature_importance?: Record<string, number>;
  oos_metrics?: any;
  gates_passed?: boolean;
  model_type?: string;
  base_score?: number;
}

export interface PredictionResult {
  value: number; // raw model output (log-return estimate)
  probabilityUp: number; // P(return > 0) in [0,1]
  confidence: number; // distance from 0.5 in [0,0.5]
  signal: 'long' | 'flat'; // 'long' if prob > threshold AND regime passes
  regimePass: boolean; // whether BTC bull filter passed
  source: 'model' | 'fallback';
  meta?: MlMeta;
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
 * Predict using an XGBoost JSON model with regime filter and probability threshold.
 * Falls back to neutral (0.5 probability) if model is missing or invalid.
 */
export function predict(
  model: XGBoostModel | null,
  meta: MlMeta | null,
  features: number[],
  btcBullFilter: number = 1,
): PredictionResult {
  const probThreshold = meta?.prob_threshold ?? 0.55;
  const regimeFilter = meta?.regime_filter ?? 'none';

  if (!model) {
    return {
      value: 0,
      probabilityUp: 0.5,
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

  // Calibrate probability from raw log-return estimate
  const scaled = raw * 100;
  const probabilityUp = sigmoid(scaled);
  const confidence = Math.abs(probabilityUp - 0.5);

  // Regime filter: check BTC bull filter
  // Feature index 7 = btc_bull_filter in our feature vector
  const btcBullFeature = features.length > 7 ? features[7] : 1;
  const regimePass =
    regimeFilter === 'none' ||
    (regimeFilter === 'bull_only' && (btcBullFeature === 1 || btcBullFilter === 1)) ||
    (regimeFilter === 'bear_only' && (btcBullFeature === 0 || btcBullFilter === 0));

  // Signal: long only if prob > threshold AND regime passes
  const signal = probabilityUp > probThreshold && regimePass ? 'long' : 'flat';

  return {
    value: raw,
    probabilityUp,
    confidence,
    signal,
    regimePass,
    source: 'model',
    meta,
  };
}
