// Agent 主循环：模型决定加载哪个 Skill、调用哪些工具、什么时候停下来问用户。
// 每一步都通过 emit 推给前端（实时显示「思考过程」），并写入 trace。
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { buildSystemPrompt, todayInfo } from './prompt.mjs';
import { toolSchemas, runTool } from './tools/index.mjs';
import { applyChoice } from './tools/plan.mjs';
import { TurnTrace } from './trace.mjs';
import { createOpenAIProvider } from './providers/openai.mjs';
import { createRuleProvider } from './providers/rule.mjs';

const sessions = new Map();

export function getSession(id, userId = 'demo') {
  const sid = id || crypto.randomUUID();
  if (!sessions.has(sid)) {
    sessions.set(sid, {
      id: sid, userId, turns: [], plan: null, planHistory: [],
      pendingOptions: null, pendingAsk: null, approval: null, context: {},
    });
  }
  return sessions.get(sid);
}

export function resetSession(id) {
  sessions.delete(id);
}

export function makeProvider(name = config.llm.provider, opts) {
  return name === 'rule' ? createRuleProvider() : createOpenAIProvider(opts);
}

const stripThink = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
const clip = (obj, n = 12000) => {
  const s = JSON.stringify(obj);
  return s.length > n ? `${s.slice(0, n)}…（已截断）` : s;
};

function contextNote(ctx) {
  const bits = [];
  if (ctx.location) bits.push(`位置：${ctx.location}`);
  if (ctx.time) bits.push(`时间：${ctx.time}`);
  if (ctx.weather) bits.push(`天气：${ctx.weather}`);
  return bits.length ? `\n[情境] ${bits.join('；')}` : '';
}

/**
 * 运行一轮对话
 * input: { text, choice?: optionId, context?: {location,time,weather,today} }
 * emit(type, data): 推送事件
 */
export async function runTurn(session, input, emit = () => {}, opts = {}) {
  const provider = opts.provider || makeProvider();
  session.context = { ...(input.context || {}) };
  session.saveAttempts = 0;
  session.approval = null;

  const turnState = {};
  let text = (input.text || '').trim();
  if (input.choice) {
    const opt = applyChoice(session, input.choice);
    if (opt) {
      turnState.choiceOption = opt;
      text ||= `我选「${opt.title}」`;
    }
  }
  if (session.pendingAsk) {
    turnState.pendingAsk = session.pendingAsk;
    session.pendingAsk = null;
  }
  if (!text) text = '（空消息）';

  const trace = new TurnTrace(session.id, text, session.context);
  const system = buildSystemPrompt(session, turnState);
  const turn = [{ role: 'user', content: text + contextNote({ ...session.context, time: todayInfo(session.context).time }) }];
  const tools = toolSchemas();
  const ctx = { session, emit, trace };

  let final = '';
  let ended = false;
  let fellBack = false;
  let active = provider;

  for (let step = 0; step < config.agent.maxSteps && !ended; step++) {
    let resp;
    try {
      const history = session.turns.flat();
      resp = await active.chat({ messages: [{ role: 'system', content: system }, ...history, ...turn], tools, session, turn, turnState });
    } catch (e) {
      // 大模型不可用：本轮第一步就失败时，整轮退回规则基线，保证用户有回应
      if (step === 0 && active.name !== 'rule') {
        emit('notice', { text: `大模型暂不可用（${e.message}），本轮改用规则模式` });
        trace.data.llm_error = e.message;
        active = createRuleProvider();
        fellBack = true;
        step--;
        continue;
      }
      final = `抱歉，我这边出了点问题（${e.message}），可以再说一次吗？`;
      break;
    }
    trace.llmCall(resp.ms, resp.usage);
    const msg = resp.message;
    turn.push(msg);

    if (!msg.tool_calls?.length) {
      final = msg.content;
      break;
    }
    if (stripThink(msg.content)) emit('thinking', { text: stripThink(msg.content) });

    for (const tc of msg.tool_calls) {
      let args = {};
      let result;
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        result = { ok: false, error: '参数不是合法 JSON' };
      }
      emit('tool_start', { name: tc.function.name, args });
      const t0 = Date.now();
      result ||= await runTool(tc.function.name, args, ctx);
      const stepInfo = trace.tool(tc.function.name, args, result, Date.now() - t0);
      emit('tool_end', stepInfo);
      if (tc.function.name === 'load_skill' && result.ok) emit('skill', { name: result.name });
      turn.push({ role: 'tool', tool_call_id: tc.id, content: clip(result) });
      if (result.end_turn) ended = true;
    }
    if (ended) {
      const lastTool = trace.data.steps.at(-1)?.tool;
      final =
        stripThink(msg.content) ||
        (lastTool === 'ask_user'
          ? session.pendingAsk?.questions.map((q) => q.question).join(' ')
          : session.pendingOptions
            ? `${session.pendingOptions.reason}。我准备了 ${session.pendingOptions.options.length} 个方案，你选一个，我再改行程。`
            : '');
      turn.push({ role: 'assistant', content: final });
    }
  }
  if (!final) final = '这件事有点复杂，我先停在这里。可以换个说法，或者拆成小一点的问题再问我。';

  // 记录这轮的追问，下一轮用户回答时接得上
  if (session.pendingAsk && !session.pendingAsk.request) {
    session.pendingAsk.request = turnState.text || text;
    session.pendingAsk.intent = turnState.askIntent;
  }

  // 只保留最近几轮，控制上下文长度
  session.turns.push(turn);
  if (session.turns.length > config.agent.keepTurns) session.turns = session.turns.slice(-config.agent.keepTurns);

  const display = stripThink(final);
  emit('reply', { text: display });
  const data = trace.finish(display, {
    intent: turnState.intent,
    ended_with: ended ? trace.data.steps.at(-1)?.tool : 'reply',
    fell_back_to_rule: fellBack,
    plan_version: session.plan?.version || null,
  });
  emit('done', { trace: data });
  return { reply: display, trace: data };
}
