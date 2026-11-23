/**
 * Server-side Telegram sender (shared by notify + webhook routes).
 * Credentials come from env; nothing here is exposed to the browser.
 */

export function telegramEnv(): { token: string; chatId: string; configured: boolean } {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  return { token, chatId, configured: token.length > 0 && chatId.length > 0 };
}

export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

interface SendOptions {
  reply_markup?: TelegramInlineKeyboard;
}

async function telegramApi<T>(
  method: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const { token } = telegramEnv();
  if (!token) return { ok: false, error: 'Telegram belum dikonfigurasi' };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await resp.json().catch(() => null)) as
      | { ok?: boolean; description?: string; result?: T }
      | null;
    if (!resp.ok || !data?.ok) {
      return { ok: false, error: data?.description || `Telegram HTTP ${resp.status}` };
    }
    return { ok: true, data: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Gagal menghubungi Telegram' };
  }
}

export async function sendTelegramMessage(
  text: string,
  chatId?: string,
  opts: SendOptions = {}
): Promise<{ ok: boolean; error?: string }> {
  const { chatId: defaultChat } = telegramEnv();
  const target = chatId || defaultChat;
  if (!target) return { ok: false, error: 'Telegram belum dikonfigurasi' };

  const payload: Record<string, unknown> = {
    chat_id: target,
    text: text.slice(0, 4000),
    disable_web_page_preview: true,
  };
  if (opts.reply_markup) payload.reply_markup = opts.reply_markup;

  const result = await telegramApi('sendMessage', payload);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * "Typing…" indicator. Best-effort and deliberately not awaited by callers:
 * it must never delay or break the actual reply.
 */
export async function sendChatAction(action: string, chatId?: string): Promise<void> {
  const { chatId: defaultChat } = telegramEnv();
  const target = chatId || defaultChat;
  if (!target) return;
  await telegramApi('sendChatAction', { chat_id: target, action });
}

/** Stop the loading spinner on an inline-keyboard button. Best-effort. */
export async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  if (!callbackQueryId) return;
  await telegramApi('answerCallbackQuery', { callback_query_id: callbackQueryId });
}
