/**
 * Safe tool execution: whitelist → validate → idempotency → confirmation →
 * dry-run → timeout → audit. The LLM never touches a backend directly.
 */

import { createAuditRecord } from './audit';
import { describeCall, idempotencyKey, validateToolArgs } from './schema';
import type {
  AgentPolicy,
  AuditRecord,
  AuditSink,
  PendingConfirmation,
  ToolCall,
  ToolDefinition,
} from './types';

const DEFAULT_TIMEOUT_MS = 8000;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export interface ExecuteOptions {
  call: ToolCall;
  tools: ToolDefinition[];
  policy: AgentPolicy;
  chatId: string;
  correlationId: string;
  audit: AuditSink;
  /** Idempotency keys the user has explicitly confirmed. */
  confirmedKeys: Set<string>;
  dryRun?: boolean;
  now?: () => number;
  id?: () => string;
}

export type ExecuteResult =
  | { kind: 'result'; content: string; record: AuditRecord }
  | { kind: 'confirmation'; content: string; pending: PendingConfirmation; record: AuditRecord }
  | { kind: 'error'; content: string; record: AuditRecord };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool timeout setelah ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function auditFields(opts: ExecuteOptions) {
  return {
    correlationId: opts.correlationId,
    chatId: opts.chatId,
  };
}

export async function executeToolCall(opts: ExecuteOptions): Promise<ExecuteResult> {
  const now = opts.now ?? Date.now;
  const id = opts.id ?? (() => `ev_${Math.random().toString(36).slice(2)}`);
  const started = now();
  const { call, policy } = opts;

  const finish = (
    status: AuditRecord['status'],
    detail: string,
    extra: {
      toolName?: string | null;
      args?: Record<string, unknown> | null;
      key?: string | null;
      result?: unknown;
    } = {}
  ): AuditRecord =>
    createAuditRecord({
      id: id(),
      ...auditFields(opts),
      toolName: extra.toolName ?? null,
      args: extra.args ?? null,
      status,
      idempotencyKey: extra.key ?? null,
      detail,
      durationMs: Math.max(0, now() - started),
      result: extra.result,
    });

  const tool = opts.tools.find((t) => t.name === call.name);
  if (!tool) {
    const record = finish('rejected', `tool tidak dikenal: ${call.name}`);
    await opts.audit.append(record);
    return { kind: 'error', content: `Tool "${call.name}" tidak tersedia.`, record };
  }

  if (policy.allowedTools && !policy.allowedTools.includes(tool.name)) {
    const record = finish('rejected', `tool tidak diizinkan: ${tool.name}`, {
      toolName: tool.name,
    });
    await opts.audit.append(record);
    return { kind: 'error', content: `Tool "${tool.name}" tidak diizinkan dalam sesi ini.`, record };
  }

  const validation = validateToolArgs(call.arguments, tool);
  if (!validation.ok) {
    const record = finish('rejected', `argumen invalid: ${validation.errors.join('; ')}`, {
      toolName: tool.name,
      args: validation.args,
    });
    await opts.audit.append(record);
    return {
      kind: 'error',
      content: `Argumen "${tool.name}" ditolak: ${validation.errors.join('; ')}`,
      record,
    };
  }

  const args = validation.args;
  const key = idempotencyKey(opts.chatId, tool.name, args);

  const cached = await opts.audit.findByIdempotencyKey(key);
  if (cached) {
    const record = finish('cached', `replay idempoten: ${describeCall(tool.name, args)}`, {
      toolName: tool.name,
      args,
      key,
      result: cached.result,
    });
    await opts.audit.append(record);
    return {
      kind: 'result',
      content: JSON.stringify({ ok: true, data: cached.result, replayed: true }),
      record,
    };
  }

  const needsConfirmation =
    tool.scope === 'write' &&
    (policy.requireConfirmationFor ?? []).includes(tool.name) &&
    !opts.confirmedKeys.has(key);

  if (needsConfirmation) {
    const pending: PendingConfirmation = {
      token: key,
      toolName: tool.name,
      args,
      description: describeCall(tool.name, args),
      expiresAt: now() + CONFIRMATION_TTL_MS,
    };
    const record = finish('needs_confirmation', `menunggu konfirmasi: ${pending.description}`, {
      toolName: tool.name,
      args,
      key,
    });
    await opts.audit.append(record);
    return {
      kind: 'confirmation',
      content: `Aksi ini akan menulis data: ${pending.description}. Ketik /confirm ${key} untuk melanjutkan (berlaku 5 menit).`,
      pending,
      record,
    };
  }

  const dryRun = opts.dryRun || policy.dryRun === true || tool.scope === 'write' && !opts.confirmedKeys.has(key);
  if (dryRun) {
    const preview = tool.description;
    const record = finish('dry_run', `dry-run: ${describeCall(tool.name, args)}`, {
      toolName: tool.name,
      args,
      key,
      result: { preview },
    });
    await opts.audit.append(record);
    return {
      kind: 'result',
      content: JSON.stringify({ ok: true, dryRun: true, preview }),
      record,
    };
  }

  try {
    const outcome = await withTimeout(
      tool.run(args, {
        chatId: opts.chatId,
        correlationId: opts.correlationId,
        dryRun: false,
      }),
      tool.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const record = finish(
      outcome.ok ? 'executed' : 'failed',
      `${describeCall(tool.name, args)} → ${outcome.ok ? 'ok' : outcome.error ?? 'gagal'}`,
      { toolName: tool.name, args, key, result: outcome.data ?? null }
    );
    await opts.audit.append(record);
    return {
      kind: 'result',
      content: JSON.stringify(outcome),
      record,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const record = finish('failed', `${describeCall(tool.name, args)} → error: ${message}`, {
      toolName: tool.name,
      args,
      key,
    });
    await opts.audit.append(record);
    return {
      kind: 'error',
      content: `Tool "${tool.name}" gagal: ${message}`,
      record,
    };
  }
}
