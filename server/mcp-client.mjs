// 读取项目根目录的 mcp.json（和 Trae / Claude 等工具用的是同一份配置），
// 按需连接 MCP Server，并统一处理超时、重连和「连不上就先别再试」。
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, config } from './config.mjs';

const RETRY_AFTER_MS = 5 * 60 * 1000;

function loadServerConfigs() {
  const file = path.join(ROOT, 'mcp.json');
  if (!fs.existsSync(file)) return {};
  const vars = { ...process.env, MINIMAX_API_HOST: config.minimax.host };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {};
  const out = {};
  for (const [name, def] of Object.entries(raw)) {
    let missing = false;
    const sub = (v) =>
      typeof v === 'string'
        ? v.replace(/\$\{(\w+)\}/g, (_, k) => {
            if (!vars[k]) missing = true;
            return vars[k] || '';
          })
        : v;
    const resolved = JSON.parse(JSON.stringify(def), (_k, v) => sub(v));
    if (missing || def.disabled) continue; // 缺 key 的 server 直接不启用
    out[name] = resolved;
  }
  return out;
}

class McpConnection {
  constructor(name, def) {
    this.name = name;
    this.def = def;
    this.client = null;
    this.failedAt = 0;
    this.lastError = '';
    this.tools = [];
  }

  get available() {
    return !this.failedAt || Date.now() - this.failedAt > RETRY_AFTER_MS;
  }

  async connect() {
    if (this.client) return this.client;
    if (!this.available) throw new Error(`MCP ${this.name} 暂不可用：${this.lastError}`);
    const attempts = [];
    if (this.def.url) {
      attempts.push(() => new StreamableHTTPClientTransport(new URL(this.def.url)));
      if (/\/mcp(\?|$)/.test(this.def.url)) {
        attempts.push(() => new SSEClientTransport(new URL(this.def.url.replace(/\/mcp(\?|$)/, '/sse$1'))));
      }
    } else if (this.def.command) {
      attempts.push(
        () =>
          new StdioClientTransport({
            command: this.def.command,
            args: this.def.args || [],
            env: { ...process.env, ...(this.def.env || {}) },
            cwd: ROOT,
            stderr: 'ignore',
          }),
      );
    }
    let lastErr;
    for (const make of attempts) {
      const client = new Client({ name: 'hangzhou-guide-agent', version: '2.0.0' }, { capabilities: {} });
      try {
        await withTimeout(client.connect(make()), 15000, `连接 ${this.name} 超时`);
        const { tools } = await withTimeout(client.listTools(), 10000, `${this.name} listTools 超时`);
        this.client = client;
        this.tools = tools.map((t) => t.name);
        this.failedAt = 0;
        return client;
      } catch (e) {
        lastErr = e;
        await client.close().catch(() => {});
      }
    }
    this.failedAt = Date.now();
    this.lastError = lastErr?.message || '无法连接';
    throw new Error(`MCP ${this.name} 连接失败：${this.lastError}`);
  }

  async call(tool, args, timeoutMs = 10000) {
    const client = await this.connect();
    try {
      const res = await withTimeout(client.callTool({ name: tool, arguments: args }), timeoutMs, `${this.name}.${tool} 超时`);
      if (res.isError) throw new Error(textOf(res).slice(0, 300) || `${tool} 返回错误`);
      return textOf(res);
    } catch (e) {
      // 连接级错误时丢掉 client，下次重连
      if (/超时|closed|ECONN|fetch failed|socket/i.test(e.message)) {
        await this.client?.close().catch(() => {});
        this.client = null;
      }
      throw e;
    }
  }
}

function textOf(res) {
  return (res?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

export function withTimeout(promise, ms, msg) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(msg)), ms)))]).finally(() =>
    clearTimeout(t),
  );
}

const connections = new Map();
export function getMcp(name) {
  if (!connections.has(name)) {
    const defs = loadServerConfigs();
    connections.set(name, defs[name] ? new McpConnection(name, defs[name]) : null);
  }
  return connections.get(name);
}

export function mcpStatus() {
  const defs = loadServerConfigs();
  return Object.keys(defs).map((name) => {
    const c = connections.get(name);
    return { name, connected: !!c?.client, tools: c?.tools || [], lastError: c?.lastError || '' };
  });
}

export async function closeAllMcp() {
  for (const c of connections.values()) await c?.client?.close().catch(() => {});
}
