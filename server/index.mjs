// 杭州随身导游 Agent —— HTTP 服务
// POST /api/chat 以 SSE 流式推送 Agent 的每一步（加载 Skill、调用工具、方案、语音、回复）
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { config, describeConfig, ROOT } from './config.mjs';
import { getSession, resetSession, runTurn } from './agent.mjs';
import { confirmPlan } from './tools/plan.mjs';
import { getProfile, deleteProfile } from './memory.mjs';
import { readTraces } from './trace.mjs';
import { listSkills } from './skills.mjs';
import { mcpStatus, closeAllMcp } from './mcp-client.mjs';
import { loadSpots } from '../.trae/skills/trip-planner/scripts/spots.mjs';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/audio', express.static(config.paths.audioCache));
app.use('/cards', express.static(config.paths.cards));
app.use('/legacy', express.static(path.join(ROOT, 'legacy'))); // 年初版，留作对比

const busy = new Set();

app.get('/api/config', (_req, res) => {
  res.json({
    ...describeConfig(),
    skills: listSkills(),
    spots: loadSpots().map((s) => ({ name: s.name, area: s.area, location: s.location })),
  });
});

app.post('/api/chat', async (req, res) => {
  const { sessionId, userId = 'demo', text, choice, context } = req.body || {};
  const session = getSession(sessionId, userId);
  if (busy.has(session.id)) return res.status(409).json({ error: '上一条消息还在处理中' });
  busy.add(session.id);

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const emit = (type, data) => res.write(`data: ${JSON.stringify({ type, sessionId: session.id, ...data })}\n\n`);
  emit('session', {});
  try {
    await runTurn(session, { text, choice, context }, emit);
  } catch (e) {
    console.error('[chat]', e);
    emit('error', { text: e.message });
  } finally {
    busy.delete(session.id);
    res.end();
  }
});

app.get('/api/session/:id', (req, res) => {
  const s = getSession(req.params.id);
  res.json({ plan: s.plan, pendingOptions: s.pendingOptions, pendingAsk: s.pendingAsk });
});

app.post('/api/session/:id/plan/confirm', (req, res) => {
  res.json(confirmPlan(getSession(req.params.id)));
});

app.post('/api/session/:id/reset', (req, res) => {
  resetSession(req.params.id);
  res.json({ ok: true });
});

app.get('/api/memory', (req, res) => res.json({ profile: getProfile(req.query.user || 'demo') }));
app.delete('/api/memory', (req, res) => res.json(deleteProfile(req.query.user || 'demo')));

app.get('/api/traces/:sessionId', (req, res) => res.json({ traces: readTraces(req.params.sessionId) }));
app.get('/api/mcp/status', (_req, res) => res.json({ servers: mcpStatus() }));

const server = app.listen(config.port, () => {
  const c = describeConfig();
  console.log('\n🧭 杭州随身导游 Agent 已启动');
  console.log(`   页面：http://localhost:${config.port}`);
  console.log(`   模型：${c.llm}`);
  console.log(`   地图：${c.amap}    语音：${c.tts}`);
  console.log(`   Skills：${listSkills().map((s) => s.name).join(', ')}\n`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\n❌ 端口 ${config.port} 被占用，关掉旧进程或在 .env 里改 PORT\n`);
  else console.error(err);
  process.exit(1);
});
process.on('SIGINT', async () => {
  await closeAllMcp();
  process.exit(0);
});
