#!/usr/bin/env node
// 评测：跑 evals/cases.jsonl 里的每条用例，按「路由 / 交互 / 行程 / 约束 / 讲解」打分，
// 输出 Markdown 报告到 evals/results/，方便做「修复前后对比」。
//
// 用法：
//   npm run eval                 # 用 .env 里配置的模型
//   npm run eval:rule            # 用规则基线
//   node evals/run_evals.mjs --only P01,P08 --judge
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../server/config.mjs';
import { getSession, runTurn, makeProvider } from '../server/agent.mjs';
import { confirmPlan } from '../server/tools/plan.mjs';
import { deleteProfile, updateProfile } from '../server/memory.mjs';
import { validatePlan } from '../.trae/skills/trip-planner/scripts/validate_plan.mjs';
import { findSpot } from '../.trae/skills/trip-planner/scripts/spots.mjs';
import { createOpenAIProvider } from '../server/providers/openai.mjs';
import { closeAllMcp } from '../server/mcp-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TODAY = '2026-11-12';
const args = process.argv.slice(2);
const arg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const providerName = arg('--provider') || config.llm.provider;
const only = arg('--only')?.split(',');
const judge = args.includes('--judge');

const cases = fs
  .readFileSync(path.join(here, 'cases.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((c) => !only || only.includes(c.id));

const kbDir = path.join(config.skillsDir, 'spot-narrator/references/narration-kb');
const KB_TEXT = fs.readdirSync(kbDir).map((f) => fs.readFileSync(path.join(kbDir, f), 'utf8')).join('\n');

const norm = (n) => findSpot(n)?.name || n;
const includesAny = (s, arr) => arr.some((x) => String(s).includes(x));

function check(bucket, name, pass, detail = '') {
  return { bucket, name, pass: !!pass, detail };
}

async function runCase(c, provider) {
  const userId = `eval-${c.id}`;
  deleteProfile(userId);
  if (c.memory) updateProfile(userId, c.memory);
  const session = getSession(`eval-${c.id}-${Date.now()}`, userId);
  const checks = [];
  const traces = [];
  const versions = [];
  let narration = null;

  for (const [i, t] of c.turns.entries()) {
    const ctx = { today: TODAY, ...(t.context || {}) };
    const { reply, trace } = await runTurn(session, { text: t.user || '', choice: t.choice, context: ctx }, () => {}, { provider });
    traces.push(trace);
    if (t.confirm_after) confirmPlan(session);
    versions.push(session.plan?.version || 0);
    if (trace.skills.includes('spot-narrator')) narration = reply;

    const e = t.expect || {};
    const tools = trace.steps.map((s) => s.tool);
    const tag = `T${i + 1}`;
    if (e.skill) {
      const ok = e.skill === 'none' ? trace.skills.length === 0 : trace.skills.includes(e.skill);
      checks.push(check('routing', `${tag} 路由到 ${e.skill}`, ok, `实际：${trace.skills.join(',') || 'none'}`));
    }
    if (e.ends_with) checks.push(check('interaction', `${tag} 以 ${e.ends_with} 结束`, trace.ended_with === e.ends_with, `实际：${trace.ended_with}`));
    if (e.ask_count_max) {
      const asks = trace.steps.filter((s) => s.tool === 'ask_user');
      const n = asks.reduce((m, s) => Math.max(m, s.args?.questions?.length || 0), 0);
      checks.push(check('interaction', `${tag} 追问 ≤ ${e.ask_count_max} 个问题且只问一次`, asks.length <= 1 && n <= e.ask_count_max, `问了 ${asks.length} 次，${n} 个问题`));
    }
    if (e.tools_any) checks.push(check('constraint', `${tag} 调用了 ${e.tools_any.join('/')}`, e.tools_any.some((x) => tools.includes(x)), `实际：${tools.join(',')}`));
    if (e.tools_none) checks.push(check('constraint', `${tag} 没有调用 ${e.tools_none.join('/')}`, !e.tools_none.some((x) => tools.includes(x)), `实际：${tools.join(',')}`));
    if (e.reply_any) checks.push(check('constraint', `${tag} 回复包含 ${e.reply_any.join('/')}`, includesAny(reply, e.reply_any), reply.slice(0, 80)));
    if (e.reply_none) checks.push(check('constraint', `${tag} 回复不含 ${e.reply_none.join('/')}`, !includesAny(reply, e.reply_none), reply.slice(0, 80)));
  }

  const f = c.final || {};
  if (f.plan) {
    const p = session.plan;
    const v = p ? validatePlan(p) : null;
    const names = p ? p.stops.map((s) => norm(s.name)) : [];
    if (f.plan.executable) checks.push(check('plan', '行程可执行（校验通过）', v?.ok, v ? v.errors.map((e) => e.code).join(',') : '没有行程'));
    if (f.plan.max_walk_km) checks.push(check('constraint', `步行 ≤ ${f.plan.max_walk_km} km`, v && v.stats.walk_km <= f.plan.max_walk_km, `实际 ${v?.stats.walk_km}`));
    if (f.plan.exclude) {
      const bad = f.plan.exclude.filter((x) => names.includes(x));
      checks.push(check('constraint', `不含 ${f.plan.exclude.join('/')}`, p && !bad.length, bad.join(',')));
    }
    if (f.plan.include) {
      const miss = f.plan.include.filter((x) => !names.includes(x));
      checks.push(check('constraint', `包含 ${f.plan.include.join('/')}`, p && !miss.length, miss.join(',')));
    }
    if (f.plan.date) checks.push(check('constraint', `日期为 ${f.plan.date}`, p?.date === f.plan.date, `实际 ${p?.date}`));
    if (f.plan.min_stops) checks.push(check('constraint', `至少 ${f.plan.min_stops} 站`, names.length >= f.plan.min_stops, `实际 ${names.length}`));
    if (f.plan.status) checks.push(check('interaction', `行程状态为 ${f.plan.status}`, p?.status === f.plan.status, `实际 ${p?.status}`));
    if (f.plan.unchanged_since_turn) {
      const before = versions[f.plan.unchanged_since_turn - 1];
      checks.push(check('interaction', `第 ${f.plan.unchanged_since_turn} 轮后行程未被擅自修改`, (p?.version || 0) === before, `版本 ${before} → ${p?.version}`));
    }
    if (f.plan.changed_since_turn) {
      const before = versions[f.plan.changed_since_turn - 1];
      checks.push(check('interaction', `用户同意后行程已更新`, (p?.version || 0) > before, `版本 ${before} → ${p?.version}`));
    }
    if (f.plan.weather_has) checks.push(check('constraint', `行程记录了天气「${f.plan.weather_has}」`, String(p?.weather || '').includes(f.plan.weather_has), `实际 ${p?.weather}`));
  }
  if (f.narration) {
    const text = narration || '';
    if (f.narration.traceable_numbers) {
      const nums = (text.match(/\d+/g) || []).filter((n) => !KB_TEXT.includes(n));
      checks.push(check('fact', '讲解里的数字都能在知识卡里找到', !nums.length, nums.length ? `无出处：${nums.join(',')}` : `${(text.match(/\d+/g) || []).length} 个数字均可溯源`));
    }
    if (f.narration.min_len) checks.push(check('constraint', `讲解 ${f.narration.min_len}–${f.narration.max_len} 字`, text.length >= f.narration.min_len && text.length <= f.narration.max_len, `实际 ${text.length} 字`));
  }

  let judgeScore = null;
  if (judge && narration && narration.length > 100 && config.llm.apiKey) judgeScore = await judgeNarration(narration, c);

  const totalMs = traces.reduce((s, t) => s + t.total_ms, 0);
  return {
    id: c.id,
    persona: c.persona,
    scenario: c.scenario,
    note: c.note,
    pass: checks.every((x) => x.pass),
    checks,
    judge: judgeScore,
    turns: traces.length,
    turn_ms: traces.map((t) => t.total_ms),
    first_llm_ms: traces.map((t) => t.first_llm_ms || 0),
    total_ms: totalMs,
    cost_yuan: +traces.reduce((s, t) => s + t.cost_yuan, 0).toFixed(4),
    tool_calls: traces.reduce((s, t) => s + t.steps.length, 0),
    // 语音没配置导致的失败属于环境问题，不算 Agent 的无效调用
    invalid_tool_calls: traces.reduce((s, t) => s + t.steps.filter((x) => !x.ok && !(x.tool === 'tts_speak' && /语音暂不可用/.test(x.error || ''))).length, 0),
    fell_back: traces.some((t) => t.fell_back_to_rule),
  };
}

async function judgeNarration(text, c) {
  const p = createOpenAIProvider();
  const rubric = `你是导游讲解质检员。按 1–5 分给下面这段讲解打分，只输出 JSON：{"score":数字,"reason":"一句话"}。
评分细则：5=口语化、贴合听众（${c.persona}）、结尾有可执行建议、没有可疑事实；3=基本可用但书面化或不贴合听众；1=有明显编造或不适合口播。`;
  try {
    const r = await p.chat({ messages: [{ role: 'system', content: rubric }, { role: 'user', content: text }] });
    const m = r.message.content.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

const rate = (arr) => (arr.length ? `${Math.round((arr.filter(Boolean).length / arr.length) * 100)}%` : '-');
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};

async function main() {
  const provider = makeProvider(providerName);
  const label = providerName === 'rule' ? 'rule' : config.llm.model;
  console.log(`\n▶ 评测 ${cases.length} 条用例，模型：${label}\n`);
  const results = [];
  for (const c of cases) {
    const r = await runCase(c, provider);
    results.push(r);
    const failed = r.checks.filter((x) => !x.pass);
    console.log(`${r.pass ? '✅' : '❌'} ${c.id.padEnd(4)} ${c.persona}·${c.scenario}·${c.note}${failed.length ? `\n      ${failed.map((x) => `✕ ${x.name}（${x.detail}）`).join('\n      ')}` : ''}`);
  }

  const all = results.flatMap((r) => r.checks);
  const by = (b) => all.filter((x) => x.bucket === b).map((x) => x.pass);
  const turnMs = results.flatMap((r) => r.turn_ms);
  const llmMs = results.flatMap((r) => r.first_llm_ms).filter(Boolean);
  const judged = results.filter((r) => r.judge?.score);
  const metrics = {
    用例通过率: rate(results.map((r) => r.pass)),
    'Skill 路由正确率': rate(by('routing')),
    '交互正确率（追问/确认/不擅自改）': rate(by('interaction')),
    行程可执行率: rate(by('plan')),
    约束满足率: rate(by('constraint')),
    讲解数字可溯源率: rate(by('fact')),
    '平均无效工具调用（次/用例）': (results.reduce((s, r) => s + r.invalid_tool_calls, 0) / results.length).toFixed(2),
    '平均工具调用（次/用例）': (results.reduce((s, r) => s + r.tool_calls, 0) / results.length).toFixed(1),
    '单轮耗时 P50 / P95（ms）': `${pct(turnMs, 50)} / ${pct(turnMs, 95)}`,
    '首次模型响应 P50（ms）': llmMs.length ? pct(llmMs, 50) : '-',
    '平均会话成本（元）': (results.reduce((s, r) => s + r.cost_yuan, 0) / results.length).toFixed(4),
    ...(judged.length ? { '讲解质量（LLM 评分，1–5）': (judged.reduce((s, r) => s + r.judge.score, 0) / judged.length).toFixed(2) } : {}),
    ...(results.some((r) => r.fell_back) ? { 降级到规则的用例数: results.filter((r) => r.fell_back).length } : {}),
  };

  console.log('\n── 指标 ──');
  for (const [k, v] of Object.entries(metrics)) console.log(`${k.padEnd(24)} ${v}`);

  const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const base = path.join(here, 'results', `${stamp}-${label.replace(/[^\w.-]/g, '_')}`);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.writeFileSync(`${base}.json`, JSON.stringify({ provider: label, run_at: new Date().toISOString(), metrics, results }, null, 2));
  const md = [
    `# 评测报告 · ${label}`,
    '',
    `- 时间：${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')}（北京时间）`,
    `- 用例：${results.length} 条（evals/cases.jsonl）`,
    `- 数据源：地图 ${config.amap.mcpUrl ? '高德 MCP' : config.amap.key ? '高德 REST' : '离线缓存'}，语音 ${config.minimax.apiKey ? 'MiniMax' : '未配置'}`,
    '',
    '## 指标',
    '',
    '| 指标 | 值 |',
    '|---|---|',
    ...Object.entries(metrics).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## 用例明细',
    '',
    '| 用例 | 人群 | 场景 | 说明 | 结果 | 未通过的检查 |',
    '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.persona} | ${r.scenario} | ${r.note} | ${r.pass ? '✅' : '❌'} | ${r.checks.filter((x) => !x.pass).map((x) => `${x.name}（${x.detail}）`).join('<br>').replace(/\|/g, '/')} |`),
    '',
    '## Bad case 归因（人工填写）',
    '',
    '| 用例 | 归因类别（意图识别 / 工具参数 / 数据 / 生成内容） | 怎么修（改 description / 改 SKILL.md / 补知识库 / 加校验） | 修复后是否通过 |',
    '|---|---|---|---|',
    ...results.filter((r) => !r.pass).map((r) => `| ${r.id} |  |  |  |`),
    '',
  ].join('\n');
  fs.writeFileSync(`${base}.md`, md);
  console.log(`\n报告：${path.relative(process.cwd(), base)}.md\n`);
  await closeAllMcp();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
