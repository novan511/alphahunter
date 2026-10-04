import type { NextApiRequest, NextApiResponse } from 'next';
import { sendTelegramMessage, telegramEnv } from '../../lib/serverTelegram';

/**
 * Telegram notifier proxy.
 *
 * GET  /api/notify-telegram        → { configured: boolean }
 * POST /api/notify-telegram        → { ok: true } | { ok: false, error }
 *   body: { text: string }  (max 4000 chars, plain text — no parse_mode so
 *   coin names and numbers can never break Telegram formatting)
 *
 * The bot token and chat id live ONLY in server env
 * (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID). The browser never sees them —
 * it just POSTs the message text to this route.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    return res.status(200).json({ configured: telegramEnv().configured });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!telegramEnv().configured) {
    return res.status(200).json({
      ok: false,
      configured: false,
      error: 'Telegram belum dikonfigurasi — isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID di .env.local',
    });
  }

  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text || text.length > 4000) {
    return res.status(400).json({ ok: false, error: 'text kosong atau > 4000 karakter' });
  }

  const result = await sendTelegramMessage(text);
  if (!result.ok) {
    return res.status(500).json({ ok: false, error: result.error });
  }
  return res.status(200).json({ ok: true });
}
