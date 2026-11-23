/**
 * Audit sink + confirmation store for agent tool calls.
 *
 * The core stays dependency-free and testable: both durable implementations
 * take a minimal injectable Supabase-like client. The `getDefault*()` helpers
 * resolve that client lazily at request time and fall back to module-level
 * in-memory stores when Supabase admin is not configured (e.g. in unit tests).
 */

import type {
  AuditRecord,
  AuditSink,
  AuditStatus,
  ConfirmationStore,
  PendingConfirmation,
  PendingRequestLike,
} from './types';
import { describeCall } from './schema';
import { getSupabaseAdmin } from '../supabaseAdmin';

const AUDIT_TABLE = 'agent_audit';
const CONFIRMATION_TABLE = 'agent_confirmation';

/** Minimal structural client — enough for the two agent tables, easy to fake. */
export type SupabaseRow = Record<string, unknown>;

export interface SupabaseResult {
  data: SupabaseRow | null;
  error: { message: string } | null;
}

export interface SupabaseFilter {
  eq(column: string, value: unknown): this;
  maybeSingle(): PromiseLike<SupabaseResult>;
}

export interface SupabaseMutateFilter extends SupabaseFilter, PromiseLike<SupabaseResult> {}

export interface SupabaseTable {
  insert(row: SupabaseRow): PromiseLike<SupabaseResult>;
  select(columns: string): SupabaseFilter;
  delete(): SupabaseMutateFilter;
}

export interface SupabaseLike {
  from(table: string): SupabaseTable;
}

export function createAuditRecord(fields: {
  id: string;
  correlationId: string;
  chatId: string;
  toolName: string | null;
  args: Record<string, unknown> | null;
  status: AuditRecord['status'];
  idempotencyKey?: string | null;
  detail: string;
  durationMs: number;
  result?: unknown;
}): AuditRecord {
  return {
    ts: new Date().toISOString(),
    idempotencyKey: null,
    ...fields,
  };
}

export class InMemoryAuditSink implements AuditSink {
  private records: AuditRecord[] = [];

  async append(record: AuditRecord): Promise<void> {
    this.records.push(record);
  }

  async findByIdempotencyKey(key: string): Promise<AuditRecord | undefined> {
    return this.records.find((r) => r.idempotencyKey === key && r.status === 'executed');
  }

  all(): AuditRecord[] {
    return [...this.records];
  }
}

function parseJson(value: unknown): unknown {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rowToAuditRecord(row: SupabaseRow): AuditRecord {
  return {
    id: String(row.id),
    ts: String(row.ts ?? new Date().toISOString()),
    correlationId: String(row.correlation_id ?? ''),
    chatId: String(row.chat_id ?? ''),
    toolName: row.tool_name == null ? null : String(row.tool_name),
    args: asObject(parseJson(row.args)),
    status: String(row.status) as AuditStatus,
    idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
    detail: String(row.detail ?? ''),
    durationMs: Number(row.duration_ms ?? 0),
    result: parseJson(row.result),
  };
}

/**
 * Durable audit sink. Appends are best-effort by design: a logging failure
 * must never break an agent turn, and a duplicate executed key is expected on
 * a retried webhook (the partial unique index rejects it for us).
 */
export class SupabaseAuditSink implements AuditSink {
  constructor(private readonly client: SupabaseLike) {}

  async append(record: AuditRecord): Promise<void> {
    try {
      const { error } = await this.client.from(AUDIT_TABLE).insert({
        id: record.id,
        ts: record.ts,
        correlation_id: record.correlationId,
        chat_id: record.chatId,
        tool_name: record.toolName,
        args: record.args ?? null,
        status: record.status,
        idempotency_key: record.idempotencyKey ?? null,
        detail: record.detail,
        duration_ms: record.durationMs,
        result: record.result ?? null,
      });
      if (error) return; // best-effort — never throw into the agent
    } catch {
      return;
    }
  }

  async findByIdempotencyKey(key: string): Promise<AuditRecord | undefined> {
    try {
      const { data, error } = await this.client
        .from(AUDIT_TABLE)
        .select('*')
        .eq('idempotency_key', key)
        .eq('status', 'executed')
        .maybeSingle();
      if (error || !data) return undefined;
      return rowToAuditRecord(data);
    } catch {
      return undefined;
    }
  }
}

export function createDurableAuditSink(client: SupabaseLike): AuditSink {
  return new SupabaseAuditSink(client);
}

function expiresAtFrom(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    return new Date(value).getTime();
  }
  return 0;
}

