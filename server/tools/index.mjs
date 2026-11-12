// 工具注册表：给模型看的 schema + 真正执行的 handler。
// 三类工具：Skill 元工具（加载经验）、能力工具（高德 / MiniMax）、交互与状态工具（追问、方案、行程、记忆）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadSkill, readSkillFile, resolveSkillFile } from '../skills.mjs';
import { getProfile, updateProfile, MEMORY_FIELDS } from '../memory.mjs';
import * as amap from './amap.mjs';
import { speak } from './voice.mjs';
import { savePlan, proposeOptions, askUser, currentStopIndex } from './plan.mjs';
import { renderCard } from './card.mjs';

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

const planSchema = {
  type: 'object',
  description: '行程 JSON，格式见 trip-planner 的 SKILL.md',
  properties: {
    title: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD' },
    party: { type: 'object', properties: { adults: { type: 'number' }, elderly: { type: 'number' }, kids: { type: 'number' }, mobility: { type: 'string', enum: ['normal', 'knee', 'wheelchair'] } } },
    max_walk_km: { type: 'number' },
    weather: { type: 'string' },
    weather_from: { type: 'string', description: 'HH:MM，从几点开始下雨' },
    assumptions: { type: 'array', items: { type: 'string' } },
    stops: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, arrive: { type: 'string' }, leave: { type: 'string' }, type: { type: 'string', enum: ['spot', 'meal', 'rest'] }, note: { type: 'string' } }, required: ['name', 'arrive', 'leave'] } },
    legs: { type: 'array', items: { type: 'object' } },
  },
  required: ['title', 'stops', 'legs'],
};

