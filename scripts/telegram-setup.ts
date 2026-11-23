/**
 * Telegram bot setup helper — run once after deploy (or locally).
 *
 *   npx tsx scripts/telegram-setup.ts [https://your-domain.vercel.app]
 *
 * What it does, in order:
 *   1. Loads .env.local without printing any secret.
 *   2. getMe            → confirms the token belongs to the expected bot.
 *   3. getUpdates       → lists chat ids that recently messaged the bot (best
 *                         effort: fails with 409 while a webhook is active).
 *   4. setWebhook       → registers /api/telegram-webhook, with secret_token
 *                         when TELEGRAM_WEBHOOK_SECRET is set.
 *   5. setMyCommands    → registers the command menu shown in Telegram.
 *   6. getWebhookInfo   → prints the final state (url, secret hint, errors).
 *
 * The bot token is never printed. Pass the public origin as the first argument
 * or set VERCEL_URL in the environment.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Load .env.local (no dotenv dependency, no overriding of real env vars).
// ---------------------------------------------------------------------------
function loadLocalEnv(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const [, key, value] = m;
      if (process.env[key] != null) continue;
      process.env[key] = value.replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    // No .env.local — rely on the shell environment / Vercel env.
  }
}
loadLocalEnv();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN belum diset (isi .env.local atau environment).');
  process.exit(1);
}

interface TelegramResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function api<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as TelegramResult<T>;
  if (!data.ok || data.result === undefined) {
    throw new Error(`${method}: ${data.description || `HTTP ${res.status}`}`);
  }
  return data.result;
}

const COMMANDS = [
  { command: 'status', description: 'Ringkasan scan terakhir + sektor early' },
  { command: 'top', description: '5 koin paling tradeable' },
  { command: 'watch', description: 'Koin dipantau, pemicu belum muncul' },
  { command: 'matrix', description: 'Ranking kekuatan: /matrix 4h 30' },
  { command: 'pair', description: 'Arah relatif A/B: /pair SOL BTC' },
  { command: 'hold', description: 'Tahan / kurangi / buang: /hold 4h 30' },
  { command: 'scan', description: 'Pindai pasar ulang' },
  { command: 'help', description: 'Daftar perintah' },
];

async function main(): Promise<void> {
  // 1. Identity -------------------------------------------------------------
  const me = await api<{ id: number; username?: string; first_name: string }>('getMe');
  console.log(`Bot   : @${me.username ?? me.first_name} (id ${me.id})`);

  // 2. Recent chats ---------------------------------------------------------
  try {
    const updates = await api<
      Array<{ message?: { chat?: { id: number; first_name?: string; username?: string } } }>
    >('getUpdates', { limit: 20 });
    const chats = new Map<number, string>();
    for (const u of updates) {
      const chat = u.message?.chat;
      if (chat?.id != null) {
        chats.set(chat.id, chat.username ? `@${chat.username}` : chat.first_name || '(tanpa nama)');
      }
    }
    if (chats.size === 0) {
      console.log('Chat : belum ada pesan masuk. Chat bot dulu, lalu ulangi script ini.');
    } else {
      console.log('Chat : salin salah satu ke TELEGRAM_CHAT_ID:');
      chats.forEach((name, id) => console.log(`       ${id}  ${name}`));
    }
  } catch (err) {
    console.log(`Chat : getUpdates tidak tersedia (${err instanceof Error ? err.message : err}).`);
    console.log('       Cara alternatif: chat @userinfobot untuk melihat chat id kamu.');
  }

  // 3. Webhook --------------------------------------------------------------
  const origin = (process.argv[2] || process.env.VERCEL_URL || '').replace(/\/+$/, '');
  const configuredChat = process.env.TELEGRAM_CHAT_ID?.trim();
  console.log(`Chat aktif : ${configuredChat ? 'sudah diisi' : 'BELUM diisi — bot tidak akan membalas'}`);

  if (!origin) {
    console.log('\nWebhook dilewati: berikan origin deploy sebagai argumen atau set VERCEL_URL.');
    console.log('Contoh: npx tsx scripts/telegram-setup.ts https://alphahunter-silk.vercel.app');
  } else {
    const url = `${origin}/api/telegram-webhook`;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    const body: Record<string, unknown> = { url, drop_pending_updates: false };
    if (secret) body.secret_token = secret;
    await api<boolean>('setWebhook', body);
    console.log(`Webhook: ${url}`);
    console.log(`Secret : ${secret ? 'terdaftar (disembunyikan)' : 'tidak diset — disarankan isi TELEGRAM_WEBHOOK_SECRET'}`);
  }

  // 4. Command menu ---------------------------------------------------------
  await api<boolean>('setMyCommands', { commands: COMMANDS });
  console.log(`Menu   : ${COMMANDS.length} perintah terdaftar`);

  // 5. Final state ----------------------------------------------------------
  const info = await api<{
    url: string;
    has_custom_certificate: boolean;
    pending_update_count: number;
    ip_address?: string;
    last_error_date?: number;
    last_error_message?: string;
    secret_token_hinted?: boolean;
  }>('getWebhookInfo');
  console.log('\nWebhook aktif:');
  console.log(`  url        : ${info.url || '(kosong)'}`);
  console.log(`  secret     : ${info.secret_token_hinted ? 'terdaftar' : 'tidak ada'}`);
  console.log(`  pending    : ${info.pending_update_count}`);
  console.log(`  last error : ${info.last_error_message || '(tidak ada)'}`);
}

void main().catch((err) => {
  console.error('telegram-setup gagal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
