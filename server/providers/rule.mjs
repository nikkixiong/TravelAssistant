// 规则基线 Provider：用确定性的规则模拟「模型选 Skill、选工具」的过程。
// - 没配大模型 key 时自动启用，保证课堂演示和评测能跑
// - 它和大模型走的是同一套工具、同一套 Skill 文件、同一份 trace，
//   评测时可以直接对比「规则路由」和「大模型路由」的效果
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { loadSpots, findSpot, haversineM, parseMarkdownTable } from '../../.trae/skills/trip-planner/scripts/spots.mjs';
import { walkLimitFor } from '../../.trae/skills/trip-planner/scripts/validate_plan.mjs';
import { loadRestaurants } from '../tools/amap.mjs';
import { getProfile } from '../memory.mjs';
import { currentStopIndex } from '../tools/plan.mjs';
import { todayInfo } from '../prompt.mjs';
import { detectIntent, extractParty, extractPrefs, extractDate, extractInterests, mentionedSpots, ordinalIndex } from './nlu.mjs';

let seq = 0;
const call = (name, args = {}) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id: `rule_${Date.now()}_${seq++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const reply = (content) => ({ role: 'assistant', content });

const toMin = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const up5 = (m) => Math.ceil(m / 5) * 5;
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 从本轮消息里取出已调用过的工具结果 */
function turnResults(turn) {
  const calls = {};
  const byId = {};
  for (const m of turn) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) byId[tc.id] = { name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}') };
    }
    if (m.role === 'tool') {
      const c = byId[m.tool_call_id];
      if (!c) continue;
      let result;
      try {
        result = JSON.parse(m.content);
      } catch {
        result = { raw: m.content };
      }
      (calls[c.name] ||= []).push({ args: c.args, result });
    }
  }
  const last = (n) => calls[n]?.at(-1)?.result;
  const has = (n, pred = () => true) => (calls[n] || []).some((c) => pred(c.args, c.result));
  return { calls, last, has };
}

export function createRuleProvider() {
  return {
    name: 'rule',
    async chat({ turn, session, turnState }) {
      const t0 = Date.now();
      const message = decide(turn, session, turnState);
      return { message, usage: {}, ms: Date.now() - t0 };
    },
  };
}

function decide(turn, session, st) {
  const userText = turn[0].content.split('\n[情境]')[0];
  const R = turnResults(turn);
  const ctx = session.context || {};

  if (!st.intent) {
    if (st.choiceOption) st.intent = 'apply_choice';
    else if (st.pendingAsk?.request) {
      st.intent = st.pendingAsk.intent || 'plan';
      st.text = `${st.pendingAsk.request}；${userText}`;
    } else st.intent = detectIntent(userText, { hasPlan: !!session.plan });
    st.text ||= userText;
  }
  const text = st.text;

  // 用户透露了长期偏好 → 先记下来（对话类意图才记）
  if (['plan', 'food', 'narrate', 'replan', 'plan_edit'].includes(st.intent) && !R.has('memory_update')) {
    const patch = extractPrefs(text);
    if (Object.keys(patch).length) return call('memory_update', { patch });
  }

  switch (st.intent) {
    case 'apply_choice': return applyChoice(st, R);
    case 'plan': return planFlow(text, session, st, R, ctx);
    case 'plan_edit': return editFlow(text, session, st, R, ctx);
    case 'replan': return replanFlow(text, session, st, R, ctx);
    case 'narrate': return narrateFlow(text, session, st, R, ctx);
    case 'food': return foodFlow(text, session, st, R, ctx);
    case 'recap': return recapFlow(session, R);
    case 'export': return exportFlow(session, R);
    case 'info': return infoFlow(text, R);
    case 'booking':
      return reply('买票、下单、叫车这些涉及付款的事，我不替你操作，需要你自己在官方渠道确认。我可以帮你把行程排好，到时候直接打开景区官方小程序或高德地图办理就行。');
    case 'safety':
      return reply('这个我不太建议：夜里爬山和极端天气出门风险比较大，山路照明差、容易滑倒。换成白天去，或者今天先安排室内的地方，我可以帮你重新排。');
    case 'chitchat':
      return reply('好的～有需要随时叫我：排行程、讲解景点、找吃的、临时改计划都可以。');
    default:
      if (!R.has('ask_user')) {
        return call('ask_user', { questions: [{ question: '想让我帮你做什么？', options: ['排一份行程', '讲讲眼前的景点', '找附近吃的', '行程要调整'] }] });
      }
      return reply('想让我帮你做什么？');
  }
}

// ───────────────────── 行程规划 ─────────────────────
function scoreSpot(s, f) {
  const base = { 断桥残雪: 10, 雷峰塔: 9, 灵隐寺: 8, 白堤: 8, 岳王庙: 7, 苏堤春晓: 7, 花港观鱼: 6, 三潭印月: 5, 河坊街: 6, 平湖秋月: 5, 浙江省博物馆孤山馆区: 4, 中国茶叶博物馆: 4, 中国丝绸博物馆: 3, 杭州博物馆: 3, 曲院风荷: 4, 孤山: 4, 太子湾公园: 3, 净慈寺: 3, 湖滨步行街: 3, 龙井村: 4 }[s.name] ?? 0;
  let sc = base;
  if (f.rain) sc += s.indoor === '是' ? 8 : s.indoor === '部分' ? 2 : -4;
  if (f.slow && s.stairs === '少') sc += 1;
  if (f.slow && /电梯/.test(s.note)) sc += 2;
  if (f.kids && s.kid_friendly) sc += 2;
  if (f.interests.includes('tea') && /茶|龙井/.test(s.name)) sc += 6;
  if (f.interests.includes('temple') && /寺/.test(s.name)) sc += 6;
  if (f.interests.includes('history') && (/博物馆|庙|印社/.test(s.name))) sc += 4;
  if (f.interests.includes('photo') && /清晨|傍晚|夕照/.test(s.best_time)) sc += 3;
  return sc;
}

function selectSpots(f) {
  const weekday = WEEK[new Date(`${f.date}T12:00:00Z`).getUTCDay()];
  const far = ['西溪国家湿地公园', '宋城', '九溪烟树', '六和塔', '城隍阁'];
  const ok = (s) =>
    !(s.closed_day && s.closed_day.includes(weekday)) &&
    !((f.mobility === 'knee' || f.mobility === 'wheelchair') && s.stairs === '多') &&
    !f.excluded.includes(s.name);
  const explicit = f.explicit.filter(ok);
  const pool = loadSpots().filter((s) => ok(s) && !far.includes(s.name) && !explicit.some((e) => e.name === s.name));
  const n = f.student ? 6 : f.elderly || f.kids ? 4 : 5;
  const picked = [...explicit, ...pool.sort((a, b) => scoreSpot(b, f) - scoreSpot(a, f))].slice(0, Math.max(n, explicit.length));
  return orderSpots(picked);
}

/** 最近邻排序：从离湖滨最近的点出发；有灵隐就从灵隐开始（早去人少） */
function orderSpots(spots) {
  const rest = [...spots];
  const hubin = { lng: 120.164, lat: 30.259 };
  let cur = rest.find((s) => s.name === '灵隐寺') || rest.sort((a, b) => haversineM(hubin, a.location) - haversineM(hubin, b.location))[0];
  const out = [];
  while (cur) {
    out.push(cur);
    rest.splice(rest.indexOf(cur), 1);
    const from = cur.location;
    cur = rest.sort((a, b) => haversineM(from, a.location) - haversineM(from, b.location))[0];
  }
  return out;
}

function pickRestaurant(near, f, avoidNames = []) {
  const avoidSpicy = (f.food_avoid || []).includes('辣');
  return loadRestaurants()
    .filter((r) => !avoidNames.includes(r.name) && !/茶馆/.test(r.type))
    .filter((r) => !(avoidSpicy && /辣/.test(r.taste)))
    .filter((r) => !(f.elderly && /排队/.test(r.note)))
    .map((r) => ({ ...r, d: haversineM(near.location, r.location) + (f.elderly && /长辈/.test(r.suits) ? -300 : 0) }))
    .sort((a, b) => a.d - b.d)[0];
}

/** 把景点序列变成带午饭的站点序列（还没有时间） */
function withLunch(spots, f, start) {
  const seq = [];
  let t = start;
  let lunched = false;
  for (const s of spots) {
    const dur = up5(s.duration_min * (f.slow ? 1.2 : 1));
    if (!lunched && t >= 11 * 60 + 20 && seq.length) {
      const prev = findSpot(seq.at(-1).name);
      const r = pickRestaurant(prev, f);
      if (r) seq.push({ name: r.name, type: 'meal', duration: f.slow ? 80 : 60, note: '午饭+休息' });
      t += f.slow ? 80 : 60;
      lunched = true;
    }
    seq.push({ name: s.name, type: 'spot', duration: dur, note: noteFor(s, f) });
    t += dur + 20;
  }
  return seq;
}

function noteFor(s, f) {
  const bits = [];
  if (s.reservation) bits.push('需提前预约/购票');
  if (f.slow && /电梯/.test(s.note)) bits.push('有电梯，不用爬楼');
  if (f.photo && s.best_time) bits.push(`最佳：${s.best_time}`);
  if (f.rain && s.indoor === '是') bits.push('室内，下雨也能逛');
  return bits.join('；');
}

/** 用路线结果排时间 */
function schedule(seq, legs, start) {
  let t = start;
  const stops = [];
  seq.forEach((s, i) => {
    if (i > 0) t = up5(t + (legs[i - 1]?.duration_min || 15));
    const spot = s.type === 'spot' ? findSpot(s.name) : null;
    if (spot && t < toMin(spot.hours.open)) t = toMin(spot.hours.open);
    stops.push({ name: s.name, arrive: fmt(t), leave: fmt(t + s.duration), type: s.type, ...(s.note ? { note: s.note } : {}) });
    t += s.duration;
  });
  return stops;
}

function planFacts(text, session, ctx) {
  const prof = getProfile(session.userId);
  const party = extractParty(text);
  const today = todayInfo(ctx).date;
  const elderly = party.elderly ?? prof.elderly ?? 0;
  const kids = party.kids ?? prof.kids ?? 0;
  const mobility = party.mobility || prof.mobility || (elderly ? null : 'normal');
  return {
    today,
    date: extractDate(text, today),
    elderly,
    kids,
    mobility,
    slow: elderly > 0 || mobility === 'knee' || mobility === 'wheelchair',
    student: party.student,
    interests: extractInterests(text),
    photo: /拍照|出片/.test(text) || (prof.interests || []).includes('拍照'),
    explicit: mentionedSpots(text.replace(/西湖/g, '')),
    excluded: [],
    food_avoid: prof.food_avoid || [],
  };
}

function planFlow(text, session, st, R, ctx) {
  if (!R.has('load_skill', (a) => a.name === 'trip-planner')) return call('load_skill', { name: 'trip-planner' });
  if (!R.has('memory_get')) return call('memory_get');

  st.f ||= planFacts(text, session, ctx);
  const f = st.f;

  // 追问：只问不问就会排错的，最多 2 个，只问一次
  if (!st.pendingAsk && !R.has('ask_user')) {
    const qs = [];
    if (!f.date) qs.push({ question: '哪天出发？', options: ['今天', '明天', '这周六', '这周日'] });
    if (f.elderly && !f.mobility) qs.push({ question: '长辈走路怎么样？', options: ['走得动', '膝盖不好，少走路', '需要轮椅'] });
    if (qs.length) {
      st.askIntent = 'plan';
      return call('ask_user', { questions: qs });
    }
  }
  const assumptions = [];
  if (!f.date) {
    f.date = f.today;
    assumptions.push('日期按今天排');
  }
  if (!f.mobility) {
    f.mobility = 'normal';
    assumptions.push('同行人走路没问题');
  }

  if (!R.has('read_skill_file', (a) => /hangzhou-spots/.test(a.path))) return call('read_skill_file', { skill: 'trip-planner', path: 'references/hangzhou-spots.md' });
  if (!R.has('amap_weather')) return call('amap_weather', { date: f.date });
  if (f.rain === undefined) {
    const w = R.last('amap_weather');
    f.weatherText = w?.user_reported_now || w?.on_date?.day || '';
    f.rain = /雨/.test(f.weatherText);
    if (!w?.on_date && !w?.user_reported_now) assumptions.push('天气未知，按晴天排');
  }
  st.assumptions ||= ['从湖滨附近出发', ...(f.slow ? ['远的路段打车，近的步行'] : ['公交+步行为主']), ...assumptions];

  const startDefault = f.date === f.today && ctx.time && toMin(ctx.time) > 9 * 60 ? up5(toMin(ctx.time) + 15) : 9 * 60;
  return buildAndSave(session, st, R, f, startDefault, () => withLunch(selectSpots(f), f, startDefault));
}

function partyOf(f) {
  return { adults: 1, elderly: f.elderly || 0, kids: f.kids || 0, mobility: f.mobility || 'normal' };
}

/** 选点 → 算路线 → 排时间 → 保存；校验失败按错误调整，最多改 2 轮 */
function buildAndSave(session, st, R, f, start, makeSeq) {
  st.seq ||= makeSeq();
  const routeCalls = R.calls.amap_route || [];
  const lastRoute = routeCalls.at(-1);
  const names = st.seq.map((s) => s.name);
  if (!lastRoute || JSON.stringify(lastRoute.args.points) !== JSON.stringify(names)) {
    return call('amap_route', { points: names, mode: f.transitOnly ? 'transit' : 'auto', party: partyOf(f) });
  }
  const legs = lastRoute.result.legs || [];
  const stops = schedule(st.seq, legs, start);

  // 收尾太晚：去掉最后一个非指定景点
  if (toMin(stops.at(-1).leave) > 18 * 60 && st.seq.filter((s) => s.type === 'spot').length > 2) {
    const idx = st.seq.findLastIndex((s) => s.type === 'spot' && !f.explicit.some((e) => e.name === s.name));
    if (idx >= 0) {
      st.seq.splice(idx, 1);
      return call('amap_route', { points: st.seq.map((s) => s.name), mode: 'auto', party: partyOf(f) });
    }
  }

  const plan = {
    title: titleFor(f),
    date: f.date,
    party: partyOf(f),
    max_walk_km: walkLimitFor(partyOf(f)),
    ...(f.weatherText ? { weather: f.weatherText } : {}),
    assumptions: st.assumptions,
    stops,
    legs: legs.map(({ nav_url, source, ...l }) => ({ ...l, nav_url })),
  };

  const saves = R.calls.save_plan || [];
  const lastSave = saves.at(-1);
  if (!lastSave || (lastSave.result.saved === false && st.fixedFor !== saves.length)) {
    if (lastSave && !lastSave.result.saved && lastSave.result.validation) {
      // 按校验错误修改
      st.fixedFor = saves.length;
      const changed = fixByErrors(st, f, lastSave.result.validation.errors);
      if (changed) return call('amap_route', { points: st.seq.map((s) => s.name), mode: 'auto', party: partyOf(f) });
    }
    if (!lastSave) return call('save_plan', { plan });
    if (lastSave.result.error) return reply(`行程没保存成功：${lastSave.result.error}`);
    return call('save_plan', { plan });
  }
  const res = lastSave.result;
  return reply(planReply(session.plan || plan, res, f));
}

function fixByErrors(st, f, errors = []) {
  let changed = false;
  for (const e of errors) {
    if (['E_HOURS', 'E_CLOSED', 'E_STAIRS'].includes(e.code) && e.stop) {
      const i = st.seq.findIndex((s) => s.name === e.stop);
      if (i >= 0) {
        st.seq.splice(i, 1);
        f.excluded.push(e.stop);
        changed = true;
      }
    }
    if (e.code === 'E_WALK') {
      // 去掉步行量最大的非指定景点
      const cands = st.seq
        .map((s, i) => ({ s, i, km: findSpot(s.name)?.walk_km || 0 }))
        .filter((x) => x.s.type === 'spot' && !f.explicit.some((ex) => ex.name === x.s.name));
      const worst = cands.sort((a, b) => b.km - a.km)[0];
      if (worst && st.seq.filter((s) => s.type === 'spot').length > 2) {
        st.seq.splice(worst.i, 1);
        changed = true;
      } else {
        f.transitOnly = true;
        changed = true;
      }
    }
    if (e.code === 'E_RAIN') {
      const i = st.seq.findIndex((s) => s.type === 'spot' && findSpot(s.name)?.indoor === '否');
      const indoor = loadSpots().find((s) => s.indoor === '是' && !st.seq.some((x) => x.name === s.name) && !f.excluded.includes(s.name));
      if (i >= 0 && indoor) {
        st.seq[i] = { name: indoor.name, type: 'spot', duration: up5(indoor.duration_min * (f.slow ? 1.2 : 1)), note: '室内，下雨也能逛' };
        st.seq = reorder(st.seq);
        changed = true;
      }
    }
  }
  return changed;
}

function reorder(seq) {
  const meal = seq.find((s) => s.type === 'meal');
  const spots = orderSpots(seq.filter((s) => s.type === 'spot').map((s) => findSpot(s.name)).filter(Boolean));
  const out = spots.map((sp) => seq.find((s) => s.name === sp.name));
  if (meal) out.splice(Math.min(2, out.length), 0, meal);
  return out;
}

function titleFor(f) {
  const day = f.date === f.today ? '今天' : `${f.date.slice(5).replace('-', '月')}日`;
  const who = f.elderly ? '（带爸妈）' : f.kids ? '（亲子）' : f.student ? '（特种兵）' : '';
  return `${day}西湖${f.slow ? '慢游' : '一日游'}${who}`;
}

function planReply(plan, res, f) {
  const lines = plan.stops.map((s) => `- ${s.arrive} ${s.name}${s.note ? `（${s.note}）` : ''}`).join('\n');
  const v = res.validation || {};
  const walk = v.stats?.walk_km != null ? `全天步行约 ${v.stats.walk_km} 公里（上限 ${v.stats.walk_limit_km}）` : '';
  const est = plan.legs?.some((l) => l.estimated) ? '，路线时长为估算' : '';
  const unresolved = res.validation && !res.validation.ok ? `\n\n⚠️ 还有没满足的地方：${res.validation.errors.map((e) => e.msg).join('；')}` : '';
  const warns = v.warnings?.length ? `\n\n提醒：${v.warnings.map((w) => w.msg).join('；')}` : '';
  const rain = f?.rain ? '当天有雨，我把室内的地方排多了一些。' : '';
  return `排好了！${rain}${walk}${est}。\n\n${lines}\n\n我假设了：${plan.assumptions.join('、')}，不对可以直接告诉我改。${warns}${unresolved}`;
}

// ───────────────────── 局部修改 ─────────────────────
function editFlow(text, session, st, R, ctx) {
  if (!R.has('load_skill', (a) => a.name === 'trip-planner')) return call('load_skill', { name: 'trip-planner' });
  const plan = session.plan;
  if (!st.seq) {
    const seq = plan.stops.map((s) => ({ name: s.name, type: s.type || 'spot', duration: toMin(s.leave) - toMin(s.arrive), note: s.note }));
    const mentioned = mentionedSpots(text);
    const inPlan = mentioned.filter((m) => seq.some((s) => findSpot(s.name)?.name === m.name));
    const newOnes = mentioned.filter((m) => !inPlan.includes(m));
    let idx = ordinalIndex(text);
    if (idx < 0 && inPlan.length) idx = seq.findIndex((s) => findSpot(s.name)?.name === inPlan[0].name);
    const prof = getProfile(session.userId);
    const slow = (plan.party?.elderly || 0) > 0 || plan.party?.mobility === 'knee';
    const mk = (sp) => ({ name: sp.name, type: 'spot', duration: up5(sp.duration_min * (slow ? 1.2 : 1)) });

    if (/去掉|删掉|不去/.test(text) && idx >= 0) {
      st.change = `去掉「${seq[idx].name}」`;
      seq.splice(idx, 1);
    } else if (/(换成|改成|换掉)/.test(text) && idx >= 0 && newOnes[0]) {
      st.change = `把第 ${idx + 1} 站「${seq[idx].name}」换成「${newOnes[0].name}」`;
      seq[idx] = mk(newOnes[0]);
    } else if (/加/.test(text) && newOnes[0]) {
      // 插到离它最近的一站后面
      const sp = newOnes[0];
      let best = seq.length - 1;
      let bd = Infinity;
      seq.forEach((s, i) => {
        const loc = findSpot(s.name)?.location;
        if (loc) {
          const d = haversineM(loc, sp.location);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      });
      st.change = `在「${seq[best].name}」后面加上「${sp.name}」`;
      seq.splice(best + 1, 0, mk(sp));
    } else {
      return reply('我没太听明白要怎么改。可以这样说：「把第二站换成灵隐寺」「去掉雷峰塔」「加上河坊街」。');
    }
    st.seq = seq;
    st.f = {
      today: todayInfo(ctx).date, date: plan.date, elderly: plan.party?.elderly || 0, kids: plan.party?.kids || 0,
      mobility: plan.party?.mobility || 'normal', slow, explicit: [], excluded: [], food_avoid: prof.food_avoid || [], interests: [],
    };
  }
  const f = st.f;
  const names = st.seq.map((s) => s.name);
  const lastRoute = R.calls.amap_route?.at(-1);
  if (!lastRoute || JSON.stringify(lastRoute.args.points) !== JSON.stringify(names)) {
    return call('amap_route', { points: names, mode: 'auto', party: plan.party });
  }
  const legs = lastRoute.result.legs || [];
  const newPlan = {
    ...stripPlan(plan),
    stops: schedule(st.seq, legs, toMin(plan.stops[0].arrive)),
    legs: legs.map(({ source, ...l }) => l),
  };

  // 已确认的行程：只给选项，让用户点头
  if (plan.status === 'confirmed') {
    if (!R.has('propose_options')) {
      const oldEnd = plan.stops.at(-1).leave;
      return call('propose_options', {
        reason: `行程已经确认过，${st.change}需要你点头`,
        options: [
          { id: 'A', title: '按你说的改', summary: `${st.change}，结束时间 ${oldEnd} → ${newPlan.stops.at(-1).leave}`, plan: newPlan },
          { id: 'keep', title: '保持原样', summary: '不改，按原计划走' },
        ],
      });
    }
    return reply(`${st.change}会影响后面的时间，我列了两个选项，你选一下。`);
  }

  const lastSave = R.calls.save_plan?.at(-1);
  if (!lastSave) return call('save_plan', { plan: newPlan });
  if (lastSave.result.saved) {
    return reply(`改好了：${st.change}，其他站没动。现在 ${session.plan.stops.map((s) => `${s.arrive} ${s.name}`).join(' → ')}。`);
  }
  // 校验没过：尊重用户的明确要求，不自动改，把冲突讲清楚
  const errs = lastSave.result.validation?.errors?.map((e) => e.msg).join('；') || lastSave.result.error;
  return reply(`这样改有问题：${errs}。要不换一个地方？比如雷峰塔有电梯，或者茶叶博物馆基本是平路。`);
}

const stripPlan = ({ validation, status, version, saved_at, amap_markers_url, unresolved, ...p }) => ({
  ...p,
  stops: p.stops.map(({ location, ...s }) => s),
});

// ───────────────────── 应急调整 ─────────────────────
function rainyMap() {
  if (rainyMap.cache) return rainyMap.cache;
  const rows = parseMarkdownTable(
    // 读同一份 references 文件，保持「数据在 Skill 里」
    require_('replan/references/rainy-day-options.md'),
  );
  const m = {};
  for (const r of rows) {
    const repl = r['雨天替换'].split('/')[0].trim();
    for (const n of r['原景点（户外）'].split('/')) m[n.trim()] = repl;
  }
  return (rainyMap.cache = m);
}
function require_(rel) {
  return fs.readFileSync(path.join(config.skillsDir, rel), 'utf8');
}

function replanFlow(text, session, st, R, ctx) {
  if (!R.has('load_skill', (a) => a.name === 'replan')) return call('load_skill', { name: 'replan' });
  const plan = session.plan;
  const rain = /雨/.test(text) || /雨/.test(ctx.weather || '');
  const tired = /累|走不动|腿疼|脚疼|膝盖疼|太晒|好晒|太热|好热/.test(text);
  if (!plan) {
    if (!R.has('ask_user')) {
      st.askIntent = 'plan';
      return call('ask_user', {
        questions: [{ question: rain ? '现在还没有行程。要不要我按雨天给你排一份？' : '现在还没有行程。要不要我帮你排一份轻松点的？', options: ['好，帮我排一份', '先不用'] }],
      });
    }
    return reply('好的。');
  }
  if (!R.has('get_plan')) return call('get_plan');
  if (rain && !R.has('read_skill_file')) return call('read_skill_file', { skill: 'replan', path: 'references/rainy-day-options.md' });
  if (tired && !R.has('memory_get')) return call('memory_get');

  if (!st.options) {
    const now = ctx.time ? toMin(ctx.time) : null;
    let cur = currentStopIndex(plan, ctx.time);
    const locSpot = ctx.location ? findSpot(ctx.location) : null;
    if (locSpot) {
      const i = plan.stops.findIndex((s) => findSpot(s.name)?.name === locSpot.name);
      if (i >= 0) cur = i;
    }
    // 「灵隐寺排队太长了」：被点名的站如果就是当前站，它也要算进「待调整」里
    const named = mentionedSpots(text)[0];
    const namedIdx = named ? plan.stops.findIndex((s) => findSpot(s.name)?.name === named.name) : -1;
    if (!rain && !tired && namedIdx >= 0 && namedIdx <= cur) cur = namedIdx - 1;
    const keep = plan.stops.slice(0, cur + 1).map((s) => ({ name: s.name, type: s.type || 'spot', duration: toMin(s.leave) - toMin(s.arrive), note: s.note }));
    const rest = plan.stops.slice(cur + 1).map((s) => ({ name: s.name, type: s.type || 'spot', duration: toMin(s.leave) - toMin(s.arrive), note: s.note }));
    if (keep.length && now && now > toMin(plan.stops[cur].arrive)) keep.at(-1).duration = Math.max(15, now - toMin(plan.stops[cur].arrive));
    const startMin = toMin(plan.stops[0].arrive);
    const slow = (plan.party?.elderly || 0) > 0 || plan.party?.mobility === 'knee';
    const here =
      [...keep].reverse().map((k) => findSpot(k.name)).find(Boolean) ||
      plan.stops.map((s) => findSpot(s.name)).find(Boolean) ||
      findSpot('断桥残雪');
    const blocked = mentionedSpots(text).find((m) => rest.some((r) => findSpot(r.name)?.name === m.name)) || (rest[0] && findSpot(rest[0].name));

    let A, B, reason;
    if (rain) {
      reason = '下雨了，后面几站是户外的';
      const map = rainyMap();
      const weekday = WEEK[new Date(`${plan.date}T12:00:00Z`).getUTCDay()];
      const usable = (s) => s && !(s.closed_day && s.closed_day.includes(weekday)) && !(slow && s.stairs === '多');
      const seen = new Set([...keep, ...rest].map((k) => findSpot(k.name)?.name || k.name));
      const swapped = [];
      const changes = [];
      for (const r of rest) {
        const sp = findSpot(r.name);
        let n = r;
        if (r.type === 'spot' && sp && sp.indoor !== '是') {
          // 先查雨天备选表；表里没有或换成自己时，就近找一个室内景点
          let repl = findSpot(map[sp.name] || '');
          if (!usable(repl) || repl.name === sp.name || seen.has(repl.name)) {
            repl = loadSpots()
              .filter((x) => x.indoor === '是' && usable(x) && !seen.has(x.name))
              .sort((a, b) => haversineM(sp.location, a.location) - haversineM(sp.location, b.location))[0];
          }
          if (repl) {
            seen.add(repl.name);
            changes.push(`${sp.name}→${repl.name}`);
            n = { name: repl.name, type: 'spot', duration: up5(repl.duration_min * (slow ? 1.2 : 1)), note: '室内，下雨也能逛' };
          } else n = null;
        }
        if (n) swapped.push(n);
      }
      A = { title: '换成室内的地方', seq: [...keep, ...swapped], summary: changes.length ? `把户外站换掉：${changes.join('，')}` : '后面本来就是室内为主，路线不变' };
      // 减：保留午饭和第一个室内站，其余取消
      const meal = rest.find((r) => r.type === 'meal');
      const firstIndoor = rest.find((r) => r.type === 'spot' && findSpot(r.name)?.indoor === '是');
      const kept = rest.filter((r) => r === meal || r === firstIndoor);
      B = {
        title: '少逛几站，早点收工',
        seq: [...keep, ...kept],
        summary: kept.length ? `只保留${kept.map((k) => k.name).join('、')}，其余取消` : '后面的都取消，直接回酒店休息',
      };
    } else if (tired) {
      reason = '同行的人累了';
      const tea = loadRestaurants()
        .filter((r) => /茶馆/.test(r.type))
        .sort((a, b) => haversineM(here.location, a.location) - haversineM(here.location, b.location))[0];
      const restStop = { name: tea.name, type: 'rest', duration: 45, note: '坐下歇脚喝茶' };
      const remainingSpots = rest.filter((r) => r.type === 'spot');
      const easiest = remainingSpots.sort((a, b) => (findSpot(a.name)?.walk_km || 0) - (findSpot(b.name)?.walk_km || 0))[0];
      A = { title: '先歇一会儿，后面只去一站', seq: [...keep, restStop, ...(easiest ? [easiest] : [])], summary: `去${tea.name}坐 45 分钟${easiest ? `，然后只去${easiest.name}` : ''}` };
      B = { title: '今天就到这', seq: keep.length ? keep : [rest[0]], summary: '后面的都取消，打车回去休息' };
    } else {
      reason = blocked ? `「${blocked.name}」去不了/排队太久` : '计划有变';
      const without = rest.filter((r) => findSpot(r.name)?.name !== blocked?.name);
      const alt = blocked
        ? loadSpots()
            .filter((s) => s.area === blocked.area && s.name !== blocked.name && !plan.stops.some((p) => findSpot(p.name)?.name === s.name) && !(slow && s.stairs === '多'))
            .sort((a, b) => haversineM(blocked.location, a.location) - haversineM(blocked.location, b.location))[0]
        : null;
      A = alt
        ? { title: `换成附近的${alt.name}`, seq: [...keep, ...rest.map((r) => (findSpot(r.name)?.name === blocked.name ? { name: alt.name, type: 'spot', duration: up5(alt.duration_min * (slow ? 1.2 : 1)) } : r))], summary: `${blocked.name}换成${alt.name}，离得近` }
        : { title: `跳过${blocked?.name || '这一站'}`, seq: [...keep, ...without], summary: '直接去下一站' };
      B = { title: `跳过${blocked?.name || '这一站'}，提前收工`, seq: [...keep, ...without.slice(0, Math.max(0, without.length - 1))], summary: '少一站，早点结束' };
    }
    st.options = [A, B].map((o, i) => ({ ...o, id: String.fromCharCode(65 + i) }));
    st.reason = reason;
    st.startMin = startMin;
  }

  // 依次为每个方案算路线
  for (const o of st.options) {
    if (o.seq.length < 2) {
      o.legs = [];
      continue;
    }
    const names = o.seq.map((s) => s.name);
    const r = (R.calls.amap_route || []).find((c) => JSON.stringify(c.args.points) === JSON.stringify(names));
    if (!r) return call('amap_route', { points: names, mode: 'auto', party: plan.party });
    o.legs = r.result.legs || [];
  }

  if (!R.has('propose_options')) {
    return call('propose_options', {
      reason: st.reason,
      options: st.options.map((o) => {
        const stops = schedule(o.seq, o.legs, st.startMin);
        const p = {
          ...stripPlan(plan), stops, legs: o.legs.map(({ source, ...l }) => l),
          ...(rain ? { weather: ctx.weather || '小雨', weather_from: ctx.time || stops[0].arrive } : {}),
        };
        return { id: o.id, title: o.title, summary: `${o.summary}，预计 ${stops.at(-1).leave} 结束`, plan: p };
      }),
    });
  }
  const tip = rain ? '雨天石板路滑，长辈走慢点。' : tired ? '别硬撑，歇够了再走。' : '';
  return reply(`${st.reason}。我准备了两个方案，你选一个，我再改行程。${tip}`);
}

function applyChoice(st, R) {
  const opt = st.choiceOption;
  if (!opt.plan) return reply('好的，行程不变，按原计划走。');
  if (!R.has('save_plan')) return call('save_plan', { plan: opt.plan });
  const res = R.last('save_plan');
  if (!res.saved) return reply(`没改成：${res.error || res.validation?.errors?.map((e) => e.msg).join('；')}`);
  return reply(`好的，已经按「${opt.title}」改好了。${opt.summary}。现在的安排：${opt.plan.stops.map((s) => `${s.arrive} ${s.name}`).join(' → ')}。每一段的导航链接在行程卡片里。`);
}

// ───────────────────── 景点讲解 ─────────────────────
export function kbIndex() {
  return parseMarkdownTable(require_('spot-narrator/references/narration-kb/index.md')).map((r) => ({
    file: r['文件'],
    name: r['景点'],
    aliases: (r['别名'] || '').split(/[,，]/).filter(Boolean),
  }));
}

export function parseCard(md) {
  const facts = parseMarkdownTable(md.split('## 事实')[1]?.split('\n## ')[0] || '').map((r) => ({ text: r['事实'], kind: r['类型'] }));
  const sec = (h) => (md.split(`## ${h}`)[1]?.split('\n## ')[0] || '').split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean);
  return { facts, look: sec('看点'), todo: sec('现在可以做的事'), elder: sec('长辈版提示'), kids: sec('亲子版提问') };
}

