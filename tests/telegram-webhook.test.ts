import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_text: string, _chatId?: string, _opts?: unknown) => ({ ok: true })),
  answer: vi.fn(async (_id: string) => undefined),
  typing: vi.fn(async (_action: string, _chatId?: string) => undefined),
  env: { token: 'test-token', chatId: '12345', configured: true },
}));

vi.mock('../lib/serverTelegram', () => ({
  sendTelegramMessage: mocks.send,
  answerCallbackQuery: mocks.answer,
  sendChatAction: mocks.typing,
  telegramEnv: () => mocks.env,
}));

vi.mock('../lib/observability', () => ({
  logEvent: () => undefined,
  maskChatId: (id: string | number) => `****${String(id).slice(-4)}`,
}));

import handler from '../pages/api/telegram-webhook';

interface TestRes {
  statusCode: number;
  body: unknown;
  status(code: number): TestRes;
  json(value: unknown): TestRes;
  setHeader(): void;
}

function makeRes(): TestRes {
  const res: TestRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
    setHeader() {
      return undefined;
    },
  };
  return res;
}

function makeReq(
  update: unknown,
  method = 'POST',
  query: Record<string, string> = {},
  headers: Record<string, string> = {}
): NextApiRequest {
  return { method, body: update, query, headers } as unknown as NextApiRequest;
}

let nextUpdateId = 1;
function updateFrom(text: string | undefined, chatId: number | string = 12345): unknown {
  return {
    update_id: nextUpdateId++,
    message: { message_id: 1, chat: { id: chatId, type: 'private' }, text },
  };
}

async function call(update: unknown, headers: Record<string, string> = {}): Promise<TestRes> {
  const res = makeRes();
  await handler(makeReq(update, 'POST', {}, headers), res as unknown as NextApiResponse);
  return res;
}

describe('telegram-webhook handler', () => {
  beforeEach(() => {
    mocks.env.configured = true;
    mocks.env.chatId = '12345';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('health check GET mengembalikan usage', async () => {
    const res = makeRes();
    await handler(makeReq(undefined, 'GET'), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('tidak menjawab kalau Telegram belum terkonfigurasi', async () => {
    mocks.env.configured = false;
    const res = await call(updateFrom('/help'));
    expect((res.body as { reason: string }).reason).toBe('telegram not configured');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('membungkam chat selain owner', async () => {
    const res = await call(updateFrom('/help', 999));
    expect((res.body as { ignored: boolean }).ignored).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('mengabaikan update tanpa teks', async () => {
    const res = await call(updateFrom(undefined));
    expect((res.body as { ignored: boolean }).ignored).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('/help membalas daftar perintah + keyboard ke chat owner', async () => {
    const res = await call(updateFrom('/help'));
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [text, chatId, opts] = mocks.send.mock.calls[0] as [
      string,
      string,
      { reply_markup?: { inline_keyboard: unknown[][] } },
    ];
    expect(text).toContain('/status');
    expect(text).toContain('/matrix');
    expect(chatId).toBe('12345');
    expect(opts.reply_markup?.inline_keyboard.length).toBeGreaterThan(0);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  it('perintah tak dikenal dijawab dengan petunjuk', async () => {
    await call(updateFrom('/nope'));
    const [text] = mocks.send.mock.calls[0] as [string];
    expect(text).toContain('Perintah tidak dikenali');
  });

  it('menolak request tanpa webhook secret yang benar', async () => {
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 's3cret');
    const rejected = await call(updateFrom('/help'), {
      'x-telegram-bot-api-secret-token': 'salah',
    });
    expect((rejected.body as { ignored: boolean }).ignored).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();

    const accepted = await call(updateFrom('/help'), {
      'x-telegram-bot-api-secret-token': 's3cret',
    });
    expect((accepted.body as { ok: boolean }).ok).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('mengabaikan update_id yang sama (dedup Telegram)', async () => {
    const update = updateFrom('/help');
    const first = await call(update);
    const second = await call(update);
    expect((first.body as { ok: boolean }).ok).toBe(true);
    expect((second.body as { duplicate: boolean }).duplicate).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('tombol inline keyboard di-router lewat cmd:<perintah>', async () => {
    const res = await call({
      update_id: nextUpdateId++,
      callback_query: {
        id: 'cb-1',
        data: 'cmd:help',
        message: { chat: { id: 12345, type: 'private' } },
      },
    });
    expect(mocks.answer).toHaveBeenCalledWith('cb-1');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [text] = mocks.send.mock.calls[0] as [string];
    expect(text).toContain('/status');
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  it('menolak callback dengan data di luar whitelist', async () => {
    const res = await call({
      update_id: nextUpdateId++,
      callback_query: {
        id: 'cb-2',
        data: 'cmd:__proto__',
        message: { chat: { id: 12345, type: 'private' } },
      },
    });
    expect((res.body as { ignored: boolean }).ignored).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
