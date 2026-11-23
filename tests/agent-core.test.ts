import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryAuditSink,
  MARKET_TOOLS,
  READ_ONLY_TOOLS,
  callLLMWithTools,
  describeCall,
  executeToolCall,
  idempotencyKey,
  runAgent,
  validateToolArgs,
} from '../lib/agent';
import type {
  AgentDeps,
  AgentPolicy,
  LLMMessage,
  LLMResponse,
  ToolDefinition,
} from '../lib/agent';

const CONTEXT = readFileSync(
  join(process.cwd(), 'eval', 'fixtures', 'scan-2026-11-22.txt'),
  'utf8'
);

const GOOD_ANSWER =
  'Regime risk on, SOLUSDT skor 81 masih segar dengan support 168 sebagai pembatal.\n\n' +
  'Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri.';

function textResponse(content: string): LLMResponse {
  return { content, toolCalls: [] };
}

function toolResponse(name: string, args: Record<string, unknown>, id = 'call_1'): LLMResponse {
  return {
    content: '',
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  };
}

function fakeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'get_last_scan',
    description: 'Ambil scan terakhir',
    scope: 'read',
    params: { symbol: { type: 'string', description: 'simbol', required: true } },
    run: vi.fn(async () => ({ ok: true, data: { regime: 'risk on' } })),
    ...overrides,
  };
}

function makeDeps(responses: LLMResponse[]): {
  deps: AgentDeps;
  llmSpy: ReturnType<typeof vi.fn>;
  audit: InMemoryAuditSink;
} {
  const llmSpy = vi.fn(async (): Promise<LLMResponse> => responses.shift() ?? textResponse(GOOD_ANSWER));
  const audit = new InMemoryAuditSink();
  return { deps: { llm: llmSpy, audit }, llmSpy, audit };
}

function baseOptions(deps: AgentDeps, tools: ToolDefinition[], policy: AgentPolicy) {
  return {
    question: 'Setup SOL gimana?',
    context: CONTEXT,
    tools,
    policy,
    deps,
    chatId: '12345',
  };
}

const SAFE_POLICY: AgentPolicy = { maxSteps: 4, maxToolCalls: 3, dryRun: false };

describe('agent argument validation', () => {
  it('coerces valid args and rejects unknown/missing/invalid ones', () => {
    const tool = fakeTool({
      params: {
        symbol: { type: 'string', description: 'simbol', required: true },
        interval: { type: 'string', description: 'tf', enum: ['4h', '1d'] },
        limit: { type: 'number', description: 'jumlah', min: 10, max: 100 },
        symbols: { type: 'string[]', description: 'daftar' },
      },
    });
    const ok = validateToolArgs(
      JSON.stringify({ symbol: 'BTCUSDT', interval: '4h', limit: '50', symbols: ['BTC', 'ETH'] }),
      tool
    );
    expect(ok.ok).toBe(true);
    expect(ok.args).toMatchObject({ limit: 50, interval: '4h' });

    const bad = validateToolArgs(
      JSON.stringify({ symbol: 42, interval: '1w', limit: 500, extra: true }),
      tool
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/symbol|interval|limit|extra/);
  });

  it('produces a key independent of argument order', () => {
    const a = idempotencyKey('42', 'tool', { x: 1, y: 'a' });
    const b = idempotencyKey('42', 'tool', { y: 'a', x: 1 });
    expect(a).toBe(b);
    expect(idempotencyKey('43', 'tool', { x: 1, y: 'a' })).not.toBe(a);
    expect(describeCall('tool', { y: 'a', x: 1 })).toBe('tool(x=1, y="a")');
  });
});

