import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const minimaxKey = env.MINIMAX_API_KEY || '';
const llmKey = env.LLM_API_KEY || minimaxKey;

export const config = {
  port: Number(env.PORT || 3001),
  skillsDir: path.resolve(ROOT, env.SKILLS_DIR || '.trae/skills'),

  // 大模型：任何 OpenAI 兼容、支持 tool calling 的接口都可以（MiniMax / DeepSeek / 通义 / Kimi）。
  // 没配 key 时自动退回「规则基线」，方便没 key 也能演示和跑评测。
  llm: {
    provider: env.LLM_PROVIDER || (llmKey ? 'openai' : 'rule'),
    baseUrl: (env.LLM_BASE_URL || 'https://api.minimaxi.com/v1').replace(/\/$/, ''),
    apiKey: llmKey,
    model: env.LLM_MODEL || 'MiniMax-M2',
    temperature: Number(env.LLM_TEMPERATURE ?? 0.3),
    // 元 / 百万 token，用于估算单次会话成本。请按所用模型的官网价格修改。
    priceInput: Number(env.LLM_PRICE_INPUT ?? 2.1),
    priceOutput: Number(env.LLM_PRICE_OUTPUT ?? 8.4),
  },

  amap: {
    key: env.AMAP_KEY || '',
    // 高德 MCP（Streamable HTTP）。不填但有 key 时用官方地址。
    mcpUrl: env.AMAP_MCP_URL || (env.AMAP_KEY ? `https://mcp.amap.com/mcp?key=${env.AMAP_KEY}` : ''),
    timeoutMs: Number(env.AMAP_TIMEOUT_MS || 8000),
  },

  minimax: {
    apiKey: minimaxKey,
    groupId: env.MINIMAX_GROUP_ID || '',
    host: (env.MINIMAX_API_HOST || 'https://api.minimaxi.com').replace(/\/$/, ''),
    mcpUrl: env.MINIMAX_MCP_URL || '',
    voiceId: env.MINIMAX_VOICE_ID || 'female-chengshu',
    // 讲解用 hd（音质好），对话用 turbo（快、便宜）
    narrationModel: env.TTS_NARRATION_MODEL || 'speech-2.8-hd',
    chatModel: env.TTS_CHAT_MODEL || 'speech-2.8-turbo',
    // 元 / 万字符
    priceHd: Number(env.TTS_PRICE_HD ?? 3.5),
    priceTurbo: Number(env.TTS_PRICE_TURBO ?? 2),
  },

  agent: {
    maxSteps: Number(env.AGENT_MAX_STEPS || 12), // 每轮最多工具调用轮数，控成本
    keepTurns: Number(env.AGENT_KEEP_TURNS || 6), // 上下文里保留最近几轮
    maxPlanFixRounds: 2, // save_plan 校验失败后最多让模型改 2 轮
  },

  paths: {
    memory: path.join(ROOT, 'memory'),
    traces: path.join(ROOT, 'traces'),
    audioCache: path.join(ROOT, 'cache', 'audio'),
    cards: path.join(ROOT, 'cache', 'cards'),
  },
};

export function describeConfig() {
  return {
    llm: config.llm.provider === 'rule' ? '规则基线（未配置大模型）' : `${config.llm.model}`,
    llmProvider: config.llm.provider,
    amap: config.amap.mcpUrl ? '高德 MCP' : config.amap.key ? '高德 REST' : '离线缓存',
    tts: config.minimax.apiKey || config.minimax.mcpUrl ? 'MiniMax' : '未配置',
  };
}
