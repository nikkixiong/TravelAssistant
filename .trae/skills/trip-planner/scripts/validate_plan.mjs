#!/usr/bin/env node
// 行程硬校验：模型出方案，脚本做校验。
// 顺路、开放时间、步行量这类硬约束不信任模型的心算。
//
// 用法：
//   node validate_plan.mjs < plan.json
//   或在代码里 import { validatePlan } from './validate_plan.mjs'
//
// 输出：{ ok, errors: [{code, msg, stop?}], warnings: [...], stats: {...} }
import { loadSpots, findSpot } from './spots.mjs';
import { fileURLToPath } from 'node:url';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const toMin = (t) => {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/** 不同人群的全天步行上限（公里）。改这里就是改产品规则。 */
export function walkLimitFor(party = {}) {
  if (party.mobility === 'knee' || party.mobility === 'wheelchair') return 5;
  if ((party.elderly || 0) > 0) return 8;
  return 15;
}

export function validatePlan(plan, { spots = loadSpots() } = {}) {
  const errors = [];
  const warnings = [];
  const err = (code, msg, stop) => errors.push({ code, msg, ...(stop ? { stop } : {}) });
  const warn = (code, msg, stop) => warnings.push({ code, msg, ...(stop ? { stop } : {}) });

  const stops = Array.isArray(plan?.stops) ? plan.stops : [];
  const legs = Array.isArray(plan?.legs) ? plan.legs : [];
  const party = plan?.party || {};

  if (!stops.length) {
    err('E_SCHEMA', '行程里没有任何站点');
    return { ok: false, errors, warnings, stats: {} };
  }

  // 1. 每站时间格式
  stops.forEach((s) => {
    const a = toMin(s.arrive);
    const l = toMin(s.leave);
    if (Number.isNaN(a) || Number.isNaN(l)) err('E_SCHEMA', `「${s.name}」的到达/离开时间格式应为 HH:MM`, s.name);
    else if (l <= a) err('E_SCHEMA', `「${s.name}」离开时间早于到达时间`, s.name);
  });

  // 2. 路段数量与顺序
  if (legs.length !== stops.length - 1) {
    err('E_LEGS', `路段数应为 ${stops.length - 1}，实际 ${legs.length}；请用 amap_route 重新计算路线`);
  }

  // 3. 时间衔接：下一站到达 >= 上一站离开 + 路上时间（容差 5 分钟）
  for (let i = 0; i < stops.length - 1; i++) {
    const leg = legs[i] || {};
    const gap = toMin(stops[i + 1].arrive) - toMin(stops[i].leave);
    const need = Number(leg.duration_min) || 0;
    if (gap < need - 5) {
      err('E_TIME', `「${stops[i].name}」→「${stops[i + 1].name}」路上要 ${need} 分钟，但只留了 ${gap} 分钟`, stops[i + 1].name);
    }
  }

  // 4. 逐站检查开放时间、闭馆日、台阶、预约
  const weekday = plan?.date ? WEEKDAYS[new Date(`${plan.date}T12:00:00+08:00`).getUTCDay()] : null;
  let inSpotWalk = 0;
  let indoorCount = 0;
  let spotCount = 0;
  // 下雨的室内占比只算「开始下雨之后」的站（行中改计划时，已经逛完的户外站不算）
  const rainFrom = toMin(plan?.weather_from) || 0;
  for (const s of stops) {
    if (s.type === 'meal' || s.type === 'rest') continue;
    const spot = findSpot(s.name, spots);
    const afterRain = toMin(s.leave) > rainFrom;
    if (afterRain) spotCount++;
    if (!spot) {
      warn('W_UNKNOWN', `「${s.name}」不在景点表里，无法校验开放时间`, s.name);
      inSpotWalk += 0.5;
      continue;
    }
    inSpotWalk += spot.walk_km;
    if (afterRain && spot.indoor === '是') indoorCount += 1;
    else if (afterRain && spot.indoor === '部分') indoorCount += 0.5;

    if (weekday && spot.closed_day && spot.closed_day.includes(weekday)) {
      err('E_CLOSED', `「${spot.name}」${spot.closed_day}闭馆，${plan.date} 是${weekday}`, s.name);
    }
    const a = toMin(s.arrive);
    const l = toMin(s.leave);
    if (a < toMin(spot.hours.open) || l > toMin(spot.hours.close)) {
      err('E_HOURS', `「${spot.name}」开放时间 ${spot.hours_text}，安排的 ${s.arrive}-${s.leave} 不在范围内`, s.name);
    }
    if ((party.mobility === 'knee' || party.mobility === 'wheelchair') && spot.stairs === '多') {
      err('E_STAIRS', `「${spot.name}」台阶多，不适合膝盖不好/轮椅的同行人`, s.name);
    }
    if (spot.reservation) warn('W_RESERVATION', `「${spot.name}」需要提前预约/购票`, s.name);
  }

  // 5. 步行量 = 路段里步行的距离 + 景区内步行
  const legWalk = legs.filter((l) => l.mode === 'walking').reduce((sum, l) => sum + (Number(l.distance_m) || 0), 0) / 1000;
  const walkKm = +(legWalk + inSpotWalk).toFixed(1);
  const limit = Math.min(Number(plan?.max_walk_km) || Infinity, walkLimitFor(party));
  if (walkKm > limit) err('E_WALK', `全天步行约 ${walkKm} 公里，超过上限 ${limit} 公里`);

  // 6. 下雨时室内占比
  if (/雨/.test(plan?.weather || '') && spotCount > 0 && indoorCount / spotCount < 0.5) {
    err('E_RAIN', `当天有雨，室内景点只占 ${Math.round((indoorCount / spotCount) * 100)}%，至少要一半`);
  }

  // 7. 软提醒：午饭、总时长
  const start = toMin(stops[0].arrive);
  const end = toMin(stops[stops.length - 1].leave);
  const hasMeal = stops.some((s) => s.type === 'meal');
  if (((party.elderly || 0) > 0 || (party.kids || 0) > 0) && start < 12 * 60 && end > 13 * 60 && !hasMeal) {
    warn('W_MEAL', '有长辈/孩子同行，中午最好留出吃饭休息的时间');
  }
  if (end - start > 10 * 60) warn('W_LONG_DAY', '全天超过 10 小时，可能太累');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      walk_km: walkKm,
      walk_limit_km: Number.isFinite(limit) ? limit : null,
      start: stops[0].arrive,
      end: stops[stops.length - 1].leave,
      stops: stops.length,
      indoor_ratio: spotCount ? +(indoorCount / spotCount).toFixed(2) : null,
      weekday,
    },
  };
}

// CLI 入口：从 stdin 读 JSON
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    const data = JSON.parse(input || '{}');
    const result = validatePlan(data.plan || data);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
  });
}
