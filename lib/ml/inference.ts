/**
 * XGBoost JSON model inference in pure TypeScript.
 * Traverses boosted tree ensemble: each tree outputs a leaf value, summed across trees,
 * plus base_score. No Python runtime, no npm ML deps.
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

export interface PredictionResult {
  value: number; // raw model output (log-return estimate)
  probabilityUp: number; // P(return > 0) in [0,1]
  confidence: number; // distance from 0.5 in [0,0.5]
  source: 'model' | 'fallback';
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
 * Predict using an XGBoost JSON model.
 * Falls back to neutral (0.5 probability) if model is missing or invalid.
 */
export function predict(
  model: XGBoostModel | null,
  features: number[],
): PredictionResult {
  if (!model) {
    return { value: 0, probabilityUp: 0.5, confidence: 0, source: 'fallback' };
  }

  let raw = model.base_score;
  for (const tree of model.trees) {
    raw += traverseTree(tree, features);
  }

  // Calibrate probability from raw log-return estimate.
  // Empirical: scale raw by 100 (typical log-return magnitude for 4h crypto)
  // then sigmoid. This is a placeholder; production should use Platt scaling
  // or isotonic regression fitted on validation data.
  const scaled = raw * 100;
  const probabilityUp = sigmoid(scaled);
  const confidence = Math.abs(probabilityUp - 0.5);

  return {
    value: raw,
    probabilityUp,
    confidence,
    source: 'model',
  };
}
