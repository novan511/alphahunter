import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle, ScanConfig } from '../../lib/types';
import { ALL_ASSET_SYMBOLS, ASSET_UNIVERSE } from '../../lib/config';
import { fetchBinanceKlines, sleep } from '../../lib/api';
import { detectDecoupling } from '../../lib/algorithms/decouplingDetector';
import { calculateRSData } from '../../lib/algorithms/relativeStrength';
import { detectMarketRegime, RegimeResult } from '../../lib/algorithms/marketRegime';
import { computeAutonomousParams, AutonomousParams } from '../../lib/algorithms/autonomousParams';
import { analyzeMultiTimeframe, MultiTimeframeResult } from '../../lib/algorithms/multiTimeframe';

async function fetchMultipleSymbols(
  symbols: string[],
  interval: string,
  limit: number,
  batchSize: number = 3
): Promise<{ [symbol: string]: Candle[] }> {
  const results: { [symbol: string]: Candle[] } = {};

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);

    const batchResults = await Promise.allSettled(
      batch.map(async (sym) => {
        const data = await fetchBinanceKlines(sym, interval, limit);
        return { symbol: sym, data };
      })
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results[r.value.symbol] = r.value.data;
      }
    }

    if (i + batchSize < symbols.length) {
      await sleep(200);
    }
  }

  return results;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{
    regime: RegimeResult;
    autonomousParams: AutonomousParams;
    rankings: MultiTimeframeResult[];
    totalScanned: number;
    signalsFound: number;
  } | { error: string }>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    indexSymbol = 'BTCUSDT',
    categories,
    limit = '200',
  } = req.query;

  const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 200, 100), 500);

  try {
    let symbolsToScan: string[];
    if (categories && typeof categories === 'string' && categories !== 'all') {
      const cats = categories.split(',').map((c) => c.trim().toLowerCase());
      const matchedCats = ASSET_UNIVERSE.filter((cat) =>
        cats.includes(cat.name.toLowerCase())
      );
      symbolsToScan = Array.from(new Set(matchedCats.flatMap((c) => c.symbols)));
    } else {
      symbolsToScan = [...ALL_ASSET_SYMBOLS];
    }

    const indexSymbolClean = (indexSymbol as string).toUpperCase();

    const timeframes = ['1h', '4h', '1d'];
    const tfData: { [tf: string]: { index: Candle[]; assets: { [sym: string]: Candle[] } } } = {};

    for (const tf of timeframes) {
      try {
        const indexData = await fetchBinanceKlines(indexSymbolClean, tf, parsedLimit);
        const assetData = await fetchMultipleSymbols(symbolsToScan, tf, parsedLimit, 3);
        tfData[tf] = { index: indexData, assets: assetData };
      } catch (err) {
        console.error(`Failed to fetch data for timeframe ${tf}:`, err);
        tfData[tf] = { index: [], assets: {} };
      }
    }

    const regimeIndexData = tfData['4h']?.index || tfData['1h']?.index || [];
    const regime = detectMarketRegime(regimeIndexData, 20);

    const autonomousParams = computeAutonomousParams(
      regime.regime,
      regime.confidence,
      regime.atrPercent,
      regime.volatilityPercentile
    );

    const scanConfig: ScanConfig = {
      indexSymbol: indexSymbolClean,
      assetSymbols: symbolsToScan,
      interval: '4h',
      lookback: autonomousParams.lookback,
      rsPeriod: autonomousParams.rsPeriod,
      indexThreshold: autonomousParams.indexThreshold,
      volumeMultiplier: autonomousParams.volumeMultiplier,
      volumePeriod: autonomousParams.volumePeriod,
    };

    const rankings: MultiTimeframeResult[] = [];

    for (const symbol of symbolsToScan) {
      const timeframeData: { [tf: string]: { asset: Candle[]; index: Candle[] } } = {};

      for (const tf of timeframes) {
        const tfIndex = tfData[tf]?.index || [];
        const tfAsset = tfData[tf]?.assets?.[symbol] || [];

        if (tfIndex.length > 0 && tfAsset.length > 0) {
          const minLen = Math.min(tfIndex.length, tfAsset.length);
          timeframeData[tf] = {
            asset: tfAsset.slice(-minLen),
            index: tfIndex.slice(-minLen),
          };
        }
      }

      const mtfResult = analyzeMultiTimeframe(symbol, timeframeData, scanConfig);
      rankings.push(mtfResult);
    }

    rankings.sort((a, b) => b.confluenceScore - a.confluenceScore);

    const signalsFound = rankings.filter((r) => r.finalSignal !== 'neutral').length;

    return res.status(200).json({
      regime,
      autonomousParams,
      rankings,
      totalScanned: symbolsToScan.length,
      signalsFound,
    });
  } catch (err) {
    return res.status(500).json({
      error: `Autonomous scan failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }
}