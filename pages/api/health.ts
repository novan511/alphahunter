import type { NextApiRequest, NextApiResponse } from 'next';
import { llmEnv } from '../../lib/quant/marketNarrator';
import { logEvent } from '../../lib/observability';
import { isSupabaseConfigured } from '../../lib/supabase';
import { telegramEnv } from '../../lib/serverTelegram';

/**
 * Operator health check. Reports booleans only — no tokens, no chat id, no
 * secrets. Useful after deploy to confirm the bot can actually answer.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, chatId, configured } = telegramEnv();
  const llm = llmEnv();
  const checks = {
    telegramToken: token.length > 0,
    telegramChatId: chatId.length > 0,
    telegramWebhookSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET?.trim()),
    llm: llm.configured,
    supabase: isSupabaseConfigured(),
    cronSecret: Boolean(process.env.SCAN_CRON_SECRET?.trim()),
  };
  const ok = checks.telegramToken && checks.telegramChatId && checks.llm && checks.supabase;

  logEvent('health_check', { ok }, ok ? 'info' : 'warn');
  return res.status(200).json({
    ok,
    checks,
    model: llm.model,
    uptimeSeconds: Math.round(process.uptime()),
  });
}