export const TOOLS = [
  // ── Skill 元工具 ──
  {
    name: 'load_skill',
    description: '加载一个 Skill 的完整操作说明（SKILL.md 正文和附带文件列表）。判断出用户意图后先调用它，再按说明执行。',
    parameters: S({ name: str('Skill 名称') }, ['name']),
    run: (a) => loadSkill(a.name),
  },
  {
    name: 'read_skill_file',
    description: '读取 Skill 目录下的参考资料，例如 references/hangzhou-spots.md、references/narration-kb/duanqiao.md',
    parameters: S({ skill: str('Skill 名称'), path: str('Skill 目录内的相对路径') }, ['skill', 'path']),
    run: (a) => readSkillFile(a.skill, a.path),
  },
  {
    name: 'run_skill_script',
    description: '运行 Skill 目录下 scripts/ 里的脚本，input 会作为 JSON 从 stdin 传入，返回脚本输出。例如校验行程：skill=trip-planner, script=scripts/validate_plan.mjs, input={plan}',
    parameters: S({ skill: str('Skill 名称'), script: str('scripts/ 下的脚本路径'), input: { type: 'object' } }, ['skill', 'script']),
    run: (a) => {
      if (!/^scripts\/[\w.-]+\.mjs$/.test(a.script || '')) return { ok: false, error: '只能运行 scripts/ 目录下的 .mjs 脚本' };
      const r = resolveSkillFile(a.skill, a.script);
      if (r.error) return { ok: false, error: r.error };
      const p = spawnSync(process.execPath, [r.full], { input: JSON.stringify(a.input || {}), cwd: path.dirname(r.full), timeout: 10000, encoding: 'utf8' });
      try {
        return { ok: true, exit_code: p.status, output: JSON.parse(p.stdout) };
      } catch {
        return { ok: p.status === 0, exit_code: p.status, stdout: p.stdout?.slice(0, 2000), stderr: p.stderr?.slice(0, 1000) };
      }
    },
  },

  // ── 记忆 ──
  {
    name: 'memory_get',
    description: '读取用户的长期旅行偏好（同行人、体力、口味、预算等）',
    parameters: S({}),
    run: (_a, { session }) => ({ ok: true, profile: getProfile(session.userId) }),
  },
  {
    name: 'memory_update',
    description: `用户透露长期偏好时记下来。只能写这些字段：${Object.entries(MEMORY_FIELDS).map(([k, v]) => `${k}（${v}）`).join('；')}。不要存位置、证件、联系方式。`,
    parameters: S({ patch: { type: 'object', description: '要更新的字段' } }, ['patch']),
    run: (a, { session, emit }) => {
      const r = updateProfile(session.userId, a.patch || {});
      emit('memory', r.profile);
      return r;
    },
  },

  // ── 高德 ──
  {
    name: 'amap_text_search',
    description: '高德关键词搜索杭州的地点',
    parameters: S({ keywords: str('关键词') }, ['keywords']),
    run: (a) => amap.textSearch(a),
  },
  {
    name: 'amap_around_search',
    description: '高德周边搜索。location 可以是地点名或 "经度,纬度"；keywords 如 杭帮菜 / 茶馆 / 小吃；radius 单位米',
    parameters: S({ location: str('中心点'), keywords: str('关键词'), radius: { type: 'number' } }, ['location']),
    run: (a) => amap.aroundSearch(a),
  },
  {
    name: 'amap_weather',
    description: '查询杭州天气预报（未来 4 天）。date 为 YYYY-MM-DD',
    parameters: S({ date: str('日期，可选') }),
    run: async (a, { session }) => {
      const r = await amap.weather({ date: a.date });
      if (session.context?.weather) return { ...r, user_reported_now: session.context.weather, note: `用户情境：现在${session.context.weather}，以此为准` };
      return r;
    },
  },
  {
    name: 'amap_route',
    description: '按顺序计算多个地点之间每一段的路线（距离、时长、交通方式、高德导航链接）。points 传地点名或 "经度,纬度"；mode: auto（推荐，短距离步行，远了长辈打车其他人公交）| walking | transit | taxi',
    parameters: S({ points: { type: 'array', items: { type: 'string' } }, mode: str('交通方式', { enum: ['auto', 'walking', 'transit', 'taxi'] }), party: { type: 'object', description: '同行人，影响步速和交通方式' } }, ['points']),
    run: (a, { session }) => {
      const prof = getProfile(session.userId);
      const party = a.party || session.plan?.party || { elderly: prof.elderly || 0, kids: prof.kids || 0, mobility: prof.mobility || 'normal' };
      return amap.route({ points: a.points, mode: a.mode || 'auto', party });
    },
  },
  {
    name: 'amap_regeocode',
    description: '把 "经度,纬度" 转成地址，并给出最近的景点',
    parameters: S({ location: str('经度,纬度') }, ['location']),
    run: (a) => amap.regeocode(a),
  },

  // ── 语音 ──
  {
    name: 'tts_speak',
    description: 'MiniMax 语音合成。kind=narration 用于景点讲解（高音质），chat 用于对话。cache_key 形如「断桥残雪:elder」；只传 cache_key 不传 text 表示只查缓存。失败时返回 ok:false，此时只给文字。',
    parameters: S({ text: str('要朗读的文字'), kind: str('narration | chat', { enum: ['narration', 'chat'] }), style: str('elder | kids | default', { enum: ['elder', 'kids', 'default'] }), cache_key: str('缓存键') }),
    run: async (a, { emit }) => {
      const r = await speak(a);
      if (r.ok && r.url) emit('audio', { url: r.url, text: r.text || a.text, cached: r.cached, kind: a.kind });
      if (!r.ok && a.text) emit('audio', { url: null, text: a.text, error: r.error });
      return r;
    },
  },

  // ── 交互与行程状态 ──
  {
    name: 'ask_user',
    description: '向用户追问。一次最多 2 个问题，每个给 2–4 个选项。调用后本轮结束。',
    parameters: S({ questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] } } }, ['questions']),
    run: (a, { session, emit, trace }) => askUser(session, a, emit, trace.data.skills.at(-1)),
  },
  {
    name: 'propose_options',
    description: '给用户 2–3 个备选方案让他选（应急调整、修改已确认行程时必须用）。每个方案可带完整的新行程 plan。调用后本轮结束。',
    parameters: S({ reason: str('为什么要调整'), options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, plan: planSchema } } } }, ['reason', 'options']),
    run: (a, { session, emit }) => proposeOptions(session, a, emit),
  },
  {
    name: 'save_plan',
    description: '保存行程。会自动运行 validate_plan 校验（时间衔接、开放时间、闭馆日、步行量、台阶、雨天室内比例）。校验不通过时不保存并返回 errors，按 errors 修改后再调用。',
    parameters: S({ plan: planSchema }, ['plan']),
    run: (a, { session, emit }) => savePlan(session, a.plan, emit),
  },
  {
    name: 'get_plan',
    description: '读取当前行程的完整 JSON、状态，以及按当前时间推算的当前所在站',
    parameters: S({}),
    run: (_a, { session }) => {
      if (!session.plan) return { ok: true, plan: null, message: '当前没有行程' };
      const idx = currentStopIndex(session.plan, session.context?.time);
      return { ok: true, plan: session.plan, current_stop_index: idx, current_stop: session.plan.stops[idx]?.name || null };
    },
  },
  {
    name: 'render_trip_card',
    description: '把当前行程渲染成可转发的 H5 卡片。kind=plan 行程卡；kind=recap 回忆卡（可带 summary 和 audio_url）',
    parameters: S({ kind: str('plan | recap', { enum: ['plan', 'recap'] }), summary: str('回忆小结'), audio_url: str('小结语音地址') }),
    run: (a, { session, emit }) => {
      const r = renderCard(session, a);
      if (r.ok) emit('card', r);
      return r;
    },
  },
];

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

export function toolSchemas() {
  return TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export async function runTool(name, args, ctx) {
  const tool = byName[name];
  if (!tool) return { ok: false, error: `没有这个工具：${name}` };
  try {
    return await tool.run(args || {}, ctx);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
