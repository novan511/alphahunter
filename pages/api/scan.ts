import type { NextApiRequest, NextApiResponse } from 'next';
import { Candle, AssetScanResult, ScanConfig } from '../../lib/types';
import { fetchBinanceKlines } from '../../lib/api';
import { detectDecoupling } from '../../lib/algorithms/decouplingDetector';
import { calculateRSData } from '../../lib/algorithms/relativeStrength';
import { sma } from '../../lib/algorithms/indicators';
import { getFreshLatestSignal, DEFAULT_MAX_SIGNAL_AGE_BARS } from '../../lib/algorithms/signalFreshness';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<AssetScanResult[] | { error: string }>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    indexSymbol = 'BTCUSDT',
    assets,
    interval = '4h',
    limit = '200',
    lookback = '6',
    rsPeriod = '20',
    indexThreshold = '0.02',
    volumeMultiplier = '1.5',
    volumePeriod = '20',
  } = req.query;

  const assetList = typeof assets === 'string'
    ? assets.split(',').map((s) => s.trim().toUpperCase())
    : Array.isArray(assets)
    ? assets.map((s) => s.toUpperCase())
    : ['ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT'];

  const config: ScanConfig = {
    indexSymbol: (indexSymbol as string).toUpperCase(),
    assetSymbols: assetList,
    interval: interval as string,
    lookback: parseInt(lookback as string, 10),
    rsPeriod: parseInt(rsPeriod as string, 10),
    indexThreshold: parseFloat(indexThreshold as string),
    volumeMultiplier: parseFloat(volumeMultiplier as string),
    volumePeriod: parseInt(volumePeriod as string, 10),
  };

  try {
    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 200, 100), 1000);

    const indexCandles = await fetchBinanceKlines(config.indexSymbol, config.interval, parsedLimit);

    const results: AssetScanResult[] = [];

    const assetChunks: string[][] = [];
    for (let i = 0; i < assetList.length; i += 5) {
      assetChunks.push(assetList.slice(i, i + 5));
    }

    for (const chunk of assetChunks) {
      const fetchPromises = chunk.map(async (symbol) => {
        try {
          const assetCandles = await fetchBinanceKlines(symbol, config.interval, parsedLimit);

          const minLength = Math.min(assetCandles.length, indexCandles.length);
          const trimmedAsset = assetCandles.slice(-minLength);
          const trimmedIndex = indexCandles.slice(-minLength);

          const signals = detectDecoupling(trimmedAsset, trimmedIndex, config);

          const rsData = calculateRSData(trimmedAsset, trimmedIndex, config.rsPeriod);
          const lastRS = rsData[rsData.length - 1];

          const lookbackReturns = trimmedAsset.map((c, i) => {
            if (i < config.lookback) return 0;
            return (c.close - trimmedAsset[i - config.lookback].close) / trimmedAsset[i - config.lookback].close;
          });

          const indexReturns = trimmedIndex.map((c, i) => {
            if (i < config.lookback) return 0;
            return (c.close - trimmedIndex[i - config.lookback].close) / trimmedIndex[i - config.lookback].close;
          });

          const volumes = trimmedAsset.map((c) => c.volume);
          const volMA = sma(volumes, config.volumePeriod);
          const lastVolMA = volMA[volMA.length - 1];
          const lastVol = trimmedAsset[trimmedAsset.length - 1].volume;

          const { signal: latestSignal } = getFreshLatestSignal(
            signals,
            trimmedAsset,
            config.interval,
            DEFAULT_MAX_SIGNAL_AGE_BARS
          );

          return {
            symbol,
            currentRSZScore: Math.round(lastRS.rsZScore * 100) / 100,
            rsMomentum: Math.round(lastRS.rsMomentum * 10000) / 10000,
            assetReturn: Math.round(lookbackReturns[lookbackReturns.length - 1] * 10000) / 100,
            indexReturn: Math.round(indexReturns[indexReturns.length - 1] * 10000) / 100,
            volumeRatio: lastVolMA > 0 ? Math.round((lastVol / lastVolMA) * 100) / 100 : 0,
            signal: latestSignal,
            rank: 0,
          } as AssetScanResult;
        } catch (err) {
          console.error(`Error scanning ${symbol}:`, err);
          return null;
        }
      });

      const chunkResults = await Promise.all(fetchPromises);
      results.push(...(chunkResults.filter((r): r is AssetScanResult => r !== null)));
    }

    results.sort((a, b) => {
      const scoreA = a.currentRSZScore * 0.4 + a.rsMomentum * 100 * 0.3 + a.volumeRatio * 0.3;
      const scoreB = b.currentRSZScore * 0.4 + b.rsMomentum * 100 * 0.3 + b.volumeRatio * 0.3;
      return scoreB - scoreA;
    });

    results.forEach((r, i) => {
      r.rank = i + 1;
    });

    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json({
      error: `Scan failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }
}