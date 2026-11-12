// OpenAI 兼容的 tool calling 接口：MiniMax / DeepSeek / 通义千问 / Kimi 都可以直接用。
// 换模型只改 .env 里的 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY，评测时可以对比不同模型。
import { config } from '../config.mjs';
import { withTimeout } from '../mcp-client.mjs';

export function createOpenAIProvider(opts = {}) {
  const c = { ...config.llm, ...opts };
  return {
    name: c.model,
    async chat({ messages, tools }) {
      const t0 = Date.now();
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await withTimeout(
            fetch(`${c.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
              body: JSON.stringify({ model: c.model, messages, tools, tool_choice: 'auto', temperature: c.temperature }),
            }),
            90000,
            '大模型响应超时',
          );
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || data.error || data?.base_resp?.status_code) {
            throw new Error(data?.error?.message || data?.base_resp?.status_msg || `HTTP ${resp.status}`);
          }
          const m = data.choices?.[0]?.message;
          if (!m) throw new Error('模型返回为空');
          const message = { role: 'assistant', content: m.content || '' };
          if (m.tool_calls?.length) {
            message.tool_calls = m.tool_calls.map((tc, i) => ({
              id: tc.id || `call_${Date.now()}_${i}`,
              type: 'function',
              function: { name: tc.function?.name, arguments: tc.function?.arguments || '{}' },
            }));
          }
          return { message, usage: data.usage || {}, ms: Date.now() - t0 };
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    },
  };
}
