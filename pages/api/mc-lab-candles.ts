import type { NextApiRequest, NextApiResponse } from 'next';
import { loadLabCandles } from '../../lib/quant/mcLabEngine';
import { isValidAssetId, isValidInterval, type LabInterval } from '../../lib/quant/mcLabSpec';

export const config = { maxDuration: 60 };

/** Candle yang dikembalikan dibatasi supaya SVG chart tetap bisa digambar. */
const MAX_CANDLES = 4000;

/**
 * Candle untuk menggambar chart setup per trade di detail run.
 *
 * GET /api/mc-lab-candles?asset=yahoo:GC=F&interval=1d&from=<detik>&to=<detik>
 *
 * Data dibaca dari cache disk yang sama dengan engine, jadi membuka detail
 * run tidak memicu fetch baru ke Yahoo/Binance kecuali cache sudah
 * kedaluwarsa. Respons ditandai no-store: kalau browser menyimpannya dan
 * me-revalidate dengan 304 ber-body kosong, res.json() di UI meledak dengan
 * "Unexpected end of JSON input".
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');

  const asset = String(req.query.asset || '');
  const interval = String(req.query.interval || '') as LabInterval;
  const from = Number(req.query.from || 0);
  const to = Number(req.query.to || 0);

  if (!isValidAssetId(asset) || !isValidInterval(interval)) {
    return res.status(400).json({ error: 'aset atau timeframe tidak dikenal' });
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= from) {
    return res.status(400).json({ error: 'rentang waktu tidak valid' });
  }

  try {
    const all = await loadLabCandles(asset, interval);
    if (all.length === 0) {
      return res.status(502).json({ error: `data harga ${asset} kosong` });
    }

    // Pad berbasis jumlah BAR, bukan hari: pad tetap 60 hari akan membanjiri
    // chart intraday dengan 1.400 candle kosong di kiri.
    let start = 0;
    while (start < all.length && all[start].time < from) start++;
    let end = all.length - 1;
    while (end >= 0 && all[end].time > to) end--;
    start = Math.max(0, start - 30);
    end = Math.min(all.length - 1, end + 5);
    if (end < start) {
      return res.status(502).json({ error: 'tidak ada candle pada rentang trade ini' });
    }
    if (end - start + 1 > MAX_CANDLES) start = end - MAX_CANDLES + 1;

    const bars = all.slice(start, end + 1);
    return res.status(200).json({
      ok: true,
      asset,
      interval,
      count: bars.length,
      candles: bars.map((c) => ({
        t: c.time,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
      })),
    });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : `gagal memuat candle ${asset}`,
    });
  }
}
