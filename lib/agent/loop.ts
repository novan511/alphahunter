/**
 * Agent loop: LLM → tool calls → observations → LLM → final answer.
 *
 * The loop is intentionally small and readable. Every tool call goes through
 * `executeToolCall` (validation, idempotency, confirmation, audit). The final
 * text is checked against the same production guardrails used by the chatbot.
 */

import { FORBIDDEN, isKnownNumber, numbersIn } from '../quant/marketNarrator';
import { TELEGRAM_SYSTEM_PROMPT } from '../telegramPersona';
import { buildAskPrompt } from '../telegramAskPrompt';
import { createAuditRecord } from './audit';
import { executeToolCall } from './executor';
import type {
  AgentDeps,
  AgentPolicy,
  AgentResult,
  AuditRecord,
  LLMMessage,
  ToolCall,
  ToolDefinition,
} from './types';

const AGENT_INSTRUCTIONS = `

KAMU ADALAH AGENT, BUKAN SEKADAR PENJAWAB:
- Kamu punya tools. Pakai tool untuk mengambil data atau melakukan aksi — jangan mengarang hasilnya.
- Tool bertanda tulisan (write) MENUNGGU konfirmasi pengguna. Jangan mengklaim sudah berhasil sebelum dikonfirmasi.
- Maksimal beberapa langkah. Kalau tool gagal, katakan terus terang dan berikan alternatif dari data yang ada.
- Angka yang kamu sebut harus berasal dari konteks atau hasil tool, bukan ingatan.
- Tetap teks biasa, tetap akhiri dengan disclaimer.`;

export interface RunAgentOptions {
  question: string;
  context: string;
  memory?: string;
  tools: ToolDefinition[];
  policy: AgentPolicy;
  deps: AgentDeps;
  chatId: string;
  confirmedKeys?: Set<string>;
  dryRun?: boolean;
  systemPrompt?: string;
  /**
   * Replay one already-confirmed call verbatim on the first loop iteration.
   * The model is not asked to re-pick arguments (that could change the
   * idempotency key and deny the write the user just approved); it only
   * composes the final answer afterwards.
   */
  replayCall?: { toolName: string; arguments: string; confirmedKeys?: Set<string> };
}

export const DEFAULT_POLICY: AgentPolicy = {
  maxSteps: 4,
  maxToolCalls: 3,
  dryRun: false,
  requireConfirmationFor: [],
};