export function composeNarration(name, card, style) {
  const facts = card.facts.map((f) => f.text);
  const todo = (card.todo[0] || '').replace(/^现在可以/, '');
  let parts;
  if (style === 'elder') {
    parts = [`咱们现在站的地方，就是${name}。`, ...facts, ...card.look, ...card.elder, `现在可以${todo}`];
  } else if (style === 'kids') {
    parts = [card.kids[0] || `你知道${name}有什么故事吗？`, '我们一起来听听。', ...facts, ...card.look, `现在可以${todo}`, '小任务：拍一张你觉得最好看的照片！'];
  } else {
    parts = [`这里是${name}。`, ...facts, ...card.look, `现在可以${todo}`];
  }
  // 控制在 350 字以内：从后往前去掉事实
  let text = parts.join('');
  while (text.length > 350 && facts.length > 3) {
    const drop = facts.pop();
    parts = parts.filter((p) => p !== drop);
    text = parts.join('');
  }
  return text;
}

function narrateFlow(text, session, st, R, ctx) {
  if (!R.has('load_skill', (a) => a.name === 'spot-narrator')) return call('load_skill', { name: 'spot-narrator' });

  // 1. 确定景点
  if (!st.spot) {
    const m = mentionedSpots(text)[0];
    if (m) st.spot = m.name;
    else if (ctx.location && findSpot(ctx.location)) st.spot = findSpot(ctx.location).name;
    else if (ctx.location && /^\d/.test(ctx.location)) {
      if (!R.has('amap_regeocode')) return call('amap_regeocode', { location: ctx.location });
      const near = R.last('amap_regeocode')?.nearest_spot;
      if (near && near.distance_m < 600) st.spot = near.name;
    }
    if (!st.spot && session.plan) {
      if (!R.has('get_plan')) return call('get_plan');
      const cur = R.last('get_plan')?.current_stop;
      if (cur && findSpot(cur)) st.spot = findSpot(cur).name;
    }
    if (!st.spot) {
      if (!R.has('ask_user')) {
        st.askIntent = 'narrate';
        const cands = session.plan ? session.plan.stops.filter((s) => s.type !== 'meal').map((s) => s.name).slice(0, 3) : ['断桥残雪', '雷峰塔', '灵隐寺'];
        return call('ask_user', { questions: [{ question: '你们现在在哪个景点？', options: cands }] });
      }
      return reply('告诉我你在哪个景点，我就给你讲讲。');
    }
  }
  const name = st.spot;
  const isQuestion = /哪一年|哪年|多少|谁|为什么|什么时候|几(座|个|年|米)|多长|多高|有没有/.test(text) && !/讲讲|讲一讲|介绍/.test(text);

  // 2. 风格
  if (!R.has('memory_get')) return call('memory_get');
  const prof = R.last('memory_get')?.profile || {};
  const style = prof.elderly ? 'elder' : prof.kids ? 'kids' : 'default';
  const key = `${name}:${style}`;

  // 3. 先查缓存（问答不查）
  if (!isQuestion && !R.has('tts_speak')) return call('tts_speak', { cache_key: key, kind: 'narration', style });
  const cacheHit = R.calls.tts_speak?.[0]?.result;
  if (!isQuestion && cacheHit?.url) return reply(cacheHit.text);

  // 4. 读知识卡
  const entry = kbIndex().find((e) => e.name === name || e.aliases.includes(name) || name.includes(e.name));
  if (!R.has('read_skill_file', (a) => /index\.md/.test(a.path))) return call('read_skill_file', { skill: 'spot-narrator', path: 'references/narration-kb/index.md' });
  if (!entry) {
    const spot = findSpot(name);
    return reply(`这里是${name}${spot ? `，在${spot.area}一带` : ''}。这里的历史我手头没有可靠资料，就不乱讲了，景区的导览牌上会有详细介绍。`);
  }
  if (!R.has('read_skill_file', (a) => a.path.endsWith(entry.file))) return call('read_skill_file', { skill: 'spot-narrator', path: `references/narration-kb/${entry.file}` });
  const card = parseCard(R.calls.read_skill_file.find((c) => c.args.path.endsWith(entry.file)).result.content);

  if (isQuestion) {
    // 问句切成重叠的二字词，去掉景点名和疑问词，再和知识卡逐条比对
    const spotWords = [name, ...(findSpot(name)?.aliases || [])].join('|');
    const kws = [...text]
      .map((_, i) => text.slice(i, i + 2))
      .filter((w) => /^[一-龥]{2}$/.test(w) && !spotWords.includes(w) && !/这里|这个|什么|哪一|一年|多少|为什|时候|是谁|是哪/.test(w));
    const best = card.facts
      .map((f) => ({ f, score: kws.filter((k) => f.text.includes(k)).length + (/哪一?年|什么时候/.test(text) && /\d{3,4}年|年间|朝|代/.test(f.text) ? 1 : 0) }))
      .sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 2) return reply(best.f.text);
    return reply('这个我不确定，手头的资料里没有，景区的导览牌上会有。');
  }

  // 5. 写稿 + 合成
  const script = composeNarration(name, card, style);
  const synth = (R.calls.tts_speak || []).find((c) => c.args.text);
  if (!synth) return call('tts_speak', { text: script, kind: 'narration', style, cache_key: key });
  return reply(synth.result.ok ? script : `${script}\n\n（语音暂时不可用，先看文字）`);
}

