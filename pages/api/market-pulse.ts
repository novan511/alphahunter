import type { NextApiRequest, NextApiResponse } from 'next';
import { loadFutures, missingSymbols } from '../../lib/futures';
import {
  analysePulse,
  buildPulseSnapshot,
  PulseOutput,
  PulseSnapshot,
} from '../../lib/quant/marketPulse';
import { sendTelegramMessage, telegramEnv } from '../../lib/serverTelegram';
import { FUTURES_TIMEFRAMES } from '../../lib/futuresBook';

export const config = { maxDuration: 60 };

/**
 * Whole-context market pulse.
 *
 * Loads the one futures book (crypto perps + commodities + US equities) that
 * already carries a shared macro snapshot, folds it into a cross-market
 * snapshot, then asks the analyst for ONE synchronised stance across all three
 * markets. Unlike /api/futures-cron (which pushes only verdict CHANGES), this
 * is a periodic whole-picture read.
 *
 * Auth: requires SCAN_CRON_SECRET, same as /api/scan-cron and /api/futures-cron.
 */

interface Body {
  tf?: string;
  /** Set false to compute without sending — for wiring checks. */
  notify?: boolean;
  /** Include the model call result in the response. */
  debug?: boolean;
}

const VALID_TF = new Set(FUTURES_TIMEFRAMES.map((t) => t.tf));

function authorized(req: NextApiRequest): boolean {
  const secret = process.env.SCAN_CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ') && header.slice(7) === secret) return true;
  return req.headers['x-vercel-cron'] != null;
}

function paceEmoji(direction: PulseOutput['direction']): string {
  if (direction === 'prepare_long') return '🟢 PERSIAPAN LONG';
  if (direction === 'prepare_short') return '🔴 PERSIAPAN SHORT';
  if (direction === 'hedge') return '🛡️ HEDGE';
  return '⏸️ TUNGGU';
}

function buildPulseMessage(p: PulseOutput, snap: PulseSnapshot): string {
  const now = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
  });
  const lines: string[] = [
    '🧭 MARKET PULSE — ALTHUNTER',
    '━━━━━━━━━━━━━━━━━━━━━━',
    `⏰ ${now} WIB · ${snap.tf.toUpperCase()}`,
    `🌍 ${p.marketRegime}`,
    '',
  ];
  for (const c of p.crossMarket) lines.push(`• ${c}`);
  lines.push('');
  lines.push(`${paceEmoji(p.direction)} · konviksi ${p.conviction}`);
  lines.push(p.headline);
  if (p.playbook.invalidation) lines.push(`⚠️ Batal jika: ${p.playbook.invalidation}`);
  if (p.playbook.long) lines.push(`🟢 Long: ${p.playbook.long}`);
  if (p.playbook.short) lines.push(`🔴 Short: ${p.playbook.short}`);
  lines.push('');
  lines.push(`Makro: ${p.macroRead}`);
  for (const c of p.caveats) lines.push(`– ${c}`);
  lines.push('');
  lines.push(`Sumber: ${p.source === 'llm' ? `AI ${p.model ?? ''}` : 'rule-based'}`);
  return lines.join('\n').slice(0, 3900);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body: Body = { ...(req.query as Body), ...(req.body as Body) };
  const tf = body.tf && VALID_TF.has(body.tf) ? body.tf : '1h';
  const wantsNotify = body.notify !== false;

  let loaded;
  try {
    loaded = await loadFutures(tf);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : 'load failed' });
  }

  const missing = missingSymbols(loaded);
  const snapshot = buildPulseSnapshot({
    signals: loaded.signals,
    macro: loaded.macro,
    tf,
    missing,
  });

  const analysis = await analysePulse(snapshot);
  const message = buildPulseMessage(analysis, snapshot);

  let sent = false;
  let sendError: string | undefined;
  if (wantsNotify) {
    if (!telegramEnv().configured) {
      sendError = 'Telegram belum dikonfigurasi (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)';
    } else {
      const result = await sendTelegramMessage(message);
      sent = result.ok;
      sendError = result.error;
    }
  }

  return res.status(200).json({
    ok: !sendError,
    tf,
    scanned: loaded.signals.length,
    missing,
    direction: analysis.direction,
    source: analysis.source,
    notified: wantsNotify,
    sent,
    sendError,
    preview: message,
    ...(body.debug ? { snapshot, analysis } : {}),
  });
}
