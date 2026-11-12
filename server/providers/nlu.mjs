// 规则基线用的「土法」语言理解：关键词 + 正则。
// 它的存在意义：没有大模型 key 也能跑通全流程；并且作为评测里的 baseline，
// 用来回答面试题「为什么要用大模型做路由，而不是写规则」。
import { loadSpots } from '../../.trae/skills/trip-planner/scripts/spots.mjs';

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 日: 0, 天: 0 };
const WEEK_IDX = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

export function detectIntent(text, { hasPlan }) {
  const t = text;
  if (/(订|买|抢|预约).{0,6}(票|门票|位子|座)|(票|门票).{0,4}(买|订|付)|帮我(下单|支付|付款|付钱|打车|叫车|叫个车|退票)/.test(t)) return 'booking';
  if (/夜爬|夜里爬|晚上(去)?爬|半夜.{0,4}山|台风|雷暴|暴雨.*(出门|爬)/.test(t)) return 'safety';
  if (/回忆|游记|总结一下今天|今天.{0,4}(总结|回顾)/.test(t)) return 'recap';
  if (/导出|分享|发给|转发|导入高德|生成.{0,2}卡片|行程卡/.test(t)) return 'export';
  if (hasPlan && /(换成|改成|换掉|加上|加一站|加个|去掉|删掉|不去了?|第[一二三四五六\d]站|提前到|推迟到)/.test(t) && !/下雨|累|走不动/.test(t)) return 'plan_edit';
  if (/安排|规划|行程|攻略|一日游|半日游|怎么玩|怎么逛|去哪玩|排一(下|份|天)|(玩|逛)(一|半)天|一天(逛|玩)|带.{0,4}(爸妈|父母|孩子|老人|长辈).{0,6}(去|玩|逛)/.test(t)) return 'plan';
  if (/几点(开|关)|开放时间|营业时间|门票|多少钱|要不要预约|需要预约|闭馆日/.test(t)) return 'info';
  if (/下雨|下大雨|雨(很|太)?大|太晒|好晒|太热|好热|累了|走不动|腿疼|脚疼|膝盖疼|排队|人太多|闭馆了|关门了|没开门|来不及/.test(t)) return 'replan';
  if (/吃|饭|餐|饿|茶馆|喝茶|喝杯|咖啡|小吃|歇脚|坐坐|坐一会/.test(t)) return 'food';
  if (/讲讲|讲一讲|讲一下|介绍|到了|这是哪|这是什么|什么来历|历史|故事|典故|为什么叫|哪一年|哪年|谁建|谁修|有什么来头/.test(t)) return 'narrate';
  if (/^(谢谢|好的|ok|收到|嗯|哈+|你好|在吗)/i.test(t.trim())) return 'chitchat';
  return 'unclear';
}

export function extractParty(text) {
  const p = {};
  if (/爸妈|父母|爸爸妈妈|二老/.test(text)) p.elderly = 2;
  else if (/老人|长辈|爷爷|奶奶|外公|外婆|我妈|我爸|老妈|老爸|母亲|父亲/.test(text)) p.elderly = 1;
  if (/孩子|小孩|儿子|女儿|宝宝|娃|小朋友/.test(text)) p.kids = 1;
  if (/轮椅|推车/.test(text)) p.mobility = 'wheelchair';
  else if (/膝盖|腿脚不(好|便)|走不了(太)?多|少走路|腿不好|关节|走路不方便/.test(text)) p.mobility = 'knee';
  else if (/走得动|身体(很)?好|体力(很)?好|能走|腿脚(很)?好/.test(text)) p.mobility = 'normal';
  if (/大学生|学生|特种兵|穷游/.test(text)) p.student = true;
  return p;
}

export function extractPrefs(text) {
  const patch = {};
  const party = extractParty(text);
  if (party.elderly) {
    patch.elderly = party.elderly;
    patch.companions = ['父母'];
  }
  if (party.kids) {
    patch.kids = party.kids;
    patch.companions = [...(patch.companions || []), '孩子'];
  }
  if (party.mobility && party.mobility !== 'normal') patch.mobility = party.mobility;
  if (/不吃辣|不能吃辣|吃不了辣|不要辣/.test(text)) patch.food_avoid = ['辣'];
  if (/清淡/.test(text)) patch.food_likes = ['清淡'];
  if (/吃素|素食/.test(text)) patch.food_likes = [...(patch.food_likes || []), '素食'];
  if (/公交优先|坐公交|不打车/.test(text)) patch.transport = '公交优先';
  if (/拍照|出片/.test(text)) patch.interests = ['拍照'];
  return patch;
}

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 解析日期；today 为 YYYY-MM-DD（北京时间） */
export function extractDate(text, today) {
  if (/今天|今日|现在/.test(text)) return today;
  if (/明天/.test(text)) return addDays(today, 1);
  if (/后天/.test(text)) return addDays(today, 2);
  const w = text.match(/(下|这|本)?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (w) {
    // 按中文习惯一周从周一开始：周一=1 … 周日=7
    const target = WEEK_IDX[w[2]] || 7;
    const cur = new Date(`${today}T12:00:00Z`).getUTCDay() || 7;
    let diff;
    if (w[1] === '下') diff = 7 - cur + target; // 下周X：下一个自然周里的那天
    else if (w[1]) diff = target >= cur ? target - cur : target - cur + 7; // 这周X：已过去就顺延
    else diff = (target - cur + 7) % 7; // 周X：最近的那一天
    return addDays(today, diff);
  }
  const md = text.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (md) return `${today.slice(0, 4)}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
  const d = text.match(/(\d{1,2})[号日]/);
  if (d) return `${today.slice(0, 7)}-${d[1].padStart(2, '0')}`;
  return null;
}

export function extractInterests(text) {
  const out = [];
  if (/拍照|出片|日落|夕阳/.test(text)) out.push('photo');
  if (/历史|文化|古迹|博物馆/.test(text)) out.push('history');
  if (/茶|龙井/.test(text)) out.push('tea');
  if (/寺|拜佛|烧香/.test(text)) out.push('temple');
  if (/吃|美食|小吃/.test(text)) out.push('food');
  return out;
}

/** 文本里提到的景点（按出现位置排序） */
export function mentionedSpots(text, spots = loadSpots()) {
  const hits = [];
  for (const s of spots) {
    const names = [s.name, ...s.aliases].filter((n) => n.length >= 2);
    let pos = -1;
    for (const n of names) {
      const i = text.indexOf(n);
      if (i >= 0 && (pos < 0 || i < pos)) pos = i;
    }
    if (pos >= 0) hits.push({ spot: s, pos });
  }
  // 去掉被更长名字包含的（如「苏堤」和「苏堤春晓」）
  return hits
    .sort((a, b) => a.pos - b.pos)
    .map((h) => h.spot)
    .filter((s, i, arr) => arr.findIndex((x) => x.name === s.name) === i);
}

export function ordinalIndex(text) {
  const m = text.match(/第([一二三四五六\d])站/);
  if (!m) return -1;
  const n = /\d/.test(m[1]) ? Number(m[1]) : CN_NUM[m[1]];
  return n - 1;
}
