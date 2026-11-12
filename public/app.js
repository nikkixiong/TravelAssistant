// 杭州随身导游 · 前端
// 通过 SSE 实时展示 Agent 的每一步：加载了哪个 Skill、调了哪些工具、耗时、数据来源。
const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(kid));
  return el;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

const state = { sessionId: store.get('hz-guide-session'), busy: false, plan: null, traces: [], config: null };

const TOOL_NAMES = {
  load_skill: '加载 Skill', read_skill_file: '读资料', run_skill_script: '运行脚本',
  memory_get: '读偏好', memory_update: '记偏好',
  amap_text_search: '高德·搜索', amap_around_search: '高德·周边', amap_weather: '高德·天气', amap_route: '高德·路线', amap_regeocode: '高德·定位',
  tts_speak: 'MiniMax·语音', ask_user: '追问', propose_options: '给出方案', save_plan: '保存行程（含校验）', get_plan: '读行程', render_trip_card: '生成卡片',
};
const SOURCE_NAMES = { 'amap-mcp': '高德 MCP', 'amap-rest': '高德 REST', 'local-cache': '离线缓存', 'minimax-mcp': 'MiniMax MCP', 'minimax-rest': 'MiniMax REST' };
const MEM_LABELS = { companions: '同行人', elderly: '长辈', kids: '孩子', mobility: '行动能力', pace: '节奏', food_likes: '口味', food_avoid: '忌口', budget: '预算', transport: '交通', interests: '兴趣', notes: '备注' };
const MOBILITY = { normal: '正常', knee: '膝盖不好，少走路', wheelchair: '轮椅' };

const STARTERS = [
  ['周六带爸妈玩一天西湖，我妈膝盖不好', '带父母'],
  ['大学生特种兵，明天一天逛完西湖，要出片，公交优先', '大学生'],
  ['这周日带 6 岁孩子去西湖玩，帮我排一下', '亲子'],
  ['灵隐寺几点开门？要预约吗', '问信息'],
];
const IN_TRIP = ['我们到断桥了，讲讲', '下雨了', '我妈走不动了', '附近有什么好吃的，别太远', '雷峰塔是哪一年倒的？', '帮我做个今天的回忆', '导出行程卡片'];

// ───────────── 初始化 ─────────────
async function init() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  state.config = cfg;
  $('#badges').append(
    badge('模型', cfg.llm, cfg.llmProvider === 'rule'),
    badge('地图', cfg.amap, cfg.amap === '离线缓存'),
    badge('语音', cfg.tts, cfg.tts === '未配置'),
    badge('Skills', `${cfg.skills.length} 个`),
  );
  const sel = $('#ctxLocation');
  for (const s of cfg.spots) sel.append(h('option', { value: s.name }, s.name));

  for (const [text, tag] of STARTERS) {
    $('#starters').append(h('button', { class: 'ghost', type: 'button', onclick: () => send({ text }) }, text, h('small', {}, tag)));
  }
  for (const text of IN_TRIP) {
    $('#inTrip').append(h('button', { class: 'chip', type: 'button', onclick: () => send({ text }) }, text));
  }

  if (state.sessionId) {
    const s = await fetch(`/api/session/${state.sessionId}`).then((r) => r.json()).catch(() => ({}));
    if (s.plan) setPlan(s.plan);
    const t = await fetch(`/api/traces/${state.sessionId}`).then((r) => r.json()).catch(() => ({ traces: [] }));
    state.traces = t.traces || [];
    renderTraces();
  }
  renderMemory();
}

function badge(label, value, off) {
  return h('span', { class: `badge${off ? ' off' : ''}` }, `${label} `, h('b', {}, value));
}

// ───────────── 发送与流式接收 ─────────────
function context() {
  const ctx = {};
  const loc = $('#ctxLocation').value;
  const time = $('#ctxTime').value;
  let weather = $('#ctxWeather').value;
  if (loc) ctx.location = loc;
  if (time) ctx.time = time;
  if (weather) ctx.weather = weather;
  return ctx;
}

