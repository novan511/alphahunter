/**
 * Core types for the agentic runtime.
 *
 * Deliberately dependency-free and transport-agnostic: nothing here knows
 * about Telegram, Next.js, or Supabase. The Telegram webhook is one adapter;
 * tests inject fake LLMs and fake tools through `AgentDeps`.
 */

export type ToolScope = 'read' | 'write';
export type ParamType = 'string' | 'number' | 'boolean' | 'string[]';

export interface ParamDef {
  type: ParamType;
  description: string;
  required?: boolean;
  enum?: string[];
  min?: number;
  max?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** `write` tools need a confirmation token before they can execute. */
  scope: ToolScope;
  params: Record<string, ParamDef>;
  timeoutMs?: number;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
}

export interface ToolContext {
  chatId: string;
  correlationId: string;
  dryRun: boolean;
}

export interface ToolOutcome {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Human-readable description of the side effect, returned by write tools. */
  preview?: string;
}

/** Normalised tool call — the LLM adapter converts provider-specific shapes. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string from the model; validated before execution. */
  arguments: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface AgentPolicy {
  maxSteps: number;
  maxToolCalls: number;
  allowedTools?: string[];
  /** When true, no tool can write — all write tools are forced into dry-run. */
  dryRun?: boolean;
  /** Tool names that always require an explicit confirmation token. */
  requireConfirmationFor?: string[];
}

export type AuditStatus =
  | 'executed'
  | 'dry_run'
  | 'cached'
  | 'rejected'
  | 'failed'
  | 'needs_confirmation';

export interface AuditRecord {
  id: string;
  ts: string;
  correlationId: string;
  chatId: string;
  toolName: string | null;
  args: Record<string, unknown> | null;
  status: AuditStatus;
  idempotencyKey: string | null;
  detail: string;
  durationMs: number;
  /** Stored so an idempotent retry can replay the original result. */
  result?: unknown;
}

export interface AuditSink {
  append(record: AuditRecord): Promise<void>;
  findByIdempotencyKey(key: string): Promise<AuditRecord | undefined>;
}

export interface PendingConfirmation {
  token: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  expiresAt: number;
  /** Raw JSON string as produced by the model. Optional for older callers. */
  arguments?: string;
}

/**
 * Shape persisted by the confirmation store. Mirrors the Telegram adapter's
 * `{ pending, question, chatId }` plus the exact tool name and the raw
 * argument string, so /confirm can replay the very same call instead of
 * asking the model to choose its arguments again.
 */
export interface PendingRequestLike {
  pending: PendingConfirmation;
  question: string;
  chatId: string;
  toolName?: string;
  arguments?: string;
}

/** Durable (Supabase) or in-memory store for pending confirmations. */
export interface ConfirmationStore {
  put(entry: PendingRequestLike): Promise<void>;
  get(token: string): Promise<PendingRequestLike | undefined>;
  /** Single-use: a consumed token must never be returned again. */
  consume(token: string): Promise<PendingRequestLike | undefined>;
}

export interface AgentDeps {
  llm: (messages: LLMMessage[], tools: ToolDefinition[], system?: string) => Promise<LLMResponse>;
  audit: AuditSink;
  now?: () => number;
  id?: () => string;
}

export type AgentOutcome = 'answered' | 'needs_confirmation' | 'budget_exceeded' | 'error';

/** Coarse session state, exposed for tracing and UI. */
export type AgentState = 'idle' | 'tool_use' | 'awaiting_confirmation' | 'composing' | 'done' | 'blocked';

export interface AgentResult {
  answer: string;
  outcome: AgentOutcome;
  state: AgentState;
  steps: number;
  toolCalls: number;
  audit: AuditRecord[];
  pendingConfirmation?: PendingConfirmation;
  usage?: { promptTokens?: number; completionTokens?: number };
}
