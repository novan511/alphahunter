import type { NextApiRequest, NextApiResponse } from 'next';
import {
  history,
  isDue,
  isLabConfigured,
  isTableReady,
  serviceKeyProjectMismatch,
  latestRun,
  nextDueAt,
  runIteration,
  summarizeGroup,
} from '../../lib/quant/mcLabService';
import { LAB_COOLDOWN_MINUTES, LAB_CATALOG } from '../../lib/quant/mcLabSpec';

export const config = { maxDuration: 60 };

/**
 * Laboratorium Monte Carlo otonom.
 *
 * GET  /api/mc-lab            → status + riwayat + ringkasan grup
 * GET  /api/mc-lab?limit=100  → riwayat lebih banyak
 * POST /api/mc-lab { force }  → jalankan satu iterasi (manual / cron)
 *
 * Auth: POST tanpa secret boleh memicu iterasi biasa (cooldown 10 menit di
 * runIteration yang membatasi laju). `force` — melewati cooldown — hanya
 * dengan SCAN_CRON_SECRET, sama seperti route cron lain.
 */
function authorized(req: NextApiRequest): boolean {
  const secret = process.env.SCAN_CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization;
  return Boolean(header && header.startsWith('Bearer ') && header.slice(7) === secret);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Route ini selalu dipoll UI; respons yang di-cache membuat status progres
  // basi dan memicu 304 ber-body kosong yang membuat res.json() meledak.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Service-role yang salah project bukan penghalang: tulisan jatuh ke anon.
  // Ia dikirim sebagai warning agar pengguna tahu key itu tidak terpakai.
  const warning = serviceKeyProjectMismatch();

  if (!isLabConfigured()) {
    return res.status(200).json({
      ok: false,
      configured: false,
      warning,
      reason:
        'Supabase belum dikonfigurasi — set NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY (atau SUPABASE_SERVICE_ROLE_KEY) di .env.local/Vercel',
      cooldownMinutes: LAB_COOLDOWN_MINUTES,
      groups: LAB_CATALOG.map((g) => ({ id: g.id, label: g.label, assets: g.assets })),
    });
  }

  try {
    if (req.method === 'GET') {
      const limit = parseInt(String(req.query.limit || '40'), 10) || 40;
      const ready = await isTableReady();
      if (!ready) {
        return res.status(200).json({
          ok: false,
          configured: false,
          reason:
            'tabel mc_lab_runs belum ada — jalankan supabase/migrations/016_mc_lab_runs.sql di SQL Editor',
          cooldownMinutes: LAB_COOLDOWN_MINUTES,
          groups: LAB_CATALOG.map((g) => ({ id: g.id, label: g.label, assets: g.assets })),
        });
      }
      const [runs, last] = await Promise.all([history(limit), latestRun()]);
      return res.status(200).json({
        ok: true,
        configured: true,
        warning,
        cooldownMinutes: LAB_COOLDOWN_MINUTES,
        latest: last,
        runs,
        due: isDue(last),
        nextDueAt: nextDueAt(last),
        groups: LAB_CATALOG.map((g) => ({
          id: g.id,
          label: g.label,
          assets: g.assets,
          summary: summarizeGroup(runs, g.id),
        })),
      });
    }

    if (!authorized(req)) {
      // Tanpa secret hanya boleh memicu iterasi biasa (bukan force); cooldown
      // 10 menit di runIteration yang membatasi laju, sehingga tombol di UI
      // tetap bisa dipakai tanpa membocorkan SCAN_CRON_SECRET ke browser.
      if (req.body?.force === true || req.query.force === '1') {
        return res.status(401).json({ error: 'force butuh Authorization: Bearer <SCAN_CRON_SECRET>' });
      }
    }

    const force = req.body?.force === true || req.query.force === '1';
    const result = await runIteration({ force, source: 'api' });
    // 429 hanya untuk "terlalu cepat / masih berjalan"; kegagalan konfigurasi
    // bukan alasan untuk memicu retry agresif dari cron.
    const busy = /cooldown|masih berjalan/i.test(result.reason || '');
    return res.status(result.ran ? 200 : busy ? 429 : 200).json({ ok: result.ran, ...result });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'lab gagal',
    });
  }
}
