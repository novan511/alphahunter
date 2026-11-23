import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/quant/marketNarrator', () => ({
  llmEnv: () => ({ configured: true, model: 'test-model' }),
}));
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => true }));
vi.mock('../lib/serverTelegram', () => ({
  telegramEnv: () => ({ token: 'test-token', chatId: '12345', configured: true }),
}));
vi.mock('../lib/observability', () => ({ logEvent: () => undefined }));

import handler from '../pages/api/health';

interface TestRes {
  statusCode: number;
  body: unknown;
  setHeader(): void;
  status(code: number): TestRes;
  json(value: unknown): TestRes;
}

function makeRes(): TestRes {
  const res: TestRes = {
    statusCode: 200,
    body: undefined,
    setHeader() {
      return undefined;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
  };
  return res;
}

describe('/api/health', () => {
  it('melaporkan status tanpa membocorkan token atau chat id', async () => {
    const res = makeRes();
    await handler({ method: 'GET' } as NextApiRequest, res as unknown as NextApiResponse);
    const data = res.body as { ok: boolean; checks: Record<string, boolean>; model: string };
    expect(data.ok).toBe(true);
    expect(data.checks.telegramChatId).toBe(true);
    expect(data.model).toBe('test-model');
    expect(JSON.stringify(data)).not.toContain('12345');
    expect(JSON.stringify(data)).not.toContain('test-token');
  });

  it('menolak method selain GET', async () => {
    const res = makeRes();
    await handler({ method: 'POST' } as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(405);
  });
});
