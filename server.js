/**
 * 杭州旅游助手 - 本地代理服务
 *
 * 职责：
 *  1. 将 MiniMax API Key 保存在服务器端 .env，永不下发到浏览器。
 *  2. 暴露 POST /api/speak 接口，接收景点名 → 返回 AI 导游词 + 语音流。
 *  3. TTS 优先通过 MiniMax-MCP (text_to_audio) 生成；若 MCP 不可用则
 *     降级至直接调用 MiniMax REST API。
 *  4. 同时提供静态文件服务，直接托管 index.html。
 */

import 'dotenv/config';
import express      from 'express';
import cors         from 'cors';
import fs           from 'fs/promises';
import os           from 'os';
import path         from 'path';
import { Client }                        from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ──────────────────────────────────────────────────────────────
// 环境变量
// ──────────────────────────────────────────────────────────────
const {
  MINIMAX_API_KEY,
  MINIMAX_GROUP_ID,
  MCP_SERVER_URL,
  PORT = 3001,
} = process.env;

if (!MINIMAX_API_KEY) {
  console.error('❌  缺少 MINIMAX_API_KEY，请检查 .env 文件');
  process.exit(1);
}
if (!MINIMAX_GROUP_ID) {
  console.error('❌  缺少 MINIMAX_GROUP_ID，请检查 .env 文件');
  process.exit(1);
}

// api.minimax.chat（中国区）必须在 URL 中携带 GroupId 参数
const LLM_URL = `https://api.minimax.chat/v1/text/chatcompletion_v2?GroupId=${MINIMAX_GROUP_ID}`;
const TTS_URL = `https://api.minimax.chat/v1/t2a_v2?GroupId=${MINIMAX_GROUP_ID}`;

// ──────────────────────────────────────────────────────────────
// Express 初始化
// ──────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: '*',
  // 允许浏览器读取自定义响应头（导游词文本）
  exposedHeaders: ['X-Guide-Text'],
}));

app.use(express.json());

// 将当前目录作为静态文件根目录，方便直接访问 index.html
app.use(express.static(path.resolve('.')));

// ──────────────────────────────────────────────────────────────
// 本地模板：当 LLM 不可用时，用关键词匹配生成兜底导游词
// ──────────────────────────────────────────────────────────────
const TEMPLATE_MAP = [
  { keys: ['西湖'],     text: '西湖，白娘子与许仙爱情传说的发源地，苏堤春晓、断桥残雪都是千年胜景，来了就不想走！' },
  { keys: ['灵隐'],     text: '灵隐寺建于东晋咸和元年，距今近1700年，是江南著名古刹，飞来峰石刻更是宝贝！' },
  { keys: ['雷峰'],     text: '雷峰塔曾因白娘子传说家喻户晓，现存宝塔建于2002年，塔内藏有吴越国文物！' },
  { keys: ['断桥'],     text: '断桥残雪是西湖十景之首，每逢冬雪桥面形成"断"字奇观，是许仙白素贞相遇之处！' },
  { keys: ['龙井'],     text: '龙井是中国十大名茶之首，"色绿、香郁、味醇、形美"四绝，乾隆皇帝曾亲封18棵御茶树！' },
  { keys: ['苏堤'],     text: '苏堤由苏东坡任杭州知州时主持修建，全长2.8公里，"苏堤春晓"是西湖十景之冠！' },
  { keys: ['岳王','岳飞'], text: '岳王庙供奉民族英雄岳飞，"精忠报国"四字刻入历史，每年无数游客来此致敬！' },
  { keys: ['河坊街'],   text: '河坊街是杭州保存最完整的清末民初建筑群，胡庆余堂国药号就在这里，百年老字号！' },
  { keys: ['宋城'],     text: '宋城景区以"给你一个宋朝"为主题，宋城千古情演出已是中国最卖座的旅游演艺！' },
];

const CATEGORY_FALLBACKS = [
  {
    keys: ['寺', '庙', '观', '祠', '塔', '阁'],
    texts: [
      '这里历史底蕴很足，建筑细节和碑刻都值得慢慢看。',
      '这类人文古迹最适合放慢节奏，留意匾额与石刻中的故事。',
    ],
  },
  {
    keys: ['公园', '山', '湖', '江', '湿地', '景区', '古镇', '步行街', '园'],
    texts: [
      '自然景观和城市气质融合得很好，建议边走边拍。',
      '这片区域四季景色都不错，清晨或傍晚体验更舒服。',
    ],
  },
  {
    keys: ['店', '餐厅', '饭店', '米线', '面', '火锅', '咖啡', '茶', '甜品', '小吃'],
    texts: [
      '这是本地人常打卡的口味点，建议先试招牌再加特色单品。',
      '这家以稳定出品见长，适合短暂停留补充能量。',
    ],
  },
  {
    keys: ['博物馆', '美术馆', '纪念馆', '展馆'],
    texts: [
      '馆内信息密度高，建议先看导览图再按兴趣深挖。',
      '这类场馆很适合用一小时快速浏览主线，再挑重点细看。',
    ],
  },
];

