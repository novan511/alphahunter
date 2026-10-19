/**
 * Futures desk book: the fixed universe, the timeframe menu and every shared
 * type — safe to import from a client component.
 *
 * This file exists only because of a build boundary. `lib/futures.ts` fetches
 * candles, which pulls in `lib/marketData` -> `lib/api` -> `lib/candleCache`
 * -> `fs`. A client component importing that graph fails the page with
 * "Can't resolve 'fs'". So nothing here may import a runtime value from a
 * server module: type-only imports are erased at compile time and are safe,
 * value imports are not.
 */

import type { AssetRef } from './marketData';
import type { Candle } from './types';

export type Verdict = 'long' | 'short' | 'wait';

export type FuturesGroup = 'crypto' | 'commodity' | 'equity';

export interface BookEntry {
  /** Raw asset id, e.g. hyperliquid:xyz:GOLD. Resolved to an AssetRef server-side. */
  rawId: string;
  /** Ticker shown on the card. */
  symbol: string;
  /** Human label, e.g. "Emas". */
  name: string;
  group: FuturesGroup;
}

export interface FuturesInstrument extends BookEntry {
  id: string;
  asset: AssetRef;
}

export interface TimeframeDef {
  tf: string;
  label: string;
  /** Shown next to the picker so the choice is a decision, not a filter. */
  use: string;
  /** Bars fetched for this timeframe. */
  bars: number;
  /** ATR multiples for stop / target. */
  stopAtr: number;
  targetAtr: number;
}

export const FUTURES_TIMEFRAMES: TimeframeDef[] = [
  {
    tf: '5m', label: '5m', bars: 300, stopAtr: 1.2, targetAtr: 1.8,
    use: 'Timing entry. Noise tinggi — jangan dipakai untuk menentukan arah, cuma untuk masuk.',
  },
  {
    tf: '15m', label: '15m', bars: 300, stopAtr: 1.5, targetAtr: 2.2,
    use: 'Eksekusi dan fine-tuning. Confirmasi awal sebelum posisi diteruskan ke 1h.',
  },
  {
    tf: '1h', label: '1h', bars: 300, stopAtr: 1.5, targetAtr: 2.5,
    use: 'Arah trading (primary). Cukup noise untuk swing, cukup cepat untuk tidak telat.',
  },
  {
    tf: '4h', label: '4h', bars: 300, stopAtr: 1.8, targetAtr: 3.0,
    use: 'Arah swing. Ini timeframe yang paling sering align dengan pemangku tren.',
  },
  {
    tf: '1d', label: '1D', bars: 260, stopAtr: 1.8, targetAtr: 3.0,
    use: 'Filter. Mostly dipakai menolak sinyal yang berlawanan dengan tren harian.',
  },
  {
    tf: '1w', label: '1W', bars: 160, stopAtr: 2.0, targetAtr: 3.5,
    use: 'Regime makro. Menentukan retali untuk ukuran posisi, bukan trigger entry.',
  },
];

/**
 * Fixed book. Order is display order: crypto first, then commodities, then
 * equities — matching how the tab is read (risk rises down the list).
 *
 * All of it trades on one venue, so every line is shortable and trades 24/7:
 * crypto perps on the Hyperliquid core dex, gold / silver / oil / US equities
 * as HIP-3 builder perps on its `xyz` dex.
 */
export const FUTURES_BOOK: BookEntry[] = [
  { rawId: 'hyperliquid:BTC', symbol: 'BTC', name: 'Bitcoin', group: 'crypto' },
  { rawId: 'hyperliquid:xyz:GOLD', symbol: 'XAU', name: 'Emas', group: 'commodity' },
  { rawId: 'hyperliquid:xyz:CL', symbol: 'OIL', name: 'Minyak (WTI)', group: 'commodity' },
  { rawId: 'hyperliquid:xyz:SPY', symbol: 'SPY', name: 'S&P 500 ETF', group: 'equity' },
];

export const GROUP_LABEL: Record<FuturesGroup, string> = {
  crypto: 'Crypto Perp',
  commodity: 'Komoditas',
  equity: 'Saham US',
};

/** Display order: risk rises down the list. */
export const GROUP_ORDER: FuturesGroup[] = ['crypto', 'commodity', 'equity'];

export interface MacroSnapshot {
  dxy: number | null;
  dxyChangePct: number | null;
  vix: number | null;
  vixChangePct: number | null;
  us10y: number | null;
  fedFunds: number | null;
  cpiYoY: number | null;
  /** ISO date of the newest FRED observation, per-series joined. */
  asOf: string | null;
  errors: string[];
}

export const EMPTY_MACRO: MacroSnapshot = {
  dxy: null, dxyChangePct: null, vix: null, vixChangePct: null,
  us10y: null, fedFunds: null, cpiYoY: null, asOf: null, errors: [],
};

export interface AlignmentRow {
  tf: string;
  label: string;
  verdict: Verdict;
  score: number;
}

export interface FuturesSignal {
  instrument: FuturesInstrument;
  verdict: Verdict;
  /** 0..100 conviction, higher = more evidence. */
  score: number;
  /** Live price: the last bar including the still-forming one. Score uses closed bars, price does not. */
  price: number;
  /** Close time of the last CLOSED bar the verdict was scored on. Dedupe keys off this, never off price. */
  barTime: number;
  /** Percent change over the last `lookback` bars of this timeframe. */
  changePct: number;
  stop: number;
  target: number;
  atrPct: number;
  reasons: string[];
  macroNote: string;
  candles: Candle[];
  alignment: AlignmentRow[];
  lastSignal: { time: number; price: number; type: 'buy' | 'sell' } | null;
}

export interface FuturesResponse {
  tf: string;
  signals: FuturesSignal[];
  macro: MacroSnapshot;
  fetchedAt: number;
  errors: string[];
  /**
   * Symbols that produced no usable card. Anything downstream that acts on the
   * book (the Telegram push in particular) must refuse to act when this is not
   * empty — a half-loaded book is an inventory of positions nobody can see.
   */
  missing: string[];
  /** True when every book symbol is present. */
  complete: boolean;
}