function finalAnswerIssues(
  answer: string,
  context: string,
  extraNumbers: number[] = []
): string[] {
  const issues: string[] = [];
  const banned = FORBIDDEN.filter(({ re }) => re.test(answer)).map(({ label }) => label);
  if (banned.length) issues.push(`frasa terlarang: ${banned.join(', ')}`);

  // Observations from tools are legitimate number sources, not hallucinations.
  const known = [...numbersIn(context), ...extraNumbers];
  const unknown = Array.from(new Set(numbersIn(answer))).filter((n) => !isKnownNumber(n, known));
  if (unknown.length) issues.push(`angka di luar konteks: ${unknown.join(', ')}`);

  const lower = answer.toLowerCase();
  if (!lower.includes('bukan saran finansial') || !lower.includes('konfirmasi dan risiko tanggung sendiri')) {
    issues.push('disclaimer belum ada');
  }
  if (/[{}]/.test(answer) || /```/.test(answer)) issues.push('ada artefak JSON/kode');
  return issues;
}

const SAFE_FALLBACK =
  'Aku belum bisa menyimpulkan dengan aman dari data yang ada. Coba sebutkan koin atau timeframe yang spesifik, atau jalankan scan dulu dari web.\n\nBukan saran finansial. Konfirmasi dan risiko tanggung sendiri.';

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const now = opts.deps.now ?? Date.now;
  const id = opts.deps.id ?? (() => `ev_${Math.random().toString(36).slice(2)}`);
  const correlationId = id();
  const confirmedKeys = opts.confirmedKeys ?? new Set<string>();
  const tools = opts.tools.filter(
    (t) => !opts.policy.allowedTools || opts.policy.allowedTools.includes(t.name)
  );
  const audit: AuditRecord[] = [];
  let toolCalls = 0;
  let steps = 0;
  let correctionUsed = false;
  let usage: AgentResult['usage'];

  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: buildAskPrompt({
        memory: opts.memory ?? '',
        context: opts.context,
        question: opts.question,
      }),
    },
  ];

  const addAudit = async (status: AuditRecord['status'], detail: string) => {
    const record = createAuditRecord({
      id: id(),
      correlationId,
      chatId: opts.chatId,
      toolName: null,
      args: null,
      status,
      detail,
      durationMs: 0,
    });
    audit.push(record);
    await opts.deps.audit.append(record);
  };

  let replayAttempted = false;
  for (let step = 0; step < opts.policy.maxSteps; step++) {
    steps = step + 1;

    // Exact replay: execute the one call the user approved, then let the LLM
    // compose the answer from the observation. Nothing here is inferred by
    // the model, so the idempotency key stays identical to the /agent turn.
    if (!replayAttempted && opts.replayCall) {
      replayAttempted = true;
      const replay = opts.replayCall;
      if (toolCalls >= opts.policy.maxToolCalls) {
        await addAudit('rejected', 'replay tool call terlampaui');
      } else {
        if (replay.confirmedKeys) replay.confirmedKeys.forEach((key) => confirmedKeys.add(key));
        // A replay must remain allowed even if the session policy is narrower.
        const replayPolicy: AgentPolicy =
          opts.policy.allowedTools && !opts.policy.allowedTools.includes(replay.toolName)
            ? { ...opts.policy, allowedTools: [...opts.policy.allowedTools, replay.toolName] }
            : opts.policy;
        const call: ToolCall = {
          id: `replay_${correlationId}`,
          name: replay.toolName,
          arguments: replay.arguments,
        };
        const result = await executeToolCall({
          call,
          // Use the unfiltered tool list here: replayPolicy above decides what
          // is allowed, so the executor's whitelist check still applies.
          tools: opts.tools,
          policy: replayPolicy,
          chatId: opts.chatId,
          correlationId,
          audit: opts.deps.audit,
          confirmedKeys,
          dryRun: opts.dryRun,
          now,
          id,
        });
        audit.push(result.record);
        if (result.kind !== 'error') {
          toolCalls += 1;
          messages.push({ role: 'assistant', content: '', tool_calls: [call] });
          messages.push({
            role: 'tool',
            content: result.content,
            tool_call_id: call.id,
            name: call.name,
          });
          if (result.kind === 'confirmation') {
            return {
              answer: result.content,
              outcome: 'needs_confirmation',
              state: 'awaiting_confirmation',
              steps,
              toolCalls,
              audit,
              pendingConfirmation: result.pending,
              ...(usage ? { usage } : {}),
            };
          }
          // `tool_use` observation is now in `messages`; the next iteration
          // moves to composing the final answer.
          continue;
        }
        // Replay failed — fall through to the normal LLM path this iteration.
      }
    }

    const response = await opts.deps.llm(
      messages,
      tools,
      opts.systemPrompt ?? TELEGRAM_SYSTEM_PROMPT + AGENT_INSTRUCTIONS
    );
    if (response.usage) usage = response.usage;

    if (response.toolCalls.length > 0) {
      // Only accept as many calls as the budget allows. Every accepted call
      // must get a matching `tool` message, otherwise the provider rejects
      // the next request for having incomplete tool-call/response pairs.
      const remaining = opts.policy.maxToolCalls - toolCalls;
      if (remaining <= 0) {
        await addAudit('rejected', 'budget tool call terlampaui');
        break;
      }
      const acceptedCalls = response.toolCalls.slice(0, remaining);

      const assistantMessage: LLMMessage = {
        role: 'assistant',
        content: response.content,
        tool_calls: acceptedCalls,
      };
      messages.push(assistantMessage);

      for (const call of acceptedCalls) {
        toolCalls += 1;
        const result = await executeToolCall({
          call,
          tools,
          policy: opts.policy,
          chatId: opts.chatId,
          correlationId,
          audit: opts.deps.audit,
          confirmedKeys,
          dryRun: opts.dryRun,
          now,
          id,
        });
        audit.push(result.record);
        messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: call.id,
          name: call.name,
        });

        if (result.kind === 'confirmation') {
          return {
            answer: result.content,
            outcome: 'needs_confirmation',
            state: 'awaiting_confirmation',
            steps,
            toolCalls,
            audit,
            pendingConfirmation: result.pending,
            ...(usage ? { usage } : {}),
          };
        }
      }
      continue;
    }

    const toolNumbers = messages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => numbersIn(m.content));
    const issues = finalAnswerIssues(response.content, opts.context, toolNumbers);
    if (issues.length === 0 && response.content.length >= 40) {
      return {
        answer: response.content,
        outcome: 'answered',
        state: 'done',
        steps,
        toolCalls,
        audit,
        ...(usage ? { usage } : {}),
      };
    }

    if (!correctionUsed && response.content.length > 0) {
      correctionUsed = true;
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: `Jawabanmu ditolak oleh guardrail: ${issues.join('; ') || 'terlalu pendek'}. Tulis ulang sebagai teks biasa, angka hanya dari konteks hasil tool, dan akhiri dengan disclaimer.`,
      });
      await addAudit('rejected', `guardrail final: ${issues.join('; ') || 'terlalu pendek'}`);
      continue;
    }

    await addAudit('failed', 'jawaban akhir tidak lulus guardrail setelah koreksi');
    return {
      answer: SAFE_FALLBACK,
      outcome: 'error',
      state: 'blocked',
      steps,
      toolCalls,
      audit,
      ...(usage ? { usage } : {}),
    };
  }

  await addAudit('rejected', 'step budget terlampaui');
  return {
    answer:
      'Aku sudah mencoba beberapa langkah tapi belum tuntas. Persempit pertanyaannya atau jalankan scan dulu ya.\n\nBukan saran finansial. Konfirmasi dan risiko tanggung sendiri.',
    outcome: 'budget_exceeded',
    state: 'blocked',
    steps,
    toolCalls,
    audit,
    ...(usage ? { usage } : {}),
  };
}

/** Exported for tests and for the offline evaluator. */
export { AGENT_INSTRUCTIONS, finalAnswerIssues };
