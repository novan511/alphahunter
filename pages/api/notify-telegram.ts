import type { NextApiRequest, NextApiResponse } from 'next';

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
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  const configured = token.length > 0 && chatId.length > 0;

  if (req.method === 'GET') {
    return res.status(200).json({ configured });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET,POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!configured) {
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

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    const data = (await resp.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!resp.ok || !data?.ok) {
      return res.status(500).json({
        ok: false,
        error: data?.description || `Telegram HTTP ${resp.status}`,
      });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Gagal menghubungi Telegram',
    });
  }
}
