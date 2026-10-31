import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle } from '../../lib/types';
import { fetchKlinesRouted } from '../../lib/universe';
import { buildFeatures } from '../../lib/ml/features';
import { loadModelFromJSON, predict } from '../../lib/ml/inference';
import fs from 'fs';
import path from 'path';

interface MLPredictResponse {
  symbol: string;
  interval: string;
  prediction: number;
  probabilityUp: number;
  confidence: number;
  source: 'model' | 'fallback';
  modelVersion?: string;
  featuresUsed: string[];
  timestamp: number;
  error?: string;
}

const MODEL_DIR = path.join(process.cwd(), 'ml/models');

function loadModelFile(symbol: string, interval: string): any | null {
  try {
    const filePath = path.join(MODEL_DIR, `${symbol}_${interval}.json`);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadMetaFile(symbol: string, interval: string): { trained_at?: string; oos_metrics?: any } | null {
  try {
    const filePath = path.join(MODEL_DIR, `${symbol}_${interval}.meta.json`);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const FEATURE_NAMES = [
  'rs_zscore',
  'rs_momentum',
  'asset_return_6',
  'volume_ratio',
  'atr_pct',
  'btc_regime_20',
  'mom_5',
  'mom_20',
  'mom_60',
  'close_over_sma20',
];

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<MLPredictResponse>,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed', symbol: '', interval: '', prediction: 0, probabilityUp: 0.5, confidence: 0, source: 'fallback', featuresUsed: [], timestamp: Date.now() } as any);
  }

  const { symbol = 'ETHUSDT', interval = '4h', limit = '500' } = req.query;
  const sym = (symbol as string).toUpperCase().replace(/USDT$/, '') + 'USDT';
  const iv = interval as string;
  const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 500, 100), 1000);

  try {
    // Fetch asset candles and BTC benchmark in parallel
    const [assetCandles, btcCandles] = await Promise.all([
      fetchKlinesRouted(sym, iv, parsedLimit),
      fetchKlinesRouted('BTCUSDT', iv, parsedLimit),
    ]);

    if (assetCandles.length < 80 || btcCandles.length < 80) {
      return res.status(400).json({
        symbol: sym,
        interval: iv,
        prediction: 0,
        probabilityUp: 0.5,
        confidence: 0,
        source: 'fallback',
        featuresUsed: FEATURE_NAMES,
        timestamp: Date.now(),
        error: 'Insufficient candle data',
      } as any);
    }

    // Build features (must match Python training exactly)
    const fv = buildFeatures(assetCandles, btcCandles);
    if (fv.length === 0) {
      return res.status(400).json({
        symbol: sym,
        interval: iv,
        prediction: 0,
        probabilityUp: 0.5,
        confidence: 0,
        source: 'fallback',
        featuresUsed: FEATURE_NAMES,
        timestamp: Date.now(),
        error: 'Feature computation failed',
      } as any);
    }

    // Use the most recent feature vector
    const latest = fv[fv.length - 1];

    // Load model
    const modelObj = loadModelFile(sym, iv);
    const model = modelObj ? loadModelFromJSON(modelObj) : null;
    const meta = loadMetaFile(sym, iv);

    // Predict
    const result = predict(model, latest.features);

    const response: MLPredictResponse = {
      symbol: sym,
      interval: iv,
      prediction: result.value,
      probabilityUp: result.probabilityUp,
      confidence: result.confidence,
      source: result.source,
      modelVersion: meta?.trained_at,
      featuresUsed: FEATURE_NAMES,
      timestamp: latest.time * 1000,
    };

    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json({
      symbol: sym,
      interval: iv,
      prediction: 0,
      probabilityUp: 0.5,
      confidence: 0,
      source: 'fallback',
      featuresUsed: FEATURE_NAMES,
      timestamp: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
    } as any);
  }
}