async function send({ text = '', choice = null, label = null }) {
  if (state.busy) return;
  if (!text && !choice) return;
  // 说「下雨了」时，顺手把模拟器的天气也设成小雨
  if (/下雨/.test(text) && !$('#ctxWeather').value) $('#ctxWeather').value = '小雨';
  const ctx = context();
  $('#welcome')?.remove();
  state.busy = true;
  $('#send').disabled = true;

  const ctxText = [ctx.location && `📍${ctx.location}`, ctx.time && `🕐${ctx.time}`, ctx.weather && `🌧${ctx.weather}`].filter(Boolean).join(' ');
  addMsg(h('div', { class: 'msg user' }, label || text, ctxText ? h('span', { class: 'ctx' }, ctxText) : null));
  const bot = botMessage();

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, text, choice, context: ctx }),
    });
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) handle(JSON.parse(chunk.slice(6)), bot);
      }
    }
  } catch (e) {
    bot.setText(`出错了：${e.message}`);
  } finally {
    state.busy = false;
    $('#send').disabled = false;
    bot.finish();
  }
}

function handle(ev, bot) {
  switch (ev.type) {
    case 'session':
      state.sessionId = ev.sessionId;
      store.set('hz-guide-session', ev.sessionId);
      break;
    case 'skill': bot.step(`<span class="skill">⚡ 加载 Skill · ${esc(ev.name)}</span>`); break;
    case 'tool_start': bot.toolStart(ev); break;
    case 'tool_end': bot.toolEnd(ev); break;
    case 'thinking': bot.step(`💭 ${esc(ev.text.slice(0, 120))}`); break;
    case 'notice': bot.notice(ev.text); break;
    case 'ask': bot.ask(ev.questions); break;
    case 'options': bot.options(ev); break;
    case 'audio': bot.audio(ev); break;
    case 'card': bot.card(ev.url); break;
    case 'plan': setPlan(ev); showTab('plan'); break;
    case 'memory': renderMemory(); break;
    case 'reply': bot.setText(ev.text); break;
    case 'done':
      state.traces.push(ev.trace);
      renderTraces();
      bot.meta(ev.trace);
      break;
    case 'error': bot.setText(`出错了：${ev.text}`); break;
  }
}

