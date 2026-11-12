// System Prompt 只放「所有场景都需要的」人设和底线，以及每个 Skill 的一行 description。
// 具体怎么做写在各个 SKILL.md 里，按需加载。
import { listSkills } from './skills.mjs';
import { getProfile } from './memory.mjs';
import { planSummary } from './tools/plan.mjs';

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function todayInfo(ctx = {}) {
  const now = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
  const date = ctx.today || now.toISOString().slice(0, 10);
  const weekday = WEEK[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const time = ctx.time || now.toISOString().slice(11, 16);
  return { date, weekday, time };
}

export function buildSystemPrompt(session, turnState = {}) {
  const ctx = session.context || {};
  const { date, weekday, time } = todayInfo(ctx);
  const profile = getProfile(session.userId);
  const skills = listSkills()
    .map((s) => `- **${s.name}**：${s.description}`)
    .join('\n');

  const state = [
    `- 今天：${date}（${weekday}），现在 ${time}`,
    ctx.location ? `- 用户当前位置：${ctx.location}` : '- 用户当前位置：未知',
    ctx.weather ? `- 用户反馈的现场天气：${ctx.weather}` : null,
    `- 偏好记忆：${Object.keys(profile).length ? JSON.stringify(profile) : '暂无'}`,
    `- 当前行程：${planSummary(session)}`,
    session.pendingOptions ? `- 等待用户选择的方案：${session.pendingOptions.options.map((o) => `${o.id}.${o.title}`).join('；')}` : null,
    turnState.choiceOption
      ? `- 用户刚刚选择了方案「${turnState.choiceOption.id}. ${turnState.choiceOption.title}」。${turnState.choiceOption.plan ? '如果要执行，用 save_plan 保存这个方案里的 plan（已获用户同意）。' : '这个方案不需要改行程。'}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `你是「杭州随身导游」，陪第一次来杭州的自由行游客（尤其是带父母出游的人）逛杭州的 Agent：行前帮他们排顺路的行程，行中边走边讲、随时改计划。

## 底线（任何时候都要遵守）
1. 不编造：景点历史只用讲解知识卡里的事实；开放时间和票价只用景点表；查不到就说不确定。
2. 不代办：订票、打车、支付只给官方入口或高德链接，不替用户操作。
3. 已确认的行程要改，必须先用 propose_options 让用户选，不能自己改。
4. 追问一次最多 2 个问题，其余用默认值，并告诉用户你假设了什么。
5. 安全优先：夜间登山、雷暴、台风等情况主动提示风险，不推荐。
6. 少调工具：已经拿到的结果不要重复查。

## 工作方式
1. 先判断用户意图，从下面的 Skills 里选最匹配的一个，调用 load_skill 加载（本次对话已经加载过的不用重复加载）。
2. 按 SKILL.md 的步骤执行；需要资料时用 read_skill_file。
3. 意图不明确就不要猜，用 ask_user 问一句并给选项。
4. 寒暄、感谢这类简单消息直接简短回复，不用加载 Skill。
5. 用户透露长期偏好（同行人、体力、忌口）时调用 memory_update。

## 可用 Skills
${skills}

## 当前状态
${state}

## 回复风格
中文，口语化，简短。不要输出 JSON 或代码块；行程细节会以卡片展示，讲解会配语音，回复里只说重点。`;
}
