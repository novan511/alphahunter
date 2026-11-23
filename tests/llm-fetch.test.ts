import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLLM, LLMTransportError } from '../lib/llmFetch';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function networkError(code: string): TypeError & { cause: { code: string } } {
  const err = new TypeError('fetch failed') as TypeError & { cause: { code: string } };
  err.cause = { code };
  return err;
}

describe('fetchLLM', () => {
  it('retries a transient network failure and returns the successful response', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(networkError('ECONNRESET'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchLLM('https://example.test/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('includes the underlying cause code instead of a bare "fetch failed"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError('ENOTFOUND')));

    await expect(
      fetchLLM('https://example.test/v1/chat/completions', { method: 'POST' }, { attempts: 2 })
    ).rejects.toThrow(/ENOTFOUND/);
  });

  it('throws LLMTransportError after exhausting attempts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError('ECONNRESET')));

    await expect(
      fetchLLM('https://example.test/v1/chat/completions', { method: 'POST' }, { attempts: 3 })
    ).rejects.toBeInstanceOf(LLMTransportError);
  });

  it('does not retry a plain 400 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchLLM('https://example.test/v1/chat/completions', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and returns the later success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchLLM('https://example.test/v1/chat/completions', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