function addMsg(el) {
  $('#messages').append(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return el;
}

function botMessage() {
  const stepsList = h('ol');
  const summary = h('summary', {}, h('span', { class: 'spinner' }), h('span', { class: 'label' }, '思考中…'));
  const steps = h('details', { class: 'steps', open: true }, summary, stepsList);
  const bubble = h('div', { class: 'bubble' }, h('span', { class: 'spinner' }));
  const extras = h('div');
  const root = addMsg(h('div', { class: 'msg bot' }, steps, bubble, extras));
  const pending = new Map();
  let count = 0;
  let audioEl = null;
  let cardUrl = null;
  const scroll = () => root.scrollIntoView({ behavior: 'smooth', block: 'end' });

  return {
    step(html) {
      stepsList.append(h('li', { html }));
      summary.querySelector('.label').textContent = `处理中…（${++count} 步）`;
    },
    toolStart(ev) {
      if (ev.name === 'load_skill') return;
      const li = h('li', { html: `${esc(TOOL_NAMES[ev.name] || ev.name)} <span class="spinner"></span>` });
      pending.set(ev.name, li);
      stepsList.append(li);
      summary.querySelector('.label').textContent = `处理中…（${++count} 步）`;
    },
    toolEnd(ev) {
      if (ev.tool === 'load_skill') return;
      const li = pending.get(ev.tool) || stepsList.appendChild(h('li'));
      pending.delete(ev.tool);
      const src = ev.source ? ` <span class="src">· ${esc(SOURCE_NAMES[ev.source] || ev.source)}</span>` : '';
      li.innerHTML = `${ev.ok ? '' : '<span class="fail">✕ </span>'}${esc(TOOL_NAMES[ev.tool] || ev.tool)}${ev.summary ? `：${esc(ev.summary)}` : ''} <span class="src">${ev.ms}ms</span>${src}`;
    },
    notice(text) {
      bubble.before(h('div', { class: 'notice' }, text));
    },
    setText(text) {
      bubble.innerHTML = md(text);
      if (audioEl) bubble.append(audioEl);
      if (cardUrl) bubble.append(h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: cardUrl, target: '_blank', rel: 'noopener' }, '打开卡片')));
      scroll();
    },
    ask(questions) {
      const answers = new Array(questions.length).fill(null);
      const box = h('div', { class: 'ask' });
      questions.forEach((q, qi) => {
        const chips = h('div', { class: 'chips' });
        for (const opt of q.options || []) {
          const b = h('button', {
            class: 'chip', type: 'button',
            onclick: () => {
              answers[qi] = opt;
              chips.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
              if (answers.every(Boolean)) {
                box.querySelectorAll('button').forEach((x) => (x.disabled = true));
                send({ text: answers.join('；') });
              }
            },
          }, opt);
          chips.append(b);
        }
        if (questions.length > 1) box.append(h('div', { class: 'q' }, q.question));
        box.append(chips);
      });
      if (questions.length > 1) box.append(h('div', { class: 'tl-note' }, '两个都选好后会自动发送，也可以直接在下面打字回答。'));
      extras.append(box);
      scroll();
    },
    options(ev) {
      const grid = h('div', { class: 'options' });
      for (const o of ev.options) {
        const v = o.validation;
        const meta = v
          ? `步行 ${v.stats.walk_km} km · ${v.stats.start}–${v.stats.end}${v.ok ? '' : ` · ⚠ ${v.errors.length} 项未通过`}`
          : '';
        const card = h('div', { class: 'option' },
          h('h4', {}, `${o.id === 'keep' ? '' : `${o.id}. `}${o.title}`),
          h('div', { class: 'sum' }, o.summary),
          meta ? h('div', { class: 'meta' }, meta) : null,
          h('button', {
            class: 'primary', type: 'button',
            onclick: () => {
              grid.querySelectorAll('button').forEach((b) => (b.disabled = true));
              card.classList.add('chosen');
              send({ choice: o.id, label: `选「${o.title}」` });
            },
          }, '选这个'),
        );
        grid.append(card);
      }
      extras.append(grid);
      scroll();
    },
    audio(ev) {
      if (ev.url) {
        audioEl = h('div', { class: 'audio' }, h('audio', { controls: true, src: ev.url, preload: 'auto' }), h('span', { class: 'tag' }, ev.cached ? '🔊 MiniMax 语音 · 命中缓存（零成本）' : '🔊 MiniMax 语音'));
      } else {
        const speakBtn = h('button', { class: 'chip', type: 'button', onclick: () => browserSpeak(ev.text) }, '🔈 用浏览器朗读（降级）');
        audioEl = h('div', { class: 'audio' }, h('span', { class: 'tag' }, '语音暂不可用，已降级为文字'), speakBtn);
      }
    },
    card(url) {
      cardUrl = url;
    },
    meta(trace) {
      const skills = trace.skills.length ? trace.skills.join(' → ') : '未加载 Skill';
      summary.innerHTML = '';
      summary.append(`${skills} · ${trace.steps.length} 次工具调用 · ${(trace.total_ms / 1000).toFixed(1)}s${trace.cost_yuan ? ` · ¥${trace.cost_yuan}` : ''}`);
    },
    finish() {
      steps.open = false;
      bubble.querySelectorAll(':scope > .spinner').forEach((s) => s.remove());
      if (!count) steps.remove();
    },
  };
}

