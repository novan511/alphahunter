import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';

interface ModelInfo {
  symbol: string;
  interval: string;
  asset_class: 'crypto' | 'commodity' | 'index' | 'forex' | 'equity' | 'other';
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
  gates_passed?: boolean;
  oos_metrics?: any;
  file_exists: boolean;
}

const CRYPTO_SYMBOLS = new Set([
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','LINKUSDT',
  'DOGEUSDT','MATICUSDT','DOTUSDT','LTCUSDT','BCHUSDT','ETCUSDT','FILUSDT','TRXUSDT',
]);

const COMMODITY_SYMBOLS = new Set([
  'GC=F','SI=F','CL=F','BZ=F','NG=F','PA=F','PL=F','HG=F','ZC=F','ZW=F','ZS=F',
  'KC=F','SB=F','CT=F','LB=F','HO=F','RB=F',
]);

const INDEX_SYMBOLS = new Set([
  '^GSPC','^IXIC','^DJI','^RUT','^VIX','^FTSE','^GDAXI','^FCHI','^N225','^HSI',
  '^BSESN','^KS11','^AXJO','^GSPTSE',
]);

const FOREX_SYMBOLS = new Set([
  'EURUSD=X','GBPUSD=X','USDJPY=X','USDCHF=X','USDCAD=X','AUDUSD=X','NZDUSD=X',
  'EURJPY=X','EURGBP=X','GBPJPY=X','XAUUSD=X','XAGUSD=X',
]);

function classifyAsset(symbol: string): ModelInfo['asset_class'] {
  const s = symbol.toUpperCase();
  if (CRYPTO_SYMBOLS.has(s)) return 'crypto';
  if (COMMODITY_SYMBOLS.has(s)) return 'commodity';
  if (INDEX_SYMBOLS.has(s)) return 'index';
  if (FOREX_SYMBOLS.has(s)) return 'forex';
  if (s.endsWith('=F') || s.endsWith('=X')) return 'commodity';
  if (s.startsWith('^')) return 'index';
  if (s.length <= 5 && /^[A-Z]{1,5}$/.test(s)) return 'equity';
  return 'other';
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ModelInfo[] | { error: string }>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const modelDir = path.join(process.cwd(), 'ml/models');
  const publicDir = path.join(process.cwd(), 'public', 'ml', 'models');
  const positiveOnly = req.query.positive_only === 'true';

  // Scan ml/models/ for all .meta.json files
  let modelFiles: string[] = [];
  try {
    modelFiles = fs.readdirSync(modelDir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    // directory may not exist
  }

  const results: ModelInfo[] = [];

  for (const file of modelFiles) {
    const baseName = file.replace('.meta.json', '');
    const parts = baseName.split('_');
    const interval = parts[parts.length - 1];
    const symbol = parts.slice(0, -1).join('_');

    const srcExists = fs.existsSync(path.join(modelDir, `${baseName}.json`));
    const pubExists = fs.existsSync(path.join(publicDir, `${baseName}.meta.json`));

    let meta: any = null;
    const metaPath = pubExists
      ? path.join(publicDir, `${baseName}.meta.json`)
      : srcExists
      ? path.join(modelDir, `${baseName}.meta.json`)
      : null;

    if (metaPath) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch {
        meta = null;
      }
    }

    const expectancy = meta?.oos_metrics?.oos_expectancy_r;

    // Filter: only positive expectancy models
    if (positiveOnly && (!expectancy || expectancy <= 0)) {
      continue;
    }

    results.push({
      symbol: symbol,
      interval: interval,
      asset_class: classifyAsset(symbol),
      trained_at: meta?.trained_at,
      forward_bars: meta?.forward_bars,
      task_type: meta?.task_type,
      regime_filter: meta?.regime_filter,
      prob_threshold: meta?.prob_threshold,
      leverage: meta?.leverage,
      allow_short: meta?.allow_short,
      rr_ratio: meta?.rr_ratio,
      risk_per_trade: meta?.risk_per_trade,
      stop_loss_atr: meta?.stop_loss_atr,
      take_profit_atr: meta?.take_profit_atr,
      gates_passed: meta?.gates_passed,
      oos_metrics: meta?.oos_metrics,
      file_exists: srcExists && pubExists,
    });
  }

  // Sort: trained models first, then by expectancy desc (best first), then trained_at desc
  results.sort((a, b) => {
    if (b.file_exists !== a.file_exists) return b.file_exists ? 1 : -1;
    const aExp = a.oos_metrics?.oos_expectancy_r ?? -999;
    const bExp = b.oos_metrics?.oos_expectancy_r ?? -999;
    if (bExp !== aExp) return bExp - aExp;
    if (!a.trained_at || !b.trained_at) return 0;
    return new Date(b.trained_at).getTime() - new Date(a.trained_at).getTime();
  });

  return res.status(200).json(results);
}
