// 偏好记忆：只存和旅行相关的长期偏好（同行人、体力、口味、预算、交通），
// 不存实时位置轨迹。用户可以在页面上查看和一键删除。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

fs.mkdirSync(config.paths.memory, { recursive: true });
const FILE = path.join(config.paths.memory, 'user_profile.json');

const ALLOWED = {
  companions: '同行人，如 ["父母","孩子"]',
  elderly: '同行长辈人数',
  kids: '同行孩子人数',
  mobility: 'normal | knee | wheelchair',
  pace: '节奏：slow | normal | fast',
  food_likes: '口味偏好，如 ["清淡","杭帮菜"]',
  food_avoid: '忌口，如 ["辣"]',
  budget: '预算描述',
  transport: '交通偏好，如 "公交优先"',
  interests: '兴趣，如 ["拍照","历史"]',
  notes: '其他备注（不要存位置、证件、联系方式）',
};
export const MEMORY_FIELDS = ALLOWED;

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeAll(all) {
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

export function getProfile(userId) {
  return readAll()[userId] || {};
}

export function updateProfile(userId, patch = {}) {
  const all = readAll();
  const cur = all[userId] || {};
  const rejected = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in ALLOWED)) {
      rejected.push(k);
      continue;
    }
    if (Array.isArray(v) && Array.isArray(cur[k])) cur[k] = [...new Set([...cur[k], ...v])];
    else cur[k] = v;
  }
  cur.updated_at = new Date().toISOString();
  all[userId] = cur;
  writeAll(all);
  return { ok: true, profile: cur, ...(rejected.length ? { rejected, note: '这些字段不在允许范围内，未保存' } : {}) };
}

export function deleteProfile(userId) {
  const all = readAll();
  delete all[userId];
  writeAll(all);
  return { ok: true };
}