function browserSpeak(text) {
  if (!('speechSynthesis' in window)) return alert('这个浏览器不支持朗读');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

// 极简 Markdown：段落、列表、加粗、链接
function md(text) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return String(text || '')
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*(-|\d+\.)\s/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*(-|\d+\.)\s/, ''))}</li>`).join('')}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('');
}

// ───────────── 行程面板 ─────────────
function setPlan(plan) {
  state.plan = plan;
  renderPlan();
}

function renderPlan() {
  const p = state.plan;
  const pane = $('#tab-plan');
  pane.innerHTML = '';
  if (!p) return pane.append(h('div', { class: 'empty' }, '还没有行程。在左边说一句需求试试。'));
  const v = p.validation || { stats: {}, errors: [], warnings: [] };
  const st = v.stats || {};
  const over = st.walk_limit_km && st.walk_km > st.walk_limit_km;

  pane.append(
    h('div', { class: 'plan-head' },
      h('h2', {}, p.title),
      h('div', { class: 'sub' }, `${p.date || ''}${st.weekday ? ` ${st.weekday}` : ''}`, p.weather ? `· ${p.weather}` : '', `· 第 ${p.version} 版`,
        h('span', { class: `pill${p.status === 'confirmed' ? ' ok' : ''}` }, p.status === 'confirmed' ? '已确认' : '草稿')),
    ),
    h('div', { class: 'stats' },
      stat(`${p.stops.length}`, '站'),
      stat(`${st.walk_km ?? '-'}${st.walk_limit_km ? ` / ${st.walk_limit_km}` : ''} km`, '步行 / 上限', over),
      stat(`${st.start || ''}–${st.end || ''}`, '时间'),
    ),
  );

  const checks = h('div', { class: 'checks' });
  for (const e of v.errors || []) checks.append(h('div', { class: 'e' }, `✕ ${e.msg}`));
  for (const w of v.warnings || []) checks.append(h('div', { class: 'w' }, `! ${w.msg}`));
  if (v.ok) checks.append(h('div', { class: 'ok' }, '✓ 校验通过：时间衔接、开放时间、闭馆日、步行量、台阶'));
  pane.append(checks, minimap(p));

  const tl = h('ol', { class: 'timeline' });
  p.stops.forEach((s, i) => {
    tl.append(
      h('li', { class: 'tl-stop' },
        h('div', { class: 'tl-time' }, s.arrive, h('small', {}, s.leave)),
        h('div', {},
          h('div', { class: 'tl-name' }, s.name, s.type === 'meal' ? h('span', { class: 'kind' }, '吃饭') : s.type === 'rest' ? h('span', { class: 'kind' }, '歇脚') : null),
          s.note ? h('div', { class: 'tl-note' }, s.note) : null),
      ),
    );
    const leg = p.legs?.[i];
    if (leg) {
      const li = h('li', { class: 'tl-leg' }, `${leg.mode_name || leg.mode} ${Math.round(leg.duration_min)} 分钟 · ${(leg.distance_m / 1000).toFixed(1)} km${leg.estimated ? '（估算）' : ''} `);
      if (leg.nav_url) li.append(h('a', { href: leg.nav_url, target: '_blank', rel: 'noopener' }, '导航'));
      tl.append(li);
    }
  });
  pane.append(tl);
  if (p.assumptions?.length) pane.append(h('div', { class: 'assume' }, `我替你假设了：${p.assumptions.join('；')}`));

  const actions = h('div', { class: 'actions' });
  if (p.status !== 'confirmed') {
    actions.append(h('button', { class: 'primary', type: 'button', onclick: confirmPlan }, '确认行程'));
  }
  actions.append(h('button', { class: 'ghost', type: 'button', onclick: () => send({ text: '导出行程卡片' }) }, '导出 H5 卡片'));
  if (p.amap_markers_url) actions.append(h('a', { class: 'btn', href: p.amap_markers_url, target: '_blank', rel: 'noopener' }, '在高德查看全部站点'));
  pane.append(actions);
}

function stat(b, s, bad) {
  return h('div', { class: `stat${bad ? ' over' : ''}` }, h('b', {}, b), h('span', {}, s));
}

async function confirmPlan() {
  const r = await fetch(`/api/session/${state.sessionId}/plan/confirm`, { method: 'POST' }).then((x) => x.json());
  if (r.ok) {
    setPlan(r.plan);
    addMsg(h('div', { class: 'msg bot' }, h('div', { class: 'notice' }, '行程已确认。之后要改行程，我会先给你选项，你点头了才改。')));
  }
}

function minimap(p) {
  const pts = p.stops.map((s, i) => ({ ...s, i })).filter((s) => s.location);
  if (pts.length < 2) return h('div');
  const W = 388;
  const H = 230;
  const pad = 34;
  const kx = Math.cos((30.25 * Math.PI) / 180);
  const xs = pts.map((s) => s.location.lng * kx);
  const ys = pts.map((s) => s.location.lat);
  let [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(x1 - x0, (y1 - y0) * ((W - 2 * pad) / (H - 2 * pad)), 0.004);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const scale = (W - 2 * pad) / span;
  const X = (lng) => W / 2 + (lng * kx - cx) * scale;
  const Y = (lat) => H / 2 - (lat - cy) * scale;
  const lake = `<ellipse class="lake" cx="${X(120.1455)}" cy="${Y(30.2455)}" rx="${0.0135 * kx * scale}" ry="${0.0165 * scale}"/><text class="lake-label" x="${X(120.1455)}" y="${Y(30.2455)}" text-anchor="middle">西湖</text>`;
  const line = `<polyline class="route" points="${pts.map((s) => `${X(s.location.lng)},${Y(s.location.lat)}`).join(' ')}"/>`;
  const dots = pts
    .map((s, k) => {
      const x = X(s.location.lng);
      const y = Y(s.location.lat);
      const left = x > W - 110;
      return `<circle class="dot${s.type === 'meal' || s.type === 'rest' ? ' meal' : ''}" cx="${x}" cy="${y}" r="9"/><text class="n" x="${x}" y="${y}">${k + 1}</text><text class="name" x="${left ? x - 13 : x + 13}" y="${y + 4}" text-anchor="${left ? 'end' : 'start'}">${esc(s.name.replace(/（.*）/, ''))}</text>`;
    })
    .join('');
  const svg = h('div', { html: `<svg class="minimap" viewBox="0 0 ${W} ${H}" role="img" aria-label="行程示意图">${lake}${line}${dots}</svg>` });
  return svg.firstChild;
}

// ───────────── 调用链路面板 ─────────────
function renderTraces() {
  const pane = $('#tab-trace');
  pane.innerHTML = '';
  if (!state.traces.length) return pane.append(h('div', { class: 'empty' }, '每一轮对话的 Skill、工具调用、耗时和成本会记录在这里。'));
  for (const t of [...state.traces].reverse()) {
    const rows = t.steps
      .map((s) => `<tr><td class="${s.ok ? '' : 'fail'}">${esc(TOOL_NAMES[s.tool] || s.tool)}</td><td>${esc(s.summary || '')}${s.source ? ` <span style="opacity:.6">[${esc(SOURCE_NAMES[s.source] || s.source)}]</span>` : ''}</td><td class="num">${s.ms}ms</td></tr>`)
      .join('');
    pane.append(
      h('div', { class: 'trace-turn', html: `
        <div class="in">「${esc(t.input)}」</div>
        <div class="kv"><span>Skill：${esc(t.skills.join(' → ') || '无')}</span><span>模型：${esc(t.provider)}${t.fell_back_to_rule ? '（降级为规则）' : ''}</span></div>
        <div class="kv"><span>总耗时 ${(t.total_ms / 1000).toFixed(2)}s</span><span>模型调用 ${t.llm.calls} 次 / ${t.llm.input_tokens + t.llm.output_tokens} tokens</span><span>语音 ${t.tts.chars} 字${t.tts.cache_hits ? `（缓存命中 ${t.tts.cache_hits}）` : ''}</span><span>成本 ¥${t.cost_yuan}</span><span${t.invalid_tool_calls ? ' class="fail"' : ''}>失败调用 ${t.invalid_tool_calls}</span></div>
        <table>${rows}</table>` }),
    );
  }
}

// ───────────── 记忆面板 ─────────────
async function renderMemory() {
  const { profile } = await fetch('/api/memory').then((r) => r.json());
  const pane = $('#tab-memory');
  pane.innerHTML = '';
  const box = h('div', { class: 'mem' });
  const keys = Object.keys(profile).filter((k) => k !== 'updated_at');
  if (!keys.length) box.append(h('div', { class: 'empty' }, '还没有记住任何偏好。'));
  else {
    const dl = h('dl');
    for (const k of keys) {
      const v = profile[k];
      dl.append(h('dt', {}, MEM_LABELS[k] || k), h('dd', {}, k === 'mobility' ? MOBILITY[v] || v : Array.isArray(v) ? v.join('、') : String(v)));
    }
    box.append(dl, h('button', { class: 'ghost', type: 'button', onclick: async () => { await fetch('/api/memory', { method: 'DELETE' }); renderMemory(); } }, '删除我的偏好'));
  }
  box.append(h('p', {}, '只记和旅行有关的长期偏好（同行人、体力、口味、交通），不记录你的位置轨迹。随时可以删除。'));
  pane.append(box);
}

// ───────────── 其他交互 ─────────────
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#input').value.trim();
  if (!text) return;
  $('#input').value = '';
  send({ text });
});

$('#newSession').addEventListener('click', async () => {
  if (state.sessionId) await fetch(`/api/session/${state.sessionId}/reset`, { method: 'POST' });
  store.del('hz-guide-session');
  location.reload();
});

// 语音输入（Chrome / Edge 支持）
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) $('#mic').remove();
else {
  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.interimResults = false;
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    $('#input').value = text;
    send({ text });
    $('#input').value = '';
  };
  rec.onend = () => $('#mic').classList.remove('listening');
  $('#mic').addEventListener('click', () => {
    $('#mic').classList.add('listening');
    rec.start();
  });
}

init();