function pickTextByName(poiName, texts) {
  const hash = Array.from(poiName).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return texts[hash % texts.length];
}

function getTemplateGuideText(poiName) {
  for (const { keys, text } of TEMPLATE_MAP) {
    if (keys.some(k => poiName.includes(k))) return text;
  }
  for (const { keys, texts } of CATEGORY_FALLBACKS) {
    if (keys.some(k => poiName.includes(k))) {
      return `欢迎来到${poiName}！${pickTextByName(poiName, texts)}`;
    }
  }
  return `欢迎来到${poiName}！这里值得你停下脚步看一看，常常会有意外惊喜。`;
}

let llmUnavailableReason = '';

// ──────────────────────────────────────────────────────────────
// Step 1：调用 MiniMax Chat API 生成景点导游词（服务器侧，密钥安全）
// LLM 调用失败时自动降级至本地模板，保证语音链路不中断。
// ──────────────────────────────────────────────────────────────
async function generateGuideText(poiName) {
  if (llmUnavailableReason) {
    const fallback = getTemplateGuideText(poiName);
    console.warn(`[LLM] ⚠️  已跳过云端生成（${llmUnavailableReason}），使用本地模板：${fallback}`);
    return fallback;
  }

  try {
    const resp = await fetch(LLM_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'abab6.5s-chat',
        messages: [
          {
            role:    'system',
            content: '你是一个幽默风趣的杭州本地导游。',
          },
          {
            role:    'user',
            content: `用户当前正在看【${poiName}】。请用一句亲切的话介绍一下这里，包含一点历史小知识，总字数严格控制在 50 字以内。`,
          },
        ],
        max_tokens: 120,
      }),
    });

    if (!resp.ok) {
      const msg = await resp.text().catch(() => '');
      throw new Error(`LLM HTTP ${resp.status}：${msg.slice(0, 200)}`);
    }

    const data = await resp.json();

    // 检查业务状态码
    const statusCode = data?.base_resp?.status_code;
    if (statusCode !== undefined && statusCode !== 0) {
      throw new Error(`LLM [${statusCode}]：${data?.base_resp?.status_msg}`);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM 返回内容为空');

    console.log(`[LLM] ✅ AI 生成：${content.trim()}`);
    return content.trim();

  } catch (llmErr) {
    const msg = llmErr?.message ?? 'unknown error';
    if (/token is unusable|LLM \[1004\]/i.test(msg)) {
      llmUnavailableReason = 'token 无效（1004），待更新 .env 后恢复';
    }

    // LLM 失败 → 降级至本地模板，TTS 语音链路继续正常运行
    const fallback = getTemplateGuideText(poiName);
    console.warn(`[LLM] ⚠️  失败（${msg}），已降级至本地模板：${fallback}`);
    return fallback;
  }
}

