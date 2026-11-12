// Skills 加载器：渐进式披露。
// 平时只把每个 Skill 的 name + description 放进 system prompt；
// 模型调用 load_skill 时才读 SKILL.md 正文；需要参考资料时再 read_skill_file。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listFiles(p, base);
    return e.name === 'SKILL.md' ? [] : [path.relative(base, p).split(path.sep).join('/')];
  });
}

export function listSkills() {
  if (!fs.existsSync(config.skillsDir)) return [];
  return fs
    .readdirSync(config.skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(config.skillsDir, d.name, 'SKILL.md')))
    .map((d) => {
      const { meta } = parseFrontmatter(fs.readFileSync(path.join(config.skillsDir, d.name, 'SKILL.md'), 'utf8'));
      return { name: meta.name || d.name, dir: d.name, description: meta.description || '' };
    });
}

export function loadSkill(name) {
  const skill = listSkills().find((s) => s.name === name || s.dir === name);
  if (!skill) return { ok: false, error: `没有名为 ${name} 的 Skill，可用：${listSkills().map((s) => s.name).join(', ')}` };
  const dir = path.join(config.skillsDir, skill.dir);
  const { body } = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  return { ok: true, name: skill.name, instructions: body.trim(), files: listFiles(dir) };
}

/** 只允许读 Skill 目录内的文件，防止路径穿越 */
export function resolveSkillFile(skillName, rel) {
  const skill = listSkills().find((s) => s.name === skillName || s.dir === skillName);
  if (!skill) return { error: `没有名为 ${skillName} 的 Skill` };
  const dir = path.join(config.skillsDir, skill.dir);
  const full = path.resolve(dir, rel || '');
  if (!full.startsWith(dir + path.sep)) return { error: '只能读取 Skill 目录内的文件' };
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return { error: `文件不存在：${skillName}/${rel}。可用文件：${listFiles(dir).join(', ')}` };
  }
  return { full, dir };
}

export function readSkillFile(skillName, rel) {
  const r = resolveSkillFile(skillName, rel);
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, path: `${skillName}/${rel}`, content: fs.readFileSync(r.full, 'utf8') };
}
