import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryAuditSink,
  InMemoryConfirmationStore,
  SupabaseConfirmationStore,
  createDurableAuditSink,
  createAuditRecord,
  type SupabaseLike,
  type SupabaseMutateFilter,
  type SupabaseResult,
  type SupabaseRow,
} from '../lib/agent/audit';
import { idempotencyKey, runAgent } from '../lib/agent';
import type {
  AgentDeps,
  AgentPolicy,
  LLMMessage,
  LLMResponse,
  PendingConfirmation,
  ToolDefinition,
} from '../lib/agent';

type TableName = 'agent_audit' | 'agent_confirmation';
type Db = Record<TableName, SupabaseRow[]>;

/** Tiny in-memory stand-in for the Supabase client interface in audit.ts. */
class FakeQuery implements SupabaseMutateFilter {
  private filters: Array<[string, unknown]> = [];
  private mode: 'select' | 'insert' | 'delete' = 'select';
  private row: SupabaseRow | null = null;

  constructor(private readonly table: TableName, private readonly db: Db) {}

  insert(row: SupabaseRow): this {
    this.mode = 'insert';
    this.row = { ...row };
    return this;
  }

  select(_columns: string): this {
    return this;
  }

  delete(): this {
    this.mode = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  private run(): SupabaseResult {
    const rows = this.db[this.table];
    if (this.mode === 'insert') {
      const row = this.row ?? {};
      const duplicate = rows.some((existing) =>
        this.table === 'agent_audit'
          ? existing.id === row.id ||
            (row.status === 'executed' &&
              row.idempotency_key != null &&
              existing.idempotency_key === row.idempotency_key &&
              existing.status === 'executed')
          : existing.token === row.token
      );
      if (duplicate) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
      }
      rows.push({ ...row });
      return { data: { ...row }, error: null };
    }

    const matches = (row: SupabaseRow) => this.filters.every(([c, v]) => row[c] === v);
    if (this.mode === 'delete') {
      const idx = rows.findIndex(matches);
      if (idx < 0) return { data: null, error: null };
      const [deleted] = rows.splice(idx, 1);
      return { data: { ...deleted }, error: null };
    }
    const found = rows.find(matches);
    return { data: found ? { ...found } : null, error: null };
  }

  maybeSingle(): PromiseLike<SupabaseResult> {
    return Promise.resolve(this.run());
  }