// ──────────────────────────────────────────────────────────────
// Step 2a（主路径）：通过 MiniMax-MCP text_to_audio 生成语音
//
// MCP text_to_audio 工具会把音频文件写入本地目录，
// 我们读取该文件后立即删除，将二进制数据返回给浏览器。
// ──────────────────────────────────────────────────────────────
async function generateAudioViaMCP(text) {
  if (!MCP_SERVER_URL) {
    throw new Error('MCP_SERVER_URL 未配置，跳过 MCP 路径');
  }

  // 临时目录：存放 MCP 工具写出的 mp3 文件
  const tempDir = path.join(os.tmpdir(), 'minimax-audio');
  await fs.mkdir(tempDir, { recursive: true });

  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL));
  const client    = new Client(
    { name: 'hangzhou-tour-proxy', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name:      'text_to_audio',
      arguments: {
        text,
        voice_id:         'female-tianmei',
        model:            'speech-01-turbo',
        speed:            1.0,
        language_boost:   'Chinese',
        format:           'mp3',
        output_directory: tempDir,
      },
    });

    // 工具返回文本内容中可能是本地文件路径，也可能是可访问的音频 URL
    const resultText = result?.content?.[0]?.text ?? '';
    // 匹配形如 /tmp/xxx.mp3 或 https://xxx.mp3?xxx=yyy（保留签名参数）
    const match = resultText.match(/([^\s"']+\.mp3(?:\?[^\s"']*)?)/i);
    if (!match) {
      throw new Error(`MCP 返回内容中未找到 mp3 路径：${resultText.slice(0, 200)}`);
    }

    const audioRef = match[1].replace(/&amp;/g, '&');
    let audioBuffer;

    if (/^https?:\/\//i.test(audioRef)) {
      // MCP 返回远程 URL：直接下载为二进制（部分返回会将 "/" 编码为 "%2F"）
      const candidates = [audioRef];
      if (audioRef.includes('%2F')) {
        candidates.push(audioRef.replace(/%2F/gi, '/'));
      }

      let lastErr;
      for (const url of candidates) {
        const remoteResp = await fetch(url);
        if (!remoteResp.ok) {
          lastErr = new Error(`MCP 音频 URL 下载失败 HTTP ${remoteResp.status}`);
          continue;
        }
        const arrayBuffer = await remoteResp.arrayBuffer();
        audioBuffer = Buffer.from(arrayBuffer);
        console.log(`[TTS] MCP URL 路径成功：${url}`);
        break;
      }

      if (!audioBuffer) {
        throw lastErr ?? new Error('MCP 音频 URL 下载失败');
      }
    } else {
      // MCP 返回本地文件路径：读取后删除临时文件
      audioBuffer = await fs.readFile(audioRef);
      await fs.unlink(audioRef).catch(() => {});
      console.log(`[TTS] MCP 本地文件路径成功：${audioRef}`);
    }

    return audioBuffer;

  } finally {
    // 无论成功还是失败，都关闭 MCP 连接
    await client.close().catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────────
// Step 2b（降级路径）：直接调用 MiniMax TTS REST API
// ──────────────────────────────────────────────────────────────
async function generateAudioViaAPI(text) {
  const resp = await fetch(TTS_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${MINIMAX_API_KEY}`,
    },
    body: JSON.stringify({
      model:          'speech-01-turbo',
      text,
      stream:         false,
      output_format:  'hex',
      language_boost: 'Chinese',
      voice_setting: {
        voice_id: 'female-tianmei',
        speed:    1.0,
        vol:      1.0,
        pitch:    0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate:     128000,
        format:      'mp3',
        channel:     1,
      },
    }),
  });

  if (!resp.ok) {
    const msg = await resp.text().catch(() => '');
    throw new Error(`TTS 接口异常 HTTP ${resp.status}：${msg.slice(0, 100)}`);
  }

  const data = await resp.json();

  if (data?.base_resp?.status_code !== 0) {
    throw new Error(
      `TTS 业务错误 [${data?.base_resp?.status_code}]：${data?.base_resp?.status_msg}`,
    );
  }
  if (!data?.data?.audio) {
    throw new Error('TTS 响应中 data.data.audio 为空');
  }

  // hex 字符串 → Buffer（Node.js 原生支持 Buffer.from(hex, 'hex')）
  const audioBuffer = Buffer.from(data.data.audio, 'hex');
  console.log('[TTS] REST API 路径成功，音频大小：', audioBuffer.length, 'bytes');
  return audioBuffer;
}

// ──────────────────────────────────────────────────────────────
// 核心接口：POST /api/speak
//
// 请求体：{ poiName: string }
// 响应：
//   - Header X-Guide-Text: URI 编码的导游词文本
//   - Body: audio/mpeg 二进制流
// ──────────────────────────────────────────────────────────────
app.post('/api/speak', async (req, res) => {
  const { poiName } = req.body ?? {};

  if (!poiName || typeof poiName !== 'string') {
    return res.status(400).json({ error: 'poiName 字段不能为空' });
  }

  console.log(`\n[/api/speak] 景点：${poiName}`);

  try {
    // ① 生成导游词文本（LLM 失败时内部自动降级至模板，不会抛出异常）
    const guideText = await generateGuideText(poiName);

    // ② 生成语音（MCP 优先，REST API 兜底）
    let audioBuffer;
    try {
      audioBuffer = await generateAudioViaMCP(guideText);
    } catch (mcpErr) {
      console.warn(`[TTS] MCP 不可用，切换至 REST API。原因：${mcpErr.message}`);
      audioBuffer = await generateAudioViaAPI(guideText);
    }

    // ③ 将导游词通过自定义响应头传给浏览器
    res.setHeader('X-Guide-Text', encodeURIComponent(guideText));
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.send(audioBuffer);

  } catch (err) {
    console.error('[/api/speak 错误]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// 健康检查接口（方便前端判断代理是否在线）
// ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status:       'ok',
    mcpConfigured: !!MCP_SERVER_URL,
    timestamp:    new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────────────────────
// 启动
// ──────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log('');
  console.log('🗺️  杭州旅游助手代理服务已启动');
  console.log(`   地址：http://localhost:${PORT}`);
  console.log(`   页面：http://localhost:${PORT}/index.html`);
  console.log(`   MCP ：${MCP_SERVER_URL ? '✅ 已配置' : '⚠️  未配置（将使用 REST API 降级）'}`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  端口 ${PORT} 已被占用，请先关闭旧进程：`);
    console.error(`   Windows PowerShell：netstat -ano | findstr :${PORT}  → taskkill /PID <PID> /F`);
    console.error(`   或直接关掉之前打开的 Terminal 里的 node server.js 进程\n`);
  } else {
    console.error('服务启动失败：', err);
  }
  process.exit(1);
});
