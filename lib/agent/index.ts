/**
 * Public entry point for the agentic runtime.
 *
 * Import from here, not from individual files, so the transport layer never
 * depends on internal module layout.
 */

export { runAgent, DEFAULT_POLICY, AGENT_INSTRUCTIONS, finalAnswerIssues } from './loop';
export type { RunAgentOptions } from './loop';
export { callLLMWithTools } from './llm';
export { executeToolCall } from './executor';
export type { ExecuteOptions, ExecuteResult } from './executor';
export { validateToolArgs, idempotencyKey, describeCall } from './schema';
export {
  InMemoryAuditSink,
  createAuditRecord,
  SupabaseAuditSink,
  createDurableAuditSink,
  InMemoryConfirmationStore,
  SupabaseConfirmationStore,
  createDurableConfirmationStore,
  getDefaultAuditSink,
  getDefaultConfirmationStore,
} from './audit';
export type { SupabaseLike, SupabaseRow, SupabaseTable } from './audit';
export { MARKET_TOOLS, READ_ONLY_TOOLS, AGENT_POLICY } from './tools';
export type {
  AgentDeps,
  AgentPolicy,
  AgentResult,
  AgentOutcome,
  AgentState,
  AuditRecord,
  AuditSink,
  AuditStatus,
  ConfirmationStore,
  PendingRequestLike,
  LLMMessage,
  LLMResponse,
  ParamDef,
  ParamType,
  PendingConfirmation,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolOutcome,
  ToolScope,
} from './types';