  then<TResult1 = SupabaseResult, TResult2 = never>(
    onfulfilled?: ((value: SupabaseResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

class FakeSupabase implements SupabaseLike {
  readonly db: Db = { agent_audit: [], agent_confirmation: [] };

  from(table: string): FakeQuery {
    return new FakeQuery(table as TableName, this.db);
  }
}

function pending(token: string, expiresAt: number): PendingConfirmation {
  return {
    token,
    toolName: 'send_telegram_notification',
    args: { text: 'halo' },
    description: 'send_telegram_notification(text="halo")',
    expiresAt,
  };
}

describe('SupabaseAuditSink', () => {
  it('append + findByIdempotencyKey menyimpan dan mengembalikan hasil yang lengkap', async () => {
    const fake = new FakeSupabase();
    const sink = createDurableAuditSink(fake as unknown as SupabaseLike);

    await sink.append(
      createAuditRecord({
        id: 'a1',
        correlationId: 'c1',
        chatId: '123',
        toolName: 'send_telegram_notification',
        args: { text: 'halo' },
        status: 'executed',
        idempotencyKey: 'key-1',
        detail: 'execute ok',
        durationMs: 7,
        result: { sent: true },
      })
    );

    expect(fake.db.agent_audit).toHaveLength(1);
    expect(fake.db.agent_audit[0]).toMatchObject({
      id: 'a1',
      correlation_id: 'c1',
      chat_id: '123',
      status: 'executed',
      idempotency_key: 'key-1',
    });
    const found = await sink.findByIdempotencyKey('key-1');
    expect(found).toMatchObject({
      id: 'a1',
      correlationId: 'c1',
      status: 'executed',
      toolName: 'send_telegram_notification',
      args: { text: 'halo' },
      result: { sent: true },
    });
  });

  it('hanya mencari baris executed dan menelan error append (best-effort)', async () => {
    const fake = new FakeSupabase();
    const sink = createDurableAuditSink(fake as unknown as SupabaseLike);
    const base = {
      id: 'a2',
      correlationId: 'c2',
      chatId: '123',
      toolName: 'send_telegram_notification',
      args: { text: 'halo' },
      idempotencyKey: 'key-2',
      detail: 'x',
      durationMs: 0,
    };

    await sink.append(createAuditRecord({ ...base, status: 'needs_confirmation' }));
    expect(await sink.findByIdempotencyKey('key-2')).toBeUndefined();

    const executed = createAuditRecord({ ...base, status: 'executed', result: { ok: true } });
    await sink.append(executed);
    // Duplicate executed key — unique index menolak, tetapi tidak boleh throw.
    await expect(sink.append({ ...executed, id: 'a3' })).resolves.toBeUndefined();
    expect((await sink.findByIdempotencyKey('key-2'))?.result).toEqual({ ok: true });
  });
});

describe('SupabaseConfirmationStore', () => {
  it('put/get/consume bekerja dan consume sekali pakai', async () => {
    const fake = new FakeSupabase();
    const store = new SupabaseConfirmationStore(fake as unknown as SupabaseLike);
    const entry = {
      pending: pending('tok-1', Date.now() + 60_000),
      question: 'analisis BTC',
      chatId: '123',
      toolName: 'send_telegram_notification',
      arguments: '{"text":"halo"}',
    };

    await store.put(entry);
    expect(fake.db.agent_confirmation).toHaveLength(1);
    expect(fake.db.agent_confirmation[0]).toMatchObject({
      token: 'tok-1',
      chat_id: '123',
      question: 'analisis BTC',
      tool_name: 'send_telegram_notification',
      arguments: '{"text":"halo"}',
    });

    const got = await store.get('tok-1');
    expect(got?.question).toBe('analisis BTC');
    expect(got?.chatId).toBe('123');
    expect(got?.arguments).toBe('{"text":"halo"}');
    expect(got?.pending.args).toEqual({ text: 'halo' });
    expect(got?.pending.description).toContain('send_telegram_notification');

    const consumed = await store.consume('tok-1');
    expect(consumed?.pending.token).toBe('tok-1');
    expect(await store.get('tok-1')).toBeUndefined();
    expect(await store.consume('tok-1')).toBeUndefined();
    expect(fake.db.agent_confirmation).toHaveLength(0);
  });

  it('menolak token kedaluwarsa', async () => {
    const fake = new FakeSupabase();
    const store = new SupabaseConfirmationStore(fake as unknown as SupabaseLike);
    await store.put({
      pending: pending('expired', Date.now() - 1_000),
      question: 'q',
      chatId: '123',
      toolName: 'send_telegram_notification',
      arguments: '{}',
    });
    expect(await store.get('expired')).toBeUndefined();
    expect(await store.consume('expired')).toBeUndefined();
  });
});

describe('InMemoryConfirmationStore', () => {
  it('menegakkan TTL pada get/consume dan consume hanya sekali', async () => {
    let now = 1_000;
    const store = new InMemoryConfirmationStore(() => now);
    await store.put({
      pending: pending('mem', 2_000),
      question: 'q',
      chatId: '123',
      toolName: 'send_telegram_notification',
      arguments: '{}',
    });

    expect((await store.get('mem'))?.question).toBe('q');
    now = 2_500;
    expect(await store.get('mem')).toBeUndefined();
    expect(await store.consume('mem')).toBeUndefined();

    now = 1_000;
    await store.put({
      pending: pending('mem2', 5_000),
      question: 'q2',
      chatId: '123',
      toolName: 'send_telegram_notification',
      arguments: '{}',
    });
    expect((await store.consume('mem2'))?.question).toBe('q2');
    expect(await store.consume('mem2')).toBeUndefined();
  });
});

describe('runAgent replayCall', () => {
  const CONTEXT = 'Regime risk on. SOLUSDT skor 81 dengan support 168.';
  const ANSWER =
    'Regime risk on, SOLUSDT skor 81 masih segar dengan support 168 sebagai pembatal.\n\n' +
    'Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri.';

  function writeTool(run: ToolDefinition['run']): ToolDefinition {
    return {
      name: 'send_telegram_notification',
      description: 'Kirim notifikasi',
      scope: 'write',
      params: { text: { type: 'string', description: 'pesan', required: true } },
      run,
    };
  }

  const policy: AgentPolicy = {
    maxSteps: 4,
    maxToolCalls: 3,
    allowedTools: ['send_telegram_notification'],
    requireConfirmationFor: ['send_telegram_notification'],
  };

  it('menjalankan persis satu tool yang dikonfirmasi tanpa meminta argumen ke LLM', async () => {
    const run = vi.fn(async () => ({ ok: true, data: { sent: true } }));
    const tool = writeTool(run);
    const llm = vi.fn(
      async (_messages: LLMMessage[], _tools: ToolDefinition[], _system?: string): Promise<LLMResponse> => ({
        content: ANSWER,
        toolCalls: [],
      })
    );
    const audit = new InMemoryAuditSink();
    const deps: AgentDeps = { llm, audit };
    const args = { text: 'halo' };
    const key = idempotencyKey('chat-1', tool.name, args);

    const result = await runAgent({
      question: 'kirim notifikasi',
      context: CONTEXT,
      tools: [tool],
      policy,
      deps,
      chatId: 'chat-1',
      confirmedKeys: new Set([key]),
      replayCall: {
        toolName: tool.name,
        arguments: JSON.stringify(args),
        confirmedKeys: new Set([key]),
      },
    });

    expect(result.outcome).toBe('answered');
    expect(result.toolCalls).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(args, expect.objectContaining({ chatId: 'chat-1' }));
    // LLM hanya dipanggil sekali untuk menyusun jawaban akhir.
    expect(llm).toHaveBeenCalledTimes(1);
    const messages = llm.mock.calls[0][0] as Array<{ role: string }>;
    expect(messages.some((m) => m.role === 'tool')).toBe(true);
    expect(audit.all().some((r) => r.status === 'executed')).toBe(true);
  });

  it('jatuh ke jalur LLM normal bila replay gagal', async () => {
    const run = vi.fn(async () => ({ ok: true, data: {} }));
    const tool = writeTool(run);
    const llm = vi.fn(
      async (_messages: LLMMessage[], _tools: ToolDefinition[], _system?: string): Promise<LLMResponse> => ({
        content: ANSWER,
        toolCalls: [],
      })
    );
    const audit = new InMemoryAuditSink();
    const deps: AgentDeps = { llm, audit };

    const result = await runAgent({
      question: 'kirim notifikasi',
      context: CONTEXT,
      tools: [tool],
      policy,
      deps,
      chatId: 'chat-1',
      replayCall: { toolName: tool.name, arguments: '{json rusak' },
    });

    expect(result.outcome).toBe('answered');
    expect(llm).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(audit.all().some((r) => r.status === 'rejected')).toBe(true);
  });
});
