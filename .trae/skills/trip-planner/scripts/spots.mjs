// 解析 references 里的 Markdown 表格。景点表、餐厅缓存都用这一份解析器，
// 这样学生改数据只需要改 .md，不用碰代码。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPOTS_FILE = path.resolve(here, '../references/hangzhou-spots.md');

export function parseMarkdownTable(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const split = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const header = split(lines[0]);
  return lines.slice(2).map((l) => {
    const cells = split(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

export function parseCoord(s) {
  const [lng, lat] = String(s || '').split(',').map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

function parseHours(s) {
  const m = String(s).match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  return m ? { open: m[1], close: m[2] } : { open: '00:00', close: '23:59' };
}

let cache;
export function loadSpots(file = SPOTS_FILE) {
  if (cache && file === SPOTS_FILE) return cache;
  const rows = parseMarkdownTable(fs.readFileSync(file, 'utf8'));
  const spots = rows.map((r) => ({
    name: r['名称'],
    aliases: r['别名'] ? r['别名'].split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
    location: parseCoord(r['坐标']),
    area: r['区域'],
    hours: parseHours(r['开放时间']),
    hours_text: r['开放时间'],
    closed_day: r['闭馆日'] && r['闭馆日'] !== '无' ? r['闭馆日'] : null,
    ticket: r['门票'],
    reservation: r['预约'] === '是',
    duration_min: Number(r['建议时长']) || 45,
    walk_km: Number(r['景区内步行']) || 0.5,
    stairs: r['台阶'] || '少',
    indoor: r['室内'] || '否',
    kid_friendly: r['亲子'] === '是',
    best_time: r['最佳时段'],
    note: r['备注'],
  }));
  if (file === SPOTS_FILE) cache = spots;
  return spots;
}

export function findSpot(name, spots = loadSpots()) {
  if (!name) return null;
  // 去掉括号里的分店信息，避免「楼外楼（孤山路店）」被模糊匹配成「孤山」
  const n = String(name).trim().replace(/（.*?）|\(.*?\)/g, '');
  if (!n) return null;
  return (
    spots.find((s) => s.name === n) ||
    spots.find((s) => s.aliases.includes(n)) ||
    spots.find((s) => n.includes(s.name) || s.name.includes(n)) ||
    spots.find((s) => s.aliases.some((a) => a.length >= 2 && n.includes(a))) ||
    null
  );
}

export function haversineM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
