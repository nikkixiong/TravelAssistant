#!/usr/bin/env node
// 连通性自检：逐个检查大模型、高德 MCP / REST、MiniMax 语音是否可用。
// 第一次配好 .env 后先跑这个，比直接开页面排查快得多。
import { config, describeConfig } from '../server/config.mjs';
import { getMcp, closeAllMcp } from '../server/mcp-client.mjs';
import { createOpenAIProvider } from '../server/providers/openai.mjs';
import * as amap from '../server/tools/amap.mjs';
import { speak } from '../server/tools/voice.mjs';

const line = (ok, name, detail = '') => console.log(`${ok === null ? '⚪' : ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);

console.log('\n当前配置：', describeConfig(), '\n');

// 1. 大模型
if (config.llm.provider === 'rule') line(null, '大模型', '未配置 LLM_API_KEY / MINIMAX_API_KEY，使用规则基线');
else {
  try {
    const r = await createOpenAIProvider().chat({
      messages: [{ role: 'user', content: '回复「好」' }],
      tools: [{ type: 'function', function: { name: 'noop', description: '测试', parameters: { type: 'object', properties: {} } } }],
    });
    line(true, `大模型 ${config.llm.model}`, `${r.ms}ms，回复：${String(r.message.content).replace(/<think>[\s\S]*?<\/think>/g, '').slice(0, 30)}`);
  } catch (e) {
    line(false, `大模型 ${config.llm.model}`, e.message);
  }
}

// 2. 高德 MCP
const amapMcp = getMcp('amap-maps');
if (!amapMcp) line(null, '高德 MCP', '未配置 AMAP_KEY');
else {
  try {
    await amapMcp.connect();
    line(true, '高德 MCP', `工具：${amapMcp.tools.join(', ')}`);
  } catch (e) {
    line(false, '高德 MCP', e.message);
  }
}

// 3. 高德能力（会自动走 MCP → REST → 离线缓存）
const w = await amap.weather({});
line(w.source !== 'local-cache', '高德·天气', `来源 ${w.source}${w.forecasts[0] ? `，${w.forecasts[0].date} ${w.forecasts[0].day}` : ''}${w.degraded_from ? `；降级原因：${w.degraded_from.join(' | ')}` : ''}`);
const r = await amap.route({ points: ['断桥残雪', '雷峰塔'], mode: 'walking' });
line(r.ok && !r.estimated, '高德·路线', r.ok ? `${r.legs[0].distance_m} 米 / ${r.legs[0].duration_min} 分钟（来源 ${r.legs[0].source}）` : r.error);
const s = await amap.aroundSearch({ location: '断桥残雪', keywords: '杭帮菜', radius: 1000 });
line(s.source !== 'local-cache', '高德·周边搜索', `来源 ${s.source}，${s.pois?.length || 0} 个结果`);

// 4. MiniMax 语音
if (!config.minimax.apiKey && !config.minimax.mcpUrl && !getMcp('minimax')) line(null, 'MiniMax 语音', '未配置 MINIMAX_API_KEY');
else {
  const t = await speak({ text: '你好，欢迎来杭州。', kind: 'chat' });
  line(t.ok, 'MiniMax 语音', t.ok ? `来源 ${t.source}，${t.url}` : (t.detail || [t.error]).join(' | '));
}

await closeAllMcp();
console.log('');
process.exit(0);
