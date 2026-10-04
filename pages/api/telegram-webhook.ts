import type { NextApiRequest, NextApiResponse } from 'next';
import { getLastScan } from './scans';
import { sendTelegramMessage, telegramEnv } from '../../lib/serverTelegram';
import { buildSectorHeat } from '../../lib/algorithms/narrativeHeat';
import { buildTradeableList } from '../../lib/algorithms/tradeable';

/**
 * Incoming Telegram webhook — makes the bot conversational.
 *
 * Setup (once, after deploy):
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain>/api/telegram-webhook
 * Check:
 *   https://api.telegram.org/bot<TOKEN>/getWebhookInfo
 *
 * Security: only the configured TELEGRAM_CHAT_ID is answered. Anyone else
 * gets silence — replying "unauthorized" would confirm the bot to strangers.
 *
 * Commands (all reads come from the last persisted scan in Supabase):
 *   /start | /help  → command list
 *   /status         → regime + scan age + early/confirmed sectors
 *   /top            → top 5 tradeable coins
 *   /watch          → watchlist near-misses
 */

interface TgMessage {
  message_id: number;
  chat?: { id?: number | string; type?: string };
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const HELP = [
  'Perintah yang tersedia:',
  '/status — ringkasan scan terakhir + sektor early',
  '/top — 5 koin paling tradeable',
  '/watch — koin yang dipantau (tren ada, pemicu belum)',
  '/help — pesan ini',
].join('\n');

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} dtk lalu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} jam lalu`;
  return `${Math.floor(h / 24)} hari lalu`;
}

async function handleStatus(): Promise<string> {
  let scan;
  try {
    scan = await getLastScan('BTCUSDT');
  } catch {
    return 'Gagal membaca scan terakhir — Supabase tidak terjangkau.';
  }
  if (!scan.configured) return 'Supabase belum dikonfigurasi di server.';
  if (!scan.found || !scan.rankings?.length) {
    return 'Belum ada scan tersimpan. Jalankan scan dari web dulu.';
  }

  const sectors = buildSectorHeat(scan.rankings);
  const early = sectors.filter((s) => s.phase === 'early' && s.members > 0);
  const confirmed = sectors.filter((s) => s.phase === 'confirmed' && s.members > 0);
  const buys = scan.rankings.filter((r) => r.finalSignal.includes('buy')).length;
  const sells = scan.rankings.filter((r) => r.finalSignal.includes('sell')).length;

  const lines = [
    `Status scan ${timeAgo(scan.scannedAt ?? Date.now())} (${scan.rankings.length} koin)`,
    `Regime: ${(scan.regimeLabel ?? scan.regime?.regime ?? '—').replace(/_/g, ' ')} · ${buys} buy / ${sells} sell`,
    '',
  ];
  if (early.length > 0) {
    lines.push('Mulai naik:');
    for (const s of early.slice(0, 3)) {
      lines.push(`- ${s.icon} ${s.label} (early ${s.earlyScore}, ${s.buyCount} buy) — ${s.leaders.join(', ') || '—'}`);
    }
  } else {
    lines.push('Tidak ada sektor di fase early saat ini.');
  }
  if (confirmed.length > 0) {
    lines.push(`Terkonfirmasi: ${confirmed.slice(0, 3).map((s) => s.label).join(', ')}`);
  }
  return lines.join('\n');
}

async function handleTop(): Promise<string> {
  let scan;
  try {
    scan = await getLastScan('BTCUSDT');
  } catch {
    return 'Gagal membaca scan terakhir — Supabase tidak terjangkau.';
  }
  if (!scan.configured) return 'Supabase belum dikonfigurasi di server.';
  if (!scan.found || !scan.rankings?.length) {
    return 'Belum ada scan tersimpan. Jalankan scan dari web dulu.';
  }
  const { trades } = buildTradeableList(scan.rankings, {});
  if (trades.length === 0) return 'Tidak ada koin yang lolos gate tradeable saat ini.';
  const lines = ['Top tradeable:'];
  for (const t of trades.slice(0, 5)) {
    const arrow = t.direction === 'long' ? 'LONG' : 'SHORT';
    lines.push(
      `- ${t.ticker} ${arrow} · conf ${t.confluenceScore} · risiko ${t.riskTier} · budget <=${t.riskBudgetPct}%`
    );
  }
  return lines.join('\n');
}

async function handleWatch(): Promise<string> {
  let scan;
  try {
    scan = await getLastScan('BTCUSDT');
  } catch {
    return 'Gagal membaca scan terakhir — Supabase tidak terjangkau.';
  }
  if (!scan.configured) return 'Supabase belum dikonfigurasi di server.';
  if (!scan.found || !scan.rankings?.length) {
    return 'Belum ada scan tersimpan. Jalankan scan dari web dulu.';
  }
  const { watchlist } = buildTradeableList(scan.rankings, {});
  if (watchlist.length === 0) return 'Watchlist kosong — tidak ada tren tanpa pemicu saat ini.';
  const lines = ['Dipantau:'];
  for (const w of watchlist.slice(0, 8)) {
    lines.push(`- ${w.ticker} (bias +${Math.round(w.netBias * 100)}%, conf ${w.confluenceScore})`);
  }
  return lines.join('\n');
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    // Health check for the operator (browser), not for Telegram.
    return res.status(200).json({ ok: true, usage: 'Telegram POSTs updates here; set via setWebhook' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Always 200 quickly — Telegram retries anything else, which would
  // double-answer. All real failures are logged, not returned.
  try {
    const { configured, chatId } = telegramEnv();
    if (!configured) {
      return res.status(200).json({ ok: false, reason: 'telegram not configured' });
    }

    const update = req.body as TgUpdate;
    const msg = update?.message;
    const fromChat = msg?.chat?.id != null ? String(msg.chat.id) : '';
    const text = (msg?.text || '').trim();

    // Not our owner, or not a text message → silence.
    if (!fromChat || fromChat !== String(chatId) || !text) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');

    let reply: string;
    if (cmd === '/status') reply = await handleStatus();
    else if (cmd === '/top') reply = await handleTop();
    else if (cmd === '/watch') reply = await handleWatch();
    else reply = HELP; // /start, /help, and anything unknown

    await sendTelegramMessage(reply, fromChat);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('telegram-webhook:', err instanceof Error ? err.message : err);
    return res.status(200).json({ ok: false });
  }
}
