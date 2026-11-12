// trip-card-ui：把行程 JSON 渲染成可转发的 H5 卡片（模板在 Skill 的 assets 里）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.mjs';

const TEMPLATE = path.join(config.skillsDir, 'trip-card-ui', 'assets', 'card-template.html');
fs.mkdirSync(config.paths.cards, { recursive: true });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function partyText(p = {}) {
  const bits = [];
  if (p.elderly) bits.push(`长辈 ${p.elderly} 位`);
  if (p.kids) bits.push(`孩子 ${p.kids} 位`);
  if (p.mobility === 'knee') bits.push('少走路');
  if (p.mobility === 'wheelchair') bits.push('轮椅');
  return bits.join(' · ') || '自由行';
}

export function renderCard(session, { kind = 'plan', summary = '', audio_url = '' }) {
  const plan = session.plan;
  if (!plan) return { ok: false, error: '还没有行程，先用 trip-planner 排一份' };
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const stats = plan.validation?.stats || {};
  const timeline = plan.stops
    .map((s, i) => {
      const leg = plan.legs?.[i];
      const stop = `<li class="stop"><div class="time">${esc(s.arrive)} – ${esc(s.leave)}</div><div class="name">${esc(s.name)}</div>${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}</li>`;
      const legHtml = leg
        ? `<li class="leg">${esc(leg.mode_name || leg.mode)} ${Math.round(leg.duration_min)} 分钟 · ${(leg.distance_m / 1000).toFixed(1)} 公里${leg.estimated ? '（估算）' : ''}${leg.nav_url ? ` · <a href="${esc(leg.nav_url)}">高德导航</a>` : ''}</li>`
        : '';
      return stop + legHtml;
    })
    .join('');
  const vars = {
    kicker: kind === 'recap' ? '今日回忆' : '行程卡片',
    title: esc(kind === 'recap' ? `${plan.title} · 回忆` : plan.title),
    date: esc(plan.date || ''),
    party: esc(partyText(plan.party)),
    stats: [
      [`${plan.stops.length}`, '站'],
      [`${stats.walk_km ?? '-'} km`, '步行'],
      [`${stats.start || ''}–${stats.end || ''}`, '时间'],
    ]
      .map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`)
      .join(''),
    summary: summary || audio_url
      ? `<div class="summary">${esc(summary)}${audio_url ? `<audio controls src="${esc(audio_url)}"></audio>` : ''}</div>`
      : '',
    timeline,
    assumptions: plan.assumptions?.length ? `<div class="assume">我替你假设了：${plan.assumptions.map(esc).join('；')}</div>` : '',
    links: plan.amap_markers_url ? `<a class="btn" href="${esc(plan.amap_markers_url)}">在高德地图查看全部站点</a>` : '',
  };
  const html = tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  const id = `${kind}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(path.join(config.paths.cards, `${id}.html`), html);
  return { ok: true, kind, url: `/cards/${id}.html` };
}