// ───────────────────── 周边吃喝 ─────────────────────
function foodFlow(text, session, st, R, ctx) {
  if (!R.has('load_skill', (a) => a.name === 'local-food')) return call('load_skill', { name: 'local-food' });
  if (!R.has('read_skill_file')) return call('read_skill_file', { skill: 'local-food', path: 'references/filter-rules.md' });
  if (!R.has('memory_get')) return call('memory_get');
  const prof = R.last('memory_get')?.profile || {};

  if (!st.where) {
    const m = mentionedSpots(text)[0];
    if (m) st.where = m.name;
    else if (ctx.location) st.where = ctx.location;
    else if (session.plan) {
      if (!R.has('get_plan')) return call('get_plan');
      st.where = R.last('get_plan')?.current_stop || session.plan.stops[0].name;
    }
    if (!st.where) {
      if (!R.has('ask_user')) {
        st.askIntent = 'food';
        return call('ask_user', { questions: [{ question: '你们现在在哪附近？', options: ['断桥', '雷峰塔', '灵隐寺', '河坊街'] }] });
      }
      return reply('告诉我你们在哪附近，我帮你找。');
    }
  }
  const slow = prof.elderly || prof.mobility === 'knee';
  const radius = slow ? 800 : 1000;
  const keywords = /茶|歇|坐/.test(text) ? '茶馆' : /小吃/.test(text) ? '小吃' : '杭帮菜';
  const searches = R.calls.amap_around_search || [];
  if (!searches.length) return call('amap_around_search', { location: st.where, keywords, radius });
  const res = searches.at(-1).result;
  if (res.ok === false) return reply(`没定位到「${st.where}」，换个说法试试？比如「断桥附近」。`);
  const usedRadius = searches.at(-1).args.radius || radius;

  const avoid = (prof.food_avoid || []).includes('辣') || /不吃辣|别太辣/.test(text);
  const pois = (res.pois || [])
    .filter((p) => p.distance_m == null || p.distance_m <= usedRadius)
    .filter((p) => !/暂停营业|已关闭/.test(p.status || ''))
    .filter((p) => !(avoid && /辣|川|湘|火锅|烧烤/.test(`${p.type}${p.taste || ''}${p.name}`)))
    .filter((p) => !(slow && /排队/.test(p.address || '')));
  if (pois.length < 3 && searches.length < 2) return call('amap_around_search', { location: st.where, keywords, radius: 2000 });

  const picked = [];
  for (const p of pois) {
    if (picked.length >= 3) break;
    if (picked.some((x) => x.type === p.type) && pois.filter((q) => !picked.includes(q) && !picked.some((x) => x.type === q.type)).length) continue;
    picked.push(p);
  }
  for (const p of pois) if (picked.length < 3 && !picked.includes(p)) picked.push(p);
  if (!picked.length) return reply(`「${st.where}」附近 ${usedRadius} 米内没找到合适的${res.source === 'local-cache' ? '（现在用的是离线数据，覆盖不全）' : ''}。要不要我换个地方找，或者看看下一站附近？`);
  const lines = picked.map((p, i) => {
    const mins = p.distance_m != null ? `步行约 ${Math.max(2, Math.round(p.distance_m / (slow ? 50 : 70)))} 分钟` : '距离未知';
    const why = [p.type, p.suits && slow && /长辈/.test(p.suits) ? '适合长辈' : '', p.rating ? `评分 ${p.rating}` : '', p.address].filter(Boolean).join('，');
    return `${i + 1}. **${p.name}** · ${mins}（${why}）`;
  });
  const cacheNote = res.source === 'local-cache' ? '\n\n店铺信息来自离线缓存，可能有变化，出发前看一眼营业状态。' : '';
  const wider = usedRadius > radius ? `（${radius} 米内不多，放宽到了 ${usedRadius} 米）` : '';
  return reply(`${st.where}附近给你挑了 ${picked.length} 家${avoid ? '，已避开辣的' : ''}${wider}：\n${lines.join('\n')}${cacheNote}`);
}

