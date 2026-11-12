// 行程状态与「人机边界」：这里是代码层面的硬约束，不靠 prompt。
// - save_plan 一定先跑校验脚本；校验失败最多让模型改 2 轮
// - 已确认的行程，没有用户的选择（approval）就不能改
// - propose_options / ask_user 会结束本轮，等用户回答
import { validatePlan } from '../../.trae/skills/trip-planner/scripts/validate_plan.mjs';
import { config } from '../config.mjs';
import { markersUrl, locateLocal } from './amap.mjs';

const toMin = (t) => {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

export function currentStopIndex(plan, time) {
  if (!plan?.stops?.length || !time) return -1;
  const t = toMin(time);
  let idx = -1;
  plan.stops.forEach((s, i) => {
    if (toMin(s.arrive) <= t) idx = i;
  });
  return idx;
}

export function planSummary(session) {
  const p = session.plan;
  if (!p) return '暂无行程';
  const stops = p.stops.map((s, i) => `${i + 1}.${s.arrive} ${s.name}`).join('  ');
  return `《${p.title}》${p.date || ''}，状态：${p.status === 'confirmed' ? '已确认（修改需用户选择）' : '草稿（可直接修改）'}，第 ${p.version} 版。${stops}`;
}

function enrich(plan) {
  const places = plan.stops.map((s) => {
    const fromLeg = plan.legs?.find((l) => l.to === s.name)?.to_location || plan.legs?.find((l) => l.from === s.name)?.from_location;
    const loc = s.location || fromLeg || locateLocal(s.name);
    return { name: s.name, location: loc || null };
  });
  return { ...plan, stops: plan.stops.map((s, i) => ({ ...s, location: places[i].location })), amap_markers_url: markersUrl(places) };
}

export function savePlan(session, plan, emit) {
  if (!plan || !Array.isArray(plan.stops)) return { ok: false, saved: false, error: 'plan.stops 不能为空，格式见 trip-planner 的 SKILL.md' };

  const confirmed = session.plan?.status === 'confirmed';
  if (confirmed && !session.approval) {
    return {
      ok: false,
      saved: false,
      error: '这份行程用户已经确认过。修改前必须征得同意：请调用 propose_options，给出「修改后的方案」和「保持原样」两个选项，等用户选择。',
    };
  }
  if (session.approval && session.approval.optionId === 'keep') {
    return { ok: false, saved: false, error: '用户选择了保持原样，不要修改行程。' };
  }

  if (!plan.weather && session.context?.weather) plan.weather = session.context.weather;
  const validation = validatePlan(plan);
  session.saveAttempts = (session.saveAttempts || 0) + 1;

  if (!validation.ok && session.saveAttempts <= config.agent.maxPlanFixRounds) {
    return {
      ok: true,
      saved: false,
      validation,
      message: `校验未通过（第 ${session.saveAttempts} 次）。请按 errors 修改行程后再次调用 save_plan；最多再改 ${config.agent.maxPlanFixRounds - session.saveAttempts + 1} 次。`,
    };
  }

  const saved = enrich({
    ...plan,
    status: confirmed ? 'confirmed' : 'draft',
    version: (session.plan?.version || 0) + 1,
    validation,
    unresolved: !validation.ok,
    saved_at: new Date().toISOString(),
  });
  if (session.plan) session.planHistory.push(session.plan);
  session.plan = saved;
  session.approval = null;
  emit?.('plan', saved);
  return {
    ok: true,
    saved: true,
    version: saved.version,
    status: saved.status,
    validation,
    ...(validation.ok ? {} : { message: '已保存，但仍有未满足的校验项，请在回复里如实告诉用户' }),
  };
}

export function proposeOptions(session, { reason, options = [] }, emit) {
  if (options.length < 2 || options.length > 3) return { ok: false, error: '请给 2–3 个方案' };
  const ids = new Set();
  const normalized = options.map((o, i) => {
    const id = o.id || String.fromCharCode(65 + i);
    ids.add(id);
    const out = { id, title: o.title || `方案${id}`, summary: o.summary || '' };
    if (o.plan?.stops) {
      const plan = { party: session.plan?.party, date: session.plan?.date, title: session.plan?.title, ...o.plan };
      if (!plan.weather && session.context?.weather) plan.weather = session.context.weather;
      out.plan = plan;
      out.validation = validatePlan(plan);
    }
    return out;
  });
  if (ids.size !== normalized.length) return { ok: false, error: '方案 id 重复' };
  session.pendingOptions = { reason, options: normalized, created_at: Date.now() };
  emit?.('options', session.pendingOptions);
  return { ok: true, count: normalized.length, end_turn: true, message: '已把方案展示给用户，本轮到此结束，等待用户选择。' };
}

export function askUser(session, { questions = [] }, emit, skill) {
  const qs = questions.slice(0, 2).map((q) => ({ question: q.question, options: (q.options || []).slice(0, 4) }));
  if (!qs.length) return { ok: false, error: 'questions 不能为空' };
  session.pendingAsk = { questions: qs, skill };
  emit?.('ask', { questions: qs });
  return { ok: true, end_turn: true, message: '问题已展示给用户，本轮结束。' };
}

/** 用户点了某个方案按钮：把选择变成本轮的 approval */
export function applyChoice(session, optionId) {
  const pending = session.pendingOptions;
  if (!pending) return null;
  const opt = pending.options.find((o) => o.id === optionId);
  if (!opt) return null;
  session.approval = { optionId: opt.id, option: opt };
  session.pendingOptions = null;
  return opt;
}

export function confirmPlan(session) {
  if (!session.plan) return { ok: false, error: '还没有行程' };
  session.plan.status = 'confirmed';
  return { ok: true, plan: session.plan };
}
