import { fetchGateCandles } from './marketData';
import { fetchBinanceKlines } from './api';

/**
 * Pemeriksaan kesehatan lapisan data.
 *
 * Kerusakan di lapisan ini terbukti SENYAP berbulan-bulan: Gate pernah
 * menolak semua permintaan dengan 400, parser Gate pernah menghasilkan
 * candle bertanggal 1970, dan service key ditolak selama sweeps melapor
 * ok:true. Jumlah candle yang benar tidak cukup — stempel waktunya harus
 * segar, karena itulah yang membedakan data hidup dari data sampah.
 */

export function assertFresh(candles: { time: number }[]): string {
  if (candles.length === 0) throw new Error('0 candle');
  const last = candles[candles.length - 1].time;
  const ageDays = (Date.now() / 1000 - last) / 86_400;
  if (last < 1_200_000_000) {
    throw new Error(`stempel waktu tidak masuk akal: ${new Date(last * 1000).toISOString()}`);
  }
  if (ageDays > 2) {
    throw new Error(`candle terakhir ${ageDays.toFixed(0)} hari lalu — sumber kemungkinan basi`);
  }
  return `${candles.length} candle, terakhir ${new Date(last * 1000).toISOString()}`;
}

export interface DataHealth {
  ok: boolean;
  binance: string;
  gate: string;
}

/** Satu bar kecil per sumber: candle terakhir harus segar. */
export async function checkDataSources(): Promise<DataHealth> {
  const read = async (label: string, fn: () => Promise<{ time: number }[]>): Promise<string> => {
    try {
      return `ok: ${await assertFresh(await fn())}`;
    } catch (e) {
      return `BASI: ${e instanceof Error ? e.message : e}`;
    }
  };
  const [binance, gate] = await Promise.all([
    read('binance', () => fetchBinanceKlines('BTCUSDT', '1h', 3)),
    read('gate', () => fetchGateCandles('BTC_USDT', '1h', 3)),
  ]);
  return { ok: binance.startsWith('ok') && gate.startsWith('ok'), binance, gate };
}
