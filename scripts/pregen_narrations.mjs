#!/usr/bin/env node
// 讲解预生成：知识库里每个景点 × 3 种风格，提前合成语音放进缓存。
// 之后游客到了景点，直接命中缓存，零成本、零等待。
// 没配 MiniMax 时只生成文字稿，并估算全部合成要花多少钱。
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.mjs';
import { kbIndex, parseCard, composeNarration } from '../server/providers/rule.mjs';
import { speak, ttsCostYuan } from '../server/tools/voice.mjs';
import { closeAllMcp } from '../server/mcp-client.mjs';

const STYLES = ['elder', 'kids', 'default'];
const kbDir = path.join(config.skillsDir, 'spot-narrator/references/narration-kb');
const model = config.minimax.narrationModel;
const canSpeak = !!(config.minimax.apiKey || config.minimax.mcpUrl);

let chars = 0;
let ok = 0;
let fail = 0;
const rows = [];
for (const entry of kbIndex()) {
  const card = parseCard(fs.readFileSync(path.join(kbDir, entry.file), 'utf8'));
  for (const style of STYLES) {
    const text = composeNarration(entry.name, card, style);
    chars += text.length;
    let status = '仅文字';
    if (canSpeak) {
      const r = await speak({ text, kind: 'narration', style, cache_key: `${entry.name}:${style}` });
      status = r.ok ? (r.cached ? '已在缓存' : '已合成') : `失败：${r.error}`;
      r.ok ? ok++ : fail++;
    }
    rows.push(`${entry.name.padEnd(8, '　')} ${style.padEnd(8)} ${String(text.length).padStart(4)} 字  ${status}`);
  }
}
console.log(rows.join('\n'));
console.log(`\n共 ${rows.length} 段，${chars} 字；用 ${model} 全部合成约 ¥${ttsCostYuan(chars, model)}（按 .env 里的单价估算）`);
if (canSpeak) console.log(`合成成功 ${ok}，失败 ${fail}`);
else console.log('未配置 MiniMax，只做了文字估算。配置 MINIMAX_API_KEY 后再运行即可写入音频缓存。');
await closeAllMcp();