// ───────────────────── 卡片 ─────────────────────
function recapFlow(session, R) {
  if (!R.has('load_skill', (a) => a.name === 'trip-card-ui')) return call('load_skill', { name: 'trip-card-ui' });
  const plan = session.plan;
  if (!plan) return reply('还没有行程，要不要先排一份？');
  const spots = plan.stops.filter((s) => s.type !== 'meal' && s.type !== 'rest').map((s) => s.name);
  const walk = plan.validation?.stats?.walk_km;
  const summary = `今天从${spots[0]}出发，${spots.length > 2 ? `走过了${spots.slice(1, -1).join('、')}，` : ''}最后在${spots.at(-1)}收尾${walk ? `，一共走了大约${walk}公里` : ''}。${plan.party?.elderly ? '爸妈今天辛苦了，晚上早点休息。' : '辛苦啦，好好休息。'}`;
  if (!R.has('tts_speak')) return call('tts_speak', { text: summary, kind: 'chat' });
  if (!R.has('render_trip_card')) return call('render_trip_card', { kind: 'recap', summary, audio_url: R.last('tts_speak')?.url || '' });
  const card = R.last('render_trip_card');
  return reply(`${summary}\n\n回忆卡片做好了：[打开卡片](${card.url})，可以直接转发给家人。`);
}

