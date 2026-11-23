/**
 * Resilient fetch for LLM endpoints.
 *
 * A plain `fetch()` failure used to surface to Telegram users as
 * "AI trader sedang sibuk atau error (fetch failed)". That is a transport
 * error — DNS, TLS, connection reset, or a cold endpoint — and is very often
 * transient. This wrapper adds a bounded timeout, a few retries with jitter,
 * and an error message that carries the underlying cause code so operators can
 * tell ECONNRESET from ENOTFOUND without exposing any credential.
 */

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 12_000;
const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class LLMTransportError extends Error {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(code ? `${message} (${code})` : message);
    this.name = 'LLMTransportError';
  }
}

export interface LLMFetchOptions {
  attempts?: number;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = 400 * Math.pow(2, attempt);
  return Math.round(base + Math.random() * base * 0.4);
}

function causeCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const withCause = err as { cause?: { code?: string } };
  return withCause.cause?.code;
}

/** Fetch with bounded retries. Never throws a bare "fetch failed". */
export async function fetchLLM(
  url: string,
  init: RequestInit,
  opts: LLMFetchOptions = {}
): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!RETRY_STATUSES.has(response.status) || attempt === attempts - 1) {
        return response;
      }
      lastError = new LLMTransportError(`LLM HTTP ${response.status}`);
      await sleep(backoffMs(attempt));
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1) break;
      await sleep(backoffMs(attempt));
    }
  }

  if (lastError instanceof LLMTransportError) throw lastError;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new LLMTransportError(message, causeCode(lastError));
}