describe('agent loop', () => {
  it('uses a tool, feeds the observation back, then answers', async () => {
    const tool = fakeTool();
    const { deps, llmSpy, audit } = makeDeps([
      toolResponse('get_last_scan', { symbol: 'BTCUSDT' }),
      textResponse(GOOD_ANSWER),
    ]);

    const result = await runAgent(baseOptions(deps, [tool], SAFE_POLICY));

    expect(result.outcome).toBe('answered');
    expect(result.toolCalls).toBe(1);
    expect(tool.run).toHaveBeenCalledTimes(1);
    expect(llmSpy).toHaveBeenCalledTimes(2);
    const secondMessages = llmSpy.mock.calls[1][0] as LLMMessage[];
    expect(secondMessages.some((m) => m.role === 'tool')).toBe(true);
    expect(audit.all().some((r) => r.status === 'executed')).toBe(true);
  });

  it('passes the production system prompt plus agent instructions', async () => {
    const { deps, llmSpy } = makeDeps([textResponse(GOOD_ANSWER)]);
    await runAgent(baseOptions(deps, [], SAFE_POLICY));
    const system = llmSpy.mock.calls[0][2] as string | undefined;
    expect(system).toContain('spesialis pasar');
    expect(system).toContain('KAMU ADALAH AGENT');
  });

  it('requires confirmation before a write tool executes', async () => {
    const run = vi.fn(async () => ({ ok: true, data: { sent: true } }));
    const tool = fakeTool({
      name: 'send_telegram_notification',
      scope: 'write',
      params: { text: { type: 'string', description: 'pesan', required: true } },
      run,
    });
    const policy: AgentPolicy = {
      ...SAFE_POLICY,
      requireConfirmationFor: ['send_telegram_notification'],
    };
    const { deps, audit } = makeDeps([toolResponse('send_telegram_notification', { text: 'halo' })]);

    const result = await runAgent(baseOptions(deps, [tool], policy));

    expect(result.outcome).toBe('needs_confirmation');
    expect(result.pendingConfirmation).toBeDefined();
    expect(result.pendingConfirmation?.toolName).toBe('send_telegram_notification');
    expect(run).not.toHaveBeenCalled();
    expect(audit.all().some((r) => r.status === 'needs_confirmation')).toBe(true);
  });

  it('executes a write tool once the matching idempotency key is confirmed', async () => {
    const run = vi.fn(async () => ({ ok: true, data: { sent: true } }));
    const tool = fakeTool({
      name: 'send_telegram_notification',
      scope: 'write',
      params: { text: { type: 'string', description: 'pesan', required: true } },
      run,
    });
    const policy: AgentPolicy = {
      ...SAFE_POLICY,
      requireConfirmationFor: ['send_telegram_notification'],
    };
    const key = idempotencyKey('12345', 'send_telegram_notification', { text: 'halo' });
    const { deps } = makeDeps([
      toolResponse('send_telegram_notification', { text: 'halo' }),
      textResponse(GOOD_ANSWER),
    ]);

    const result = await runAgent({
      ...baseOptions(deps, [tool], policy),
      confirmedKeys: new Set([key]),
    });

    expect(result.outcome).toBe('answered');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never executes a tool in dry-run mode', async () => {
    const run = vi.fn(async () => ({ ok: true, data: {} }));
    const tool = fakeTool({ run });
    const { deps, audit } = makeDeps([
      toolResponse('get_last_scan', { symbol: 'BTCUSDT' }),
      textResponse(GOOD_ANSWER),
    ]);

    await runAgent({
      ...baseOptions(deps, [tool], SAFE_POLICY),
      dryRun: true,
    });

    expect(run).not.toHaveBeenCalled();
    expect(audit.all().some((r) => r.status === 'dry_run')).toBe(true);
  });

  it('enforces the tool-call budget', async () => {
    const tool = fakeTool();
    const { deps } = makeDeps(
      Array.from({ length: 6 }, (_, i) => toolResponse('get_last_scan', { symbol: 'BTCUSDT' }, `c${i}`))
    );

    const result = await runAgent({
      ...baseOptions(deps, [tool], { maxSteps: 5, maxToolCalls: 2 }),
    });

    expect(result.toolCalls).toBe(2);
    expect(result.outcome).toBe('budget_exceeded');
  });

  it('retries once when the final answer violates a guardrail', async () => {
    const { deps, audit } = makeDeps([
      textResponse('Dijamin profit, SOLUSDT skor 81.\n\nBukan saran finansial. Konfirmasi dan risiko tanggung sendiri.'),
      textResponse(GOOD_ANSWER),
    ]);

    const result = await runAgent(baseOptions(deps, [], SAFE_POLICY));

    expect(result.outcome).toBe('answered');
    expect(result.steps).toBe(2);
    expect(audit.all().some((r) => r.status === 'rejected')).toBe(true);
  });

  it('falls back to a safe answer when guardrails keep failing', async () => {
    const bad = 'Dijamin profit.\n\nBukan saran finansial. Konfirmasi dan risiko tanggung sendiri.';
    const { deps } = makeDeps([textResponse(bad), textResponse(bad)]);

    const result = await runAgent(baseOptions(deps, [], SAFE_POLICY));

    expect(result.outcome).toBe('error');
    expect(result.answer).toContain('belum bisa menyimpulkan dengan aman');
  });
});

describe('safe executor', () => {
  const audit = new InMemoryAuditSink();

  it('replays an idempotent call without re-running the tool', async () => {
    const run = vi.fn(async () => ({ ok: true, data: { original: true } }));
    const t = fakeTool({ name: 'write_thing', scope: 'write', params: {}, run, timeoutMs: 100 });
    const sink = new InMemoryAuditSink();
    const args = {};
    const options = {
      call: { id: 'c1', name: 'write_thing', arguments: '{}' },
      tools: [t],
      policy: { ...SAFE_POLICY, requireConfirmationFor: [] },
      chatId: '9',
      correlationId: 'r1',
      audit: sink,
      confirmedKeys: new Set([idempotencyKey('9', 'write_thing', args)]),
    };

    const first = await executeToolCall(options);
    const second = await executeToolCall(options);

    expect(first.kind).toBe('result');
    expect(second.kind).toBe('result');
    if (second.kind === 'result') expect(second.content).toContain('replayed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown tool and an invalid argument without executing', async () => {
    const run = vi.fn(async () => ({ ok: true, data: {} }));
    const t = fakeTool({ name: 'typed_thing', run });
    const common = {
      tools: [t],
      policy: SAFE_POLICY,
      chatId: '9',
      correlationId: 'r2',
      audit,
      confirmedKeys: new Set<string>(),
    };

    const unknown = await executeToolCall({
      ...common,
      call: { id: 'c1', name: 'nope', arguments: '{}' },
    });
    const invalid = await executeToolCall({
      ...common,
      call: { id: 'c2', name: 'typed_thing', arguments: '{"symbol":123}' },
    });

    expect(unknown.kind).toBe('error');
    expect(invalid.kind).toBe('error');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the write tool out of the read-only set', () => {
    expect(typeof callLLMWithTools).toBe('function');
    expect(MARKET_TOOLS.filter((t) => t.scope === 'write').map((t) => t.name)).toEqual([
      'send_telegram_notification',
    ]);
    expect(READ_ONLY_TOOLS.every((t) => t.scope === 'read')).toBe(true);
  });
});
