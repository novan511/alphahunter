/**
 * Server-side Telegram sender (shared by notify + webhook routes).
 * Credentials come from env; nothing here is exposed to the browser.
 */

export function telegramEnv(): { token: string; chatId: string; configured: boolean } {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  return { token, chatId, configured: token.length > 0 && chatId.length > 0 };
}

export async function sendTelegramMessage(
  text: string,
  chatId?: string
): Promise<{ ok: boolean; error?: string }> {
  const { token, chatId: defaultChat } = telegramEnv();
  const target = chatId || defaultChat;
  if (!token || !target) {
    return { ok: false, error: 'Telegram belum dikonfigurasi' };
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: target,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
    });
    const data = (await resp.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    if (!resp.ok || !data?.ok) {
      return { ok: false, error: data?.description || `Telegram HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Gagal menghubungi Telegram' };
  }
}
