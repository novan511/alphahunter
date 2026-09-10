import { AssetRef, parseAssetList } from '../marketData';
import { ASSET_PRESETS, getPresetById } from '../marketData/presets';
import { fetchAssetCandles } from '../marketData';
import { generateQuantSignals } from './signals';
import { DEFAULT_QUANT_RISK } from './risk';
import { QuantAssetData } from './types';
import { Candle } from '../types';

export interface ResolvedUniverse {
  assets: AssetRef[];
  benchmark: AssetRef | null;
  interval: string;
  presetId: string | null;
}

type QueryLike = Partial<{ [key: string]: string | string[] | undefined }>;

export function resolveUniverseFromQuery(query: QueryLike): ResolvedUniverse {
  const get = (key: string): string | undefined => {
    const v = query[key];
    return Array.isArray(v) ? v[0] : v;
  };

  const presetId = get('preset') || '';
  const preset = presetId ? getPresetById(presetId) : undefined;
  const symbolsRaw = get('symbols') || '';
  const assets = parseAssetList(symbolsRaw, preset?.assets ?? ASSET_PRESETS[0].assets);

  const benchmarkRaw = get('benchmark') || '';
  const benchmarkId = benchmarkRaw || preset?.benchmarkId || '';
  let benchmark: AssetRef | null = null;
  if (benchmarkId) {
    benchmark =
      assets.find((a) => a.id === benchmarkId) ||
      parseAssetList(benchmarkId, [])[0] ||
      null;
  }
  if (!benchmark) {
    benchmark =
      assets.find((a) => a.symbol.includes('BTC')) ||
      assets.find((a) => a.symbol.includes('GC')) ||
      assets[0] ||
      null;
  }

  const interval =
    get('interval') ||
    preset?.preferredInterval ||
    DEFAULT_QUANT_RISK.interval;

  return {
    assets,
    benchmark,
    interval,
    presetId: preset?.id ?? null,
  };
}

export async function loadQuantUniverse(
  assets: AssetRef[],
  benchmark: AssetRef | null,
  interval: string,
  limit: number,
  deep: boolean = false
): Promise<{ assets: QuantAssetData[]; benchmarkCandles: Candle[] | null; errors: string[] }> {
  const errors: string[] = [];
  let benchmarkCandles: Candle[] | null = null;
  const fetchOpts = { deep: deep || limit > 800 };

  if (benchmark) {
    try {
      benchmarkCandles = await fetchAssetCandles(benchmark, interval, limit, fetchOpts);
    } catch (err) {
      errors.push(`benchmark ${benchmark.id}: ${err instanceof Error ? err.message : 'fail'}`);
    }
  }

  const loaded: QuantAssetData[] = [];
  for (let i = 0; i < assets.length; i += 2) {
    const batch = assets.slice(i, i + 2);
    const results = await Promise.allSettled(
      batch.map(async (asset) => {
        const candles = await fetchAssetCandles(asset, interval, limit, fetchOpts);
        const signals = generateQuantSignals(asset, candles, benchmark, benchmarkCandles, interval);
        return { symbol: asset.id, candles, signals };
      })
    );
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        loaded.push(r.value);
      } else {
        errors.push(
          `${batch[idx]?.id ?? 'asset'}: ${r.reason instanceof Error ? r.reason.message : 'fetch failed'}`
        );
      }
    });
  }

  return { assets: loaded, benchmarkCandles, errors };
}

export function listPresets() {
  return ASSET_PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    preferredInterval: p.preferredInterval,
    benchmarkId: p.benchmarkId,
    assets: p.assets.map((a) => ({
      id: a.id,
      symbol: a.symbol,
      source: a.source,
      label: a.label,
      klass: a.klass,
    })),
  }));
}