function exportFlow(session, R) {
  if (!R.has('load_skill', (a) => a.name === 'trip-card-ui')) return call('load_skill', { name: 'trip-card-ui' });
  if (!session.plan) return reply('还没有行程，要不要先排一份？');
  if (!R.has('render_trip_card')) return call('render_trip_card', { kind: 'plan' });
  const card = R.last('render_trip_card');
  return reply(`行程卡片做好了：[打开卡片](${card.url})。卡片里有「在高德地图查看全部站点」和每一段的导航链接，点开后在高德里确认就行。`);
}

// ───────────────────── 开放时间 / 门票 ─────────────────────
function infoFlow(text, R) {
  if (!R.has('read_skill_file')) return call('read_skill_file', { skill: 'trip-planner', path: 'references/hangzhou-spots.md' });
  const spot = mentionedSpots(text)[0];
  if (!spot) return reply('你问的是哪个景点？我手头有西湖周边主要景点的开放时间和门票信息。');
  const bits = [`开放时间 ${spot.hours_text}`, spot.closed_day ? `${spot.closed_day}闭馆` : null, `门票 ${spot.ticket}`, spot.reservation ? '需要提前预约' : null].filter(Boolean);
  return reply(`${spot.name}：${bits.join('，')}。${spot.note ? `${spot.note}。` : ''}这些信息以景区当天公告为准。`);
}
