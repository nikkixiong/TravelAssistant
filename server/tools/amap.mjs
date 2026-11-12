// 高德能力层。每个能力都按「高德 MCP → 高德 REST → 本地缓存」三级降级，
// 返回结果里带 source 字段，前端和 trace 都能看到这次数据是从哪来的。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.mjs';
import { getMcp, withTimeout } from '../mcp-client.mjs';
import { loadSpots, findSpot, haversineM, parseMarkdownTable, parseCoord } from '../../.trae/skills/trip-planner/scripts/spots.mjs';

const REST = 'https://restapi.amap.com/v3';
const CITY = '杭州';
const CITY_ADCODE = '330100';

// ───────────── 通用 ─────────────
function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/[{[][\s\S]*[}\]]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return null;
  }
}

function deepFind(obj, pred, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (pred(k, v)) return v;
    const r = deepFind(v, pred, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

async function mcpCall(tool, args) {
  const conn = getMcp('amap-maps');
  if (!conn) throw new Error('未配置高德 MCP');
  // 重试 1 次
  try {
    return parseJSON(await conn.call(tool, args, config.amap.timeoutMs));
  } catch (e) {
    if (!conn.available) throw e;
    return parseJSON(await conn.call(tool, args, config.amap.timeoutMs));
  }
}

async function restCall(endpoint, params) {
  if (!config.amap.key) throw new Error('未配置 AMAP_KEY');
  const url = new URL(`${REST}/${endpoint}`);
  url.search = new URLSearchParams({ key: config.amap.key, ...params }).toString();
  const resp = await withTimeout(fetch(url), config.amap.timeoutMs, `高德 REST ${endpoint} 超时`);
  const data = await resp.json();
  if (data.status !== '1') throw new Error(`高德 REST ${endpoint}：${data.info || '失败'}`);
  return data;
}

/** 依次尝试多个数据源，第一个成功的返回；全部失败用 fallback。 */
async function tiered(steps, fallback) {
  const errors = [];
  for (const [source, fn] of steps) {
    try {
      const r = await fn();
      if (r) return { ...r, source, ...(errors.length ? { degraded_from: errors } : {}) };
      errors.push(`${source}: 结果为空`);
    } catch (e) {
      errors.push(`${source}: ${e.message}`);
    }
  }
  return { ...fallback(), source: 'local-cache', estimated: true, degraded_from: errors };
}

const lngLat = (loc) => (loc ? `${loc.lng.toFixed(6)},${loc.lat.toFixed(6)}` : '');

function normalizePoi(p, origin) {
  const location = typeof p.location === 'string' ? parseCoord(p.location) : p.location || null;
  const dist = Number(p.distance) || (origin && location ? Math.round(haversineM(origin, location)) : null);
  const rating = Number(p?.biz_ext?.rating || p.rating) || null;
  const cost = Number(p?.biz_ext?.cost || p.cost) || null;
  return {
    name: p.name,
    address: Array.isArray(p.address) ? '' : p.address || '',
    type: p.type || p.typecode || '',
    location,
    distance_m: dist,
    ...(rating ? { rating } : {}),
    ...(cost ? { avg_cost: cost } : {}),
    ...(p.business_status || p.status ? { status: p.business_status || p.status } : {}),
  };
}

// ───────────── 地点解析 ─────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const RESTAURANT_FILE = path.resolve(here, '../../.trae/skills/local-food/references/restaurants-cache.md');
let restaurantCache;
export function loadRestaurants() {
  if (!restaurantCache) {
    restaurantCache = parseMarkdownTable(fs.readFileSync(RESTAURANT_FILE, 'utf8')).map((r) => ({
      name: r['名称'],
      location: parseCoord(r['坐标']),
      type: r['类型'],
      taste: r['口味'],
      suits: r['适合'],
      note: r['备注'],
    }));
  }
  return restaurantCache;
}

/** 只查本地表：餐厅缓存优先精确匹配，再查景点表 */
export function locateLocal(name) {
  const rest = loadRestaurants().find((r) => r.name === name);
  if (rest) return rest.location;
  const spot = findSpot(name);
  if (spot) return spot.location;
  const fuzzy = loadRestaurants().find((r) => name.includes(r.name.replace(/（.*）/, '')) || r.name.includes(name));
  return fuzzy?.location || null;
}

export async function resolvePlace(name) {
  if (!name) return null;
  const coord = parseCoord(name);
  if (coord && /^\s*\d/.test(name)) return { name, location: coord, source: 'input' };
  const exactRest = loadRestaurants().find((r) => r.name === name);
  if (exactRest) return { name: exactRest.name, location: exactRest.location, source: 'restaurants-cache' };
  const spot = findSpot(name);
  if (spot) return { name: spot.name, location: spot.location, source: 'spots-table' };
  const rest = loadRestaurants().find((r) => r.name.includes(name) || name.includes(r.name.replace(/（.*）/, '')));
  if (rest) return { name: rest.name, location: rest.location, source: 'restaurants-cache' };
  const r = await tiered(
    [
      ['amap-mcp', async () => {
        const d = await mcpCall('maps_geo', { address: name, city: CITY });
        const loc = deepFind(d, (k, v) => k === 'location' && typeof v === 'string');
        return loc ? { location: parseCoord(loc) } : null;
      }],
      ['amap-rest', async () => {
        const d = await restCall('geocode/geo', { address: name, city: CITY });
        const loc = d.geocodes?.[0]?.location;
        return loc ? { location: parseCoord(loc) } : null;
      }],
    ],
    () => ({ location: null }),
  );
  return r.location ? { name, location: r.location, source: r.source } : null;
}

// ───────────── POI 搜索 ─────────────
export async function textSearch({ keywords, city = CITY }) {
  return tiered(
    [
      ['amap-mcp', async () => {
        const d = await mcpCall('maps_text_search', { keywords, city });
        const pois = (d?.pois || []).map((p) => normalizePoi(p));
        return pois.length ? { pois: pois.slice(0, 10) } : null;
      }],
      ['amap-rest', async () => {
        const d = await restCall('place/text', { keywords, city, citylimit: 'true', offset: '10', extensions: 'all' });
        return { pois: (d.pois || []).map((p) => normalizePoi(p)) };
      }],
    ],
    () => {
      const spots = loadSpots().filter(
        (s) => s.name.includes(keywords) || keywords.includes(s.name) || s.aliases.some((a) => keywords.includes(a)),
      );
      return { pois: spots.map((s) => ({ name: s.name, address: `${s.area}`, type: '风景名胜', location: s.location })) };
    },
  );
}

export async function aroundSearch({ location, keywords = '餐厅', radius = 1000 }) {
  const place = await resolvePlace(location);
  if (!place?.location) return { ok: false, error: `无法确定「${location}」的位置` };
  const origin = place.location;
  const r = await tiered(
    [
      ['amap-mcp', async () => {
        const d = await mcpCall('maps_around_search', { keywords, location: lngLat(origin), radius: String(radius) });
        const pois = (d?.pois || []).map((p) => normalizePoi(p, origin));
        // MCP 返回里没有坐标/距离时，结果无法按距离筛，交给下一级
        return pois.length && pois.some((p) => p.distance_m != null) ? { pois } : null;
      }],
      ['amap-rest', async () => {
        const d = await restCall('place/around', {
          location: lngLat(origin), keywords, radius: String(radius), sortrule: 'distance', offset: '20', extensions: 'all',
        });
        return { pois: (d.pois || []).map((p) => normalizePoi(p, origin)) };
      }],
    ],
    () => {
      const kw = keywords.replace(/餐厅|美食|吃饭/g, '');
      const pois = loadRestaurants()
        .map((r) => ({
          name: r.name, address: r.note, type: r.type, taste: r.taste, suits: r.suits, location: r.location,
          distance_m: Math.round(haversineM(origin, r.location) * 1.3),
        }))
        .filter((p) => p.distance_m <= radius * 1.5 && (!kw || p.type.includes(kw) || p.name.includes(kw) || /茶/.test(kw) === /茶/.test(p.type)))
        .sort((a, b) => a.distance_m - b.distance_m);
      return { pois, note: '离线缓存数据，店铺信息可能已变化' };
    },
  );
  return { center: place.name, radius, ...r, pois: (r.pois || []).filter((p) => p.distance_m == null || p.distance_m <= radius * 1.5).slice(0, 15) };
}

// ───────────── 天气 ─────────────
export async function weather({ city = CITY, date } = {}) {
  const r = await tiered(
    [
      ['amap-mcp', async () => {
        const d = await mcpCall('maps_weather', { city });
        const casts = d?.forecasts?.[0]?.casts || d?.forecasts || deepFind(d, (k, v) => k === 'casts' && Array.isArray(v));
        return Array.isArray(casts) && casts.length ? { forecasts: casts } : null;
      }],
      ['amap-rest', async () => {
        const d = await restCall('weather/weatherInfo', { city: CITY_ADCODE, extensions: 'all' });
        return { forecasts: d.forecasts?.[0]?.casts || [] };
      }],
    ],
    () => ({ forecasts: [], note: '天气服务暂不可用，请出发前自行确认' }),
  );
  const forecasts = (r.forecasts || []).map((c) => ({
    date: c.date, week: c.week, day: c.dayweather, night: c.nightweather, high: c.daytemp, low: c.nighttemp,
  }));
  const target = date ? forecasts.find((f) => f.date === date) : forecasts[0];
  let note = r.note;
  if (!target && date && forecasts.length) note = `${date} 超出预报范围（只有未来 4 天）`;
  return {
    city,
    source: r.source,
    ...(r.degraded_from ? { degraded_from: r.degraded_from } : {}),
    forecasts,
    on_date: target || null,
    ...(note ? { note } : {}),
  };
}

// ───────────── 路线 ─────────────
const MODE_NAMES = { walking: '步行', transit: '公交', taxi: '打车' };
const NAV_MODE = { walking: 'walk', transit: 'bus', taxi: 'car' };

function estimateLeg(a, b, mode, slow) {
  const straight = haversineM(a, b);
  if (mode === 'walking') {
    const d = straight * 1.3;
    return { distance_m: Math.round(d), duration_min: Math.max(3, Math.round((d / 1000 / (slow ? 3 : 4.2)) * 60)) };
  }
  const d = straight * 1.4;
  const speed = mode === 'taxi' ? 20 : 15;
  const wait = mode === 'taxi' ? 6 : 12;
  return { distance_m: Math.round(d), duration_min: Math.round((d / 1000 / speed) * 60 + wait), walking_m: mode === 'transit' ? 400 : 0 };
}

async function realLeg(a, b, mode) {
  const o = lngLat(a);
  const d = lngLat(b);
  return tiered(
    [
      ['amap-mcp', async () => {
        const tool = mode === 'walking' ? 'maps_direction_walking' : mode === 'transit' ? 'maps_direction_transit_integrated' : 'maps_direction_driving';
        const args = mode === 'transit' ? { origin: o, destination: d, city: CITY, cityd: CITY } : { origin: o, destination: d };
        const data = await mcpCall(tool, args);
        const dist = Number(deepFind(data, (k, v) => k === 'distance' && !Number.isNaN(Number(v))));
        const dur = Number(deepFind(data, (k, v) => k === 'duration' && !Number.isNaN(Number(v))));
        return dist && dur ? { distance_m: dist, duration_min: Math.round(dur / 60) + (mode === 'taxi' ? 5 : 0) } : null;
      }],
      ['amap-rest', async () => {
        if (mode === 'walking') {
          const r = await restCall('direction/walking', { origin: o, destination: d });
          const p = r.route?.paths?.[0];
          return p ? { distance_m: Number(p.distance), duration_min: Math.round(Number(p.duration) / 60) } : null;
        }
        if (mode === 'transit') {
          const r = await restCall('direction/transit/integrated', { origin: o, destination: d, city: CITY });
          const t = r.route?.transits?.[0];
          return t ? { distance_m: Number(r.route.distance), duration_min: Math.round(Number(t.duration) / 60), walking_m: Number(t.walking_distance) || 0 } : null;
        }
        const r = await restCall('direction/driving', { origin: o, destination: d });
        const p = r.route?.paths?.[0];
        return p ? { distance_m: Number(p.distance), duration_min: Math.round(Number(p.duration) / 60) + 5 } : null;
      }],
    ],
    () => null,
  );
}

/**
 * points：按顺序的地点名或 "lng,lat"
 * mode：walking | transit | taxi | auto（auto：短距离步行，远了长辈打车、其他人公交）
 */
export async function route({ points = [], mode = 'auto', party = {} }) {
  if (points.length < 2) return { ok: false, error: '至少需要 2 个地点' };
  const places = await Promise.all(points.map((p) => resolvePlace(p)));
  const missing = points.filter((_, i) => !places[i]?.location);
  if (missing.length) return { ok: false, error: `找不到这些地点的坐标：${missing.join('、')}` };

  const slow = (party.elderly || 0) > 0 || party.mobility === 'knee' || party.mobility === 'wheelchair';
  const walkThreshold = slow ? 1200 : 2000;

  const legs = await Promise.all(
    places.slice(0, -1).map(async (a, i) => {
      const b = places[i + 1];
      let m = mode;
      if (mode === 'auto') {
        const straight = haversineM(a.location, b.location) * 1.3;
        m = straight <= walkThreshold ? 'walking' : slow ? 'taxi' : 'transit';
      }
      const est = estimateLeg(a.location, b.location, m, slow);
      const real = await realLeg(a.location, b.location, m);
      const useReal = real && real.source !== 'local-cache' && real.distance_m;
      const leg = useReal ? { distance_m: real.distance_m, duration_min: real.duration_min, walking_m: real.walking_m } : est;
      // 长辈步速慢，真实步行时间也放大一点
      if (useReal && m === 'walking' && slow) leg.duration_min = Math.round(leg.duration_min * 1.3);
      return {
        from: a.name, to: b.name, mode: m, mode_name: MODE_NAMES[m],
        distance_m: leg.distance_m, duration_min: leg.duration_min,
        ...(leg.walking_m ? { walking_m: leg.walking_m } : {}),
        estimated: !useReal, source: useReal ? real.source : 'local-estimate',
        from_location: a.location, to_location: b.location,
        nav_url: navUrl(a, b, m),
      };
    }),
  );
  return {
    ok: true,
    legs,
    total_minutes: legs.reduce((s, l) => s + l.duration_min, 0),
    walking_km: +(legs.filter((l) => l.mode === 'walking').reduce((s, l) => s + l.distance_m, 0) / 1000).toFixed(1),
    estimated: legs.some((l) => l.estimated),
    ...(legs.some((l) => l.estimated) ? { note: '部分路线时长为估算' } : {}),
  };
}

export function navUrl(a, b, mode = 'walking') {
  const q = new URLSearchParams({
    from: `${lngLat(a.location)},${a.name}`,
    to: `${lngLat(b.location)},${b.name}`,
    mode: NAV_MODE[mode] || 'walk',
    callnative: '1',
    src: 'hangzhou-guide-agent',
  });
  return `https://uri.amap.com/navigation?${q}`;
}

export function markersUrl(places) {
  const markers = places.filter((p) => p.location).map((p) => `${lngLat(p.location)},${p.name}`).join('|');
  return `https://uri.amap.com/marker?${new URLSearchParams({ markers, src: 'hangzhou-guide-agent', callnative: '1' })}`;
}

// ───────────── 逆地理编码 ─────────────
export async function regeocode({ location }) {
  const loc = parseCoord(location);
  if (!loc) return { ok: false, error: 'location 应为 "经度,纬度"' };
  const nearest = loadSpots()
    .map((s) => ({ name: s.name, distance_m: Math.round(haversineM(loc, s.location)) }))
    .sort((a, b) => a.distance_m - b.distance_m)[0];
  const r = await tiered(
    [
      ['amap-mcp', async () => {
        const d = await mcpCall('maps_regeocode', { location: lngLat(loc) });
        const addr = deepFind(d, (k, v) => /formatted_address|address/.test(k) && typeof v === 'string');
        return addr ? { address: addr } : null;
      }],
      ['amap-rest', async () => {
        const d = await restCall('geocode/regeo', { location: lngLat(loc) });
        return { address: d.regeocode?.formatted_address };
      }],
    ],
    () => ({ address: '' }),
  );
  return { ...r, nearest_spot: nearest };
}
