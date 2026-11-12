// 调用链路记录：每轮写一行 JSONL 到 traces/<sessionId>.jsonl
// 记录：用户输入 → 命中的 Skill → 每次工具调用（参数、耗时、成败、数据来源）→ 模型调用 → 最终回复 → 总耗时、成本
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

fs.mkdirSync(config.paths.traces, { recursive: true });

export class TurnTrace {
  constructor(sessionId, userInput, context) {
    this.sessionId = sessionId;
    this.data = {
      session: sessionId,
      turn_id: `${Date.now().toString(36)}`,
      started_at: new Date().toISOString(),
      provider: config.llm.provider === 'rule' ? 'rule' : config.llm.model,
      input: userInput,
      context,
      skills: [],
      steps: [],
      llm: { calls: 0, input_tokens: 0, output_tokens: 0, ms: 0 },
      tts: { calls: 0, chars: 0, cost_yuan: 0, cache_hits: 0 },
    };
    this.t0 = Date.now();
  }

  llmCall(ms, usage = {}) {
    const l = this.data.llm;
    l.calls++;
    l.ms += ms;
    l.input_tokens += usage.prompt_tokens || 0;
    l.output_tokens += usage.completion_tokens || 0;
    if (!this.data.first_llm_ms) this.data.first_llm_ms = ms;
  }

  tool(name, args, result, ms) {
    const ok = result?.ok !== false && !result?.error;
    const step = { tool: name, args, ok, ms, source: result?.source, summary: summarize(name, result) };
    if (!ok) step.error = result?.error;
    this.data.steps.push(step);
    if (name === 'load_skill' && ok && !this.data.skills.includes(args.name)) this.data.skills.push(args.name);
    if (name === 'tts_speak' && ok && result.url) {
      this.data.tts.calls++;
      if (result.cached) this.data.tts.cache_hits++;
      else {
        this.data.tts.chars += result.chars || 0;
        this.data.tts.cost_yuan += result.cost_yuan || 0;
      }
    }
    return step;
  }

  finish(reply, extra = {}) {
    const l = this.data.llm;
    const llmCost = (l.input_tokens / 1e6) * config.llm.priceInput + (l.output_tokens / 1e6) * config.llm.priceOutput;
    Object.assign(this.data, extra, {
      reply,
      total_ms: Date.now() - this.t0,
      cost_yuan: +(llmCost + this.data.tts.cost_yuan).toFixed(4),
      invalid_tool_calls: this.data.steps.filter((s) => !s.ok).length,
    });
    try {
      fs.appendFileSync(path.join(config.paths.traces, `${safe(this.sessionId)}.jsonl`), JSON.stringify(this.data) + '\n');
    } catch {}
    return this.data;
  }
}

const safe = (s) => String(s).replace(/[^\w-]/g, '_');

function summarize(name, r) {
  if (!r) return '';
  if (r.error) return `失败：${r.error}`;
  switch (name) {
    case 'load_skill': return `加载 ${r.name}（${r.files?.length || 0} 个附带文件）`;
    case 'read_skill_file': return `读取 ${r.path}（${r.content?.length || 0} 字）`;
    case 'amap_route': return `${r.legs?.length || 0} 段，共 ${r.total_minutes} 分钟${r.estimated ? '（含估算）' : ''}`;
    case 'amap_weather': return r.on_date ? `${r.on_date.date} ${r.on_date.day} ${r.on_date.low}~${r.on_date.high}℃` : r.note || '无预报';
    case 'amap_around_search':
    case 'amap_text_search': return `${r.pois?.length || 0} 个结果`;
    case 'tts_speak': return r.url ? (r.cached ? '命中缓存' : `合成 ${r.chars} 字`) : r.hit === false ? '缓存未命中' : '无音频';
    case 'save_plan': return r.saved ? `已保存（${r.validation?.ok ? '校验通过' : `${r.validation?.errors?.length} 个问题`}）` : `未保存：${r.validation?.errors?.map((e) => e.code).join(',') || r.error || ''}`;
    case 'propose_options': return `给出 ${r.count} 个方案，等待用户选择`;
    case 'ask_user': return '追问用户';
    default: return '';
  }
}

export function readTraces(sessionId) {
  try {
    return fs
      .readFileSync(path.join(config.paths.traces, `${safe(sessionId)}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
