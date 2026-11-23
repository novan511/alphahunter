/**
 * OpenAI-compatible chat call with tool/function calling.
 *
 * Separate from `callLLM()` on purpose: that one returns plain text only.
 * Provider notes: DeepSeek and the NVIDIA gateway both expose the
 * OpenAI-compatible `tools` field; a provider without it simply gets no tools
 * and the loop degrades to a single text answer.
 */

import { llmEnv } from '../quant/marketNarrator';
import type { LLMMessage, LLMResponse, ParamDef, ToolCall, ToolDefinition } from './types';

function jsonSchemaFor(param: ParamDef): Record<string, unknown> {
  if (param.type === 'string[]') {
    return { type: 'array', items: { type: 'string' }, description: param.description };
  }
  const schema: Record<string, unknown> = { type: param.type, description: param.description };
  if (param.enum) schema.enum = param.enum;
  if (param.min != null) schema.minimum = param.min;
  if (param.max != null) schema.maximum = param.max;
  return schema;
}

function toProviderMessages(messages: LLMMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls?.length) {
      base.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
    if (m.name) base.name = m.name;
    return base;
  });
}

function toolsForProvider(tools: ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.params).map(([name, def]) => [name, jsonSchemaFor(def)])
        ),
        required: Object.entries(t.params)
          .filter(([, def]) => def.required)
          .map(([name]) => name),
        additionalProperties: false,
      },
    },
  }));
}

export async function callLLMWithTools(
  messages: LLMMessage[],
  tools: ToolDefinition[],
  opts: { system?: string; maxTokens?: number } = {}
): Promise<LLMResponse> {
  const env = llmEnv();
  if (!env.configured) throw new Error('LLM_API_KEY belum diset');

  const res = await fetch(env.baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.model,
      messages: [
        { role: 'system', content: opts.system ?? '' },
        ...toProviderMessages(messages),
      ],
      tools: toolsForProvider(tools),
      tool_choice: 'auto',
      max_tokens: opts.maxTokens ?? env.maxTokens,
      temperature: 0.2,
      top_p: 0.9,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);

  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const msg = data.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? [])
    .filter((tc) => tc.function?.name)
    .map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: tc.function!.name as string,
      arguments: tc.function?.arguments || '{}',
    }));

  return {
    content: (msg?.content || msg?.reasoning_content || '').trim(),
    toolCalls,
    usage: {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    },
  };
}
