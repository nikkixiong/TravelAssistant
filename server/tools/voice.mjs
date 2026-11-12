// 语音合成：MiniMax MCP → MiniMax REST，两级都失败就返回 ok:false（上层只给文字稿）。
// 讲解按「景点:风格」缓存，热门讲解预生成一次，之后重复播放零成本、零等待。
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { config } from '../config.mjs';
import { getMcp, withTimeout } from '../mcp-client.mjs';

const dir = config.paths.audioCache;
fss.mkdirSync(dir, { recursive: true });

const SPEED = { elder: 0.9, kids: 1.0, default: 1.0 };
const keyFile = (k) => crypto.createHash('sha1').update(k).digest('hex').slice(0, 16);

export function ttsCostYuan(chars, model) {
  const per10k = /hd/.test(model) ? config.minimax.priceHd : config.minimax.priceTurbo;
  return +((chars / 10000) * per10k).toFixed(4);
}

async function readCache(cacheKey) {
  const base = path.join(dir, keyFile(cacheKey));
  try {
    const meta = JSON.parse(await fs.readFile(`${base}.json`, 'utf8'));
    const hasAudio = fss.existsSync(`${base}.mp3`);
    return { ...meta, url: hasAudio ? `/audio/${path.basename(base)}.mp3` : null };
  } catch {
    return null;
  }
}

async function viaMcp(text, model, speed) {
  const conn = getMcp('minimax');
  if (!conn) throw new Error('未配置 MiniMax MCP');
  const out = path.join(os.tmpdir(), 'hz-guide-tts');
  await fs.mkdir(out, { recursive: true });
  const res = await conn.call(
    'text_to_audio',
    { text, voice_id: config.minimax.voiceId, model, speed, format: 'mp3', language_boost: 'Chinese', output_directory: out },
    30000,
  );
  const m = res.match(/([^\s"']+\.mp3(?:\?[^\s"']*)?)/i);
  if (!m) throw new Error(`MCP 返回里没有音频：${res.slice(0, 120)}`);
  const ref = m[1].replace(/&amp;/g, '&');
  if (/^https?:/i.test(ref)) {
    const r = await fetch(ref);
    if (!r.ok) throw new Error(`下载 MCP 音频失败 HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const buf = await fs.readFile(ref);
  await fs.unlink(ref).catch(() => {});
  return buf;
}

async function viaRest(text, model, speed) {
  if (!config.minimax.apiKey) throw new Error('未配置 MINIMAX_API_KEY');
  const qs = config.minimax.groupId ? `?GroupId=${config.minimax.groupId}` : '';
  const resp = await withTimeout(
    fetch(`${config.minimax.host}/v1/t2a_v2${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.minimax.apiKey}` },
      body: JSON.stringify({
        model,
        text,
        stream: false,
        output_format: 'hex',
        language_boost: 'Chinese',
        voice_setting: { voice_id: config.minimax.voiceId, speed, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      }),
    }),
    30000,
    'MiniMax TTS 超时',
  );
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.base_resp?.status_code !== 0 || !data?.data?.audio) {
    throw new Error(`MiniMax TTS 失败：${data?.base_resp?.status_msg || `HTTP ${resp.status}`}`);
  }
  return Buffer.from(data.data.audio, 'hex');
}

/**
 * kind: narration（讲解，用 hd）| chat（对话，用 turbo）
 * cache_key: 例如 "断桥残雪:elder"。只传 cache_key 不传 text = 只查缓存。
 */
export async function speak({ text = '', kind = 'chat', cache_key, style = 'default' }) {
  const model = kind === 'narration' ? config.minimax.narrationModel : config.minimax.chatModel;
  const speed = SPEED[style] ?? 1.0;

  if (cache_key) {
    const hit = await readCache(cache_key);
    if (hit?.url && (!text || hit.text === text)) {
      return { ok: true, cached: true, url: hit.url, text: hit.text, model: hit.model, chars: hit.text.length, cost_yuan: 0 };
    }
    if (!text) return { ok: true, cached: false, hit: false, message: '缓存未命中，请写好讲解稿后再调用一次 tts_speak（带 text）' };
  }
  if (!text) return { ok: false, error: 'text 不能为空' };

  const key = cache_key || `${model}:${speed}:${text}`;
  const errors = [];
  for (const [source, fn] of [['minimax-mcp', viaMcp], ['minimax-rest', viaRest]]) {
    try {
      const buf = await fn(text, model, speed);
      const base = path.join(dir, keyFile(key));
      await fs.writeFile(`${base}.mp3`, buf);
      await fs.writeFile(`${base}.json`, JSON.stringify({ text, model, style, cache_key: key, created: new Date().toISOString() }));
      return { ok: true, cached: false, source, url: `/audio/${path.basename(base)}.mp3`, model, chars: text.length, cost_yuan: ttsCostYuan(text.length, model) };
    } catch (e) {
      errors.push(`${source}: ${e.message}`);
    }
  }
  return { ok: false, error: '语音暂不可用', detail: errors, text };
}

/** 预生成脚本用：只写文字缓存（没有 key 时也能先把稿子缓存下来） */
export async function saveTextOnly(cacheKey, text, style) {
  const base = path.join(dir, keyFile(cacheKey));
  await fs.writeFile(`${base}.json`, JSON.stringify({ text, style, cache_key: cacheKey, created: new Date().toISOString() }));
}
