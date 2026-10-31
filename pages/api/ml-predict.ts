import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle } from '../../lib/types';
import { fetchKlinesRouted } from '../../lib/universe';
import { buildFeatures } from '../../lib/ml/features';
import { loadModelFromJSON, loadMetaFromJSON, predict } from '../../lib/ml/inference';
import { atr } from '../../lib/algorithms/indicators';
import fs from 'fs';
import path from 'path';

interface MLPredictResponse {
  symbol: string;
  interval: string;
  prediction: number;
  probabilityUp: number;
  probabilityDown: number;
  confidence: number;
  signal: 'long' | 'short' | 'flat';
  regimePass: boolean;
  source: 'model' | 'fallback';
  leverage?: number;
  allowShort?: boolean;
  rrRatio?: number;
  riskPerTrade?: number;
  stopLossATR?: number;
  takeProfitATR?: number;
  modelVersion?: string;
  featuresUsed: string[];
  forwardBars?: number;
  probThreshold?: number;
  regimeFilter?: string;
  latestClose?: number;
  atrPct?: number;
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

function loadMetaFile(symbol: string, interval: string): any | null {
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
  'btc_regime_60',
  'btc_bull_filter',
  'mom_5',
  'mom_20',
  'mom_60',
  'close_over_sma20',
  'rs_over_rs_ma',
  'atr_regime',
];

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<MLPredictResponse>,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      error: 'Method not allowed',
      symbol: '',
      interval: '',
      prediction: 0,
      probabilityUp: 0.5,
      probabilityDown: 0.5,
      confidence: 0,
      signal: 'flat',
      regimePass: true,
      source: 'fallback',
      featuresUsed: FEATURE_NAMES,
      timestamp: Date.now(),
    } as any);
  }

  const { symbol = 'SOLUSDT', interval = '4h' } = req.query;
  const sym = (symbol as string).toUpperCase().replace(/USDT$/, '') + 'USDT';
  const iv = interval as string;

  try {
    const [assetCandles, btcCandles] = await Promise.all([
      fetchKlinesRouted(sym, iv, 500),
      fetchKlinesRouted('BTCUSDT', iv, 500),
    ]);

    if (assetCandles.length < 80 || btcCandles.length < 80) {
      return res.status(400).json({
        symbol: sym,
        interval: iv,
        prediction: 0,
        probabilityUp: 0.5,
        probabilityDown: 0.5,
        confidence: 0,
        signal: 'flat',
        regimePass: true,
        source: 'fallback',
        featuresUsed: FEATURE_NAMES,
        timestamp: Date.now(),
        error: 'Insufficient candle data',
      } as any);
    }

    const fv = buildFeatures(assetCandles, btcCandles);
    if (fv.length === 0) {
      return res.status(400).json({
        symbol: sym,
        interval: iv,
        prediction: 0,
        probabilityUp: 0.5,
        probabilityDown: 0.5,
        confidence: 0,
        signal: 'flat',
        regimePass: true,
        source: 'fallback',
        featuresUsed: FEATURE_NAMES,
        timestamp: Date.now(),
        error: 'Feature computation failed',
      } as any);
    }

    const latest = fv[fv.length - 1];

    const closes = assetCandles.map((c) => c.close);
    const latestClose = closes[closes.length - 1];
    const atrSeries = atr(assetCandles, 14);
    const latestATRPct = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1] : 0;
    const atrPct = Number.isFinite(latestATRPct) && latestClose > 0 ? (latestATRPct / latestClose) * 100 : 0;

    const modelObj = loadModelFile(sym, iv);
    const model = modelObj ? loadModelFromJSON(modelObj) : null;
    const metaObj = loadMetaFile(sym, iv);
    const meta = metaObj ? loadMetaFromJSON(metaObj) : null;

    const btcBullFilter = latest.features.length > 7 ? latest.features[7] : 1;

    const result = predict(model, meta, latest.features, btcBullFilter);

    const response: MLPredictResponse = {
      symbol: sym,
      interval: iv,
      prediction: result.value,
      probabilityUp: result.probabilityUp,
      probabilityDown: result.probabilityDown,
      confidence: result.confidence,
      signal: result.signal,
      regimePass: result.regimePass,
      source: result.source,
      leverage: meta?.leverage,
      allowShort: meta?.allow_short,
      rrRatio: meta?.rr_ratio,
      riskPerTrade: meta?.risk_per_trade,
      stopLossATR: meta?.stop_loss_atr,
      takeProfitATR: meta?.take_profit_atr,
      modelVersion: meta?.trained_at,
      featuresUsed: FEATURE_NAMES,
      forwardBars: meta?.forward_bars,
      probThreshold: meta?.prob_threshold,
      regimeFilter: meta?.regime_filter,
      latestClose,
      atrPct,
      timestamp: latest.time * 1000,
    };

    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json({
      symbol: sym,
      interval: iv,
      prediction: 0,
      probabilityUp: 0.5,
      probabilityDown: 0.5,
      confidence: 0,
      signal: 'flat',
      regimePass: true,
      source: 'fallback',
      featuresUsed: FEATURE_NAMES,
      timestamp: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
    } as any);
  }
}
