/**
 * Klien DeepSeek terpisah untuk monitoring quant (backtest risk review,
 * supervisor insight). Tidak campur dengan analisis futures di
 * lib/quant/futuresAI.ts yang pakai gateway AntSeed via LLM_BASE_URL.
 */

export function deepseekEnv(): {
  apiKey: string;
  baseUrl: string;
  model: string;
  configured: boolean;
} {
  const baseUrl = (
    process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1/chat/completions'
  ).replace(/\/+$/, '');
  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  return { baseUrl, apiKey, model, configured: apiKey.length > 0 };
}

export async function callDeepseek(prompt: string): Promise<string> {
  const env = deepseekEnv();
  if (!env.configured) throw new Error('DEEPSEEK_API_KEY belum diset');
  const response = await fetch(env.baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      model: env.model,
      max_tokens: 700,
      temperature: 0.3,
      top_p: 0.9,
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`);
  }
  const result = await response.json();
  const text = result.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('DeepSeek mengembalikan kosong');
  return text;
}