function rowToPendingRequest(row: SupabaseRow): PendingRequestLike {
  const toolName = String(row.tool_name ?? '');
  const raw =
    typeof row.arguments === 'string'
      ? row.arguments
      : JSON.stringify(asObject(parseJson(row.args)) ?? {});
  const args = asObject(parseJson(raw)) ?? {};
  const pending: PendingConfirmation = {
    token: String(row.token),
    toolName,
    args,
    // The durable row stores no description; rebuild it deterministically.
    description: describeCall(toolName, args),
    expiresAt: expiresAtFrom(row.expires_at),
    arguments: raw,
  };
  return {
    pending,
    question: String(row.question ?? ''),
    chatId: String(row.chat_id ?? ''),
    toolName,
    arguments: raw,
  };
}

function isLive(entry: PendingRequestLike, now: number): boolean {
  return entry.pending.expiresAt > now;
}

/** Durable confirmation store — token is single-use (row deleted on consume). */
export class SupabaseConfirmationStore implements ConfirmationStore {
  constructor(private readonly client: SupabaseLike) {}

  async put(entry: PendingRequestLike): Promise<void> {
    const pending = entry.pending;
    const rawArguments = entry.arguments ?? pending.arguments ?? JSON.stringify(pending.args ?? {});
    try {
      const { error } = await this.client.from(CONFIRMATION_TABLE).insert({
        token: pending.token,
        chat_id: entry.chatId,
        question: entry.question,
        tool_name: entry.toolName ?? pending.toolName,
        arguments: rawArguments,
        expires_at: new Date(pending.expiresAt).toISOString(),
      });
      if (error) return;
    } catch {
      return;
    }
  }

  async get(token: string): Promise<PendingRequestLike | undefined> {
    try {
      const { data, error } = await this.client
        .from(CONFIRMATION_TABLE)
        .select('*')
        .eq('token', token)
        .maybeSingle();
      if (error || !data) return undefined;
      const entry = rowToPendingRequest(data);
      return isLive(entry, Date.now()) ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  async consume(token: string): Promise<PendingRequestLike | undefined> {
    const entry = await this.get(token);
    if (!entry) return undefined;
    try {
      await this.client.from(CONFIRMATION_TABLE).delete().eq('token', token);
    } catch {
      // Delete failed: the TTL still bounds the token, and the webhook treats
      // the in-flight consume as authoritative.
    }
    return entry;
  }
}

export function createDurableConfirmationStore(client: SupabaseLike): ConfirmationStore {
  return new SupabaseConfirmationStore(client);
}

/**
 * In-memory fallback. TTL is enforced on both get and consume, and consume is
 * single-use. The synchronous helpers exist so transport adapters can keep
 * their small, purely synchronous exported helpers working.
 */
export class InMemoryConfirmationStore implements ConfirmationStore {
  private readonly entries = new Map<string, PendingRequestLike>();

  constructor(private readonly clock: () => number = Date.now) {}

  async put(entry: PendingRequestLike): Promise<void> {
    this.putSync(entry);
  }

  putSync(entry: PendingRequestLike): void {
    this.entries.set(entry.pending.token, entry);
  }

  async get(token: string): Promise<PendingRequestLike | undefined> {
    return this.getSync(token);
  }

  getSync(token: string, now: number = this.clock()): PendingRequestLike | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (!isLive(entry, now)) {
      this.entries.delete(token);
      return undefined;
    }
    return entry;
  }

  async consume(token: string): Promise<PendingRequestLike | undefined> {
    return this.consumeSync(token);
  }

  consumeSync(token: string, now: number = this.clock()): PendingRequestLike | undefined {
    const entry = this.getSync(token, now);
    if (!entry) return undefined;
    this.entries.delete(token);
    return entry;
  }
}

/**
 * Resolve the service-role client lazily at call time. Importing the module is
 * safe: getSupabaseAdmin() only reads env when invoked, so tests with no env
 * simply get null and fall back to the in-memory stores.
 */
function getAdminClient(): SupabaseLike | null {
  try {
    const client = getSupabaseAdmin();
    return client ? (client as unknown as SupabaseLike) : null;
  } catch {
    return null;
  }
}

let defaultAuditSink: AuditSink | undefined;
let defaultConfirmationStore: ConfirmationStore | undefined;

export function getDefaultAuditSink(): AuditSink {
  if (!defaultAuditSink) {
    const client = getAdminClient();
    defaultAuditSink = client ? new SupabaseAuditSink(client) : new InMemoryAuditSink();
  }
  return defaultAuditSink;
}

export function getDefaultConfirmationStore(): ConfirmationStore {
  if (!defaultConfirmationStore) {
    const client = getAdminClient();
    defaultConfirmationStore = client
      ? new SupabaseConfirmationStore(client)
      : new InMemoryConfirmationStore();
  }
  return defaultConfirmationStore;
}
