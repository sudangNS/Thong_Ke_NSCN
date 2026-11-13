/**
 * Cloudflare Pages Function: GET /api/sheet/:name[?refresh=1]
 *
 * Proxy đọc 1 tab Google Sheet (CSV) có cache nhiều tầng:
 *   1. Bộ nhớ isolate (mất khi isolate bị thu hồi)
 *   2. Workers KV (nếu có binding SHEET_CACHE) – dùng chung toàn cầu
 *      hoặc Cache API (mặc định) – dùng chung trong 1 data center
 *   3. Google Sheets (chỉ gọi khi cache hết hạn)
 *
 * Worker KHÔNG parse CSV (chỉ chuyển tiếp chuỗi) để giữ CPU < 10 ms (gói Free).
 * Cơ chế: TTL + stale-while-revalidate + làm mới thủ công có giới hạn tần suất.
 */

const DEFAULT_SHEET_ID = '1VVW7Zrdw-KmO2HLIh1nchKE8DRGWDtd2hCrS-e_aKUU';

// TTL (giây) theo mức độ thay đổi của từng bảng
const SHEETS = {
  mo_routing: { gid: '1233752704', ttl: 300 },   // tiến độ công đoạn – thay đổi thường xuyên
  mo:         { gid: '512575770',  ttl: 1800 },  // danh sách LSX
  mo_detail:  { gid: '1681627449', ttl: 1800 },  // dòng sản phẩm của LSX
  product:    { gid: '151523159',  ttl: 3600 },  // danh mục sản phẩm
  bom_wood:   { gid: '1862351213', ttl: 3600 },  // định mức gỗ (kích thước, NVL)
};

const MIN_FORCE_INTERVAL = 30; // giây – chặn bấm "Làm mới" liên tục gây 429 từ Google
const MAX_STALE_FACTOR = 24;   // phục vụ bản cũ tối đa ttl*24 trong lúc làm mới nền

const mem = new Map();      // name -> { body: ArrayBuffer, fetchedAt, sheetId }
const inflight = new Map(); // name -> Promise (gộp các request làm mới đồng thời)

export async function onRequestGet(ctx) {
  const { request, env, params } = ctx;
  const name = String(params.name || '');
  const def = SHEETS[name];
  if (!def) return json({ error: `Không có bảng "${name}"` }, 404);

  const sheetId = env.SHEET_ID || DEFAULT_SHEET_ID;
  const ttl = Number(env[`TTL_${name.toUpperCase()}`]) || def.ttl;
  const force = new URL(request.url).searchParams.get('refresh') === '1';
  const cacheKey = new URL(`/__sheet_cache/${sheetId}/${name}`, request.url).toString();

  let entry = mem.get(name);
  if (!entry || entry.sheetId !== sheetId) entry = await readStore(env, cacheKey, name);
  if (entry) mem.set(name, entry);

  const age = entry ? (Date.now() - entry.fetchedAt) / 1000 : Infinity;
  const forceAllowed = force && age > MIN_FORCE_INTERVAL;

  if (entry && age < ttl && !forceAllowed) return out(entry, force ? 'HIT-THROTTLED' : 'HIT', ttl);

  if (entry && !force && age < ttl * MAX_STALE_FACTOR) {
    ctx.waitUntil(refresh(env, name, def, sheetId, cacheKey).catch(() => {}));
    return out(entry, 'STALE', ttl);
  }

  try {
    const fresh = await refresh(env, name, def, sheetId, cacheKey);
    return out(fresh, 'MISS', ttl);
  } catch (err) {
    if (entry) return out(entry, 'STALE-ERROR', ttl, err.message);
    return json({ error: err.message }, 502);
  }
}

function refresh(env, name, def, sheetId, cacheKey) {
  if (inflight.has(name)) return inflight.get(name);
  const p = (async () => {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${def.gid}`;
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'thong-ke-nscn/1.0' } });
    if (res.status === 429) throw new Error('Google Sheets đang giới hạn tần suất (429)');
    if (!res.ok) throw new Error(`Google Sheets trả về HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('csv')) throw new Error('Không đọc được CSV – kiểm tra quyền chia sẻ của Google Sheet');
    const body = await res.arrayBuffer(); // giữ nguyên byte – không decode UTF-8 để tiết kiệm CPU
    const entry = { body, fetchedAt: Date.now(), sheetId };
    mem.set(name, entry);
    await writeStore(env, cacheKey, name, entry);
    return entry;
  })().finally(() => inflight.delete(name));
  inflight.set(name, p);
  return p;
}

async function readStore(env, cacheKey, name) {
  try {
    if (env.SHEET_CACHE) {
      const { value, metadata } = await env.SHEET_CACHE.getWithMetadata(name, { type: 'arrayBuffer' });
      return value ? { body: value, fetchedAt: metadata?.fetchedAt || 0, sheetId: metadata?.sheetId } : null;
    }
    const hit = await caches.default.match(cacheKey);
    if (!hit) return null;
    return { body: await hit.arrayBuffer(), fetchedAt: Number(hit.headers.get('X-Fetched-At')) || 0, sheetId: hit.headers.get('X-Sheet-Id') };
  } catch {
    return null;
  }
}

async function writeStore(env, cacheKey, name, entry) {
  try {
    if (env.SHEET_CACHE) {
      await env.SHEET_CACHE.put(name, entry.body, { metadata: { fetchedAt: entry.fetchedAt, sheetId: entry.sheetId } });
      return;
    }
    await caches.default.put(cacheKey, new Response(entry.body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': 'public, max-age=604800',
        'X-Fetched-At': String(entry.fetchedAt),
        'X-Sheet-Id': entry.sheetId,
      },
    }));
  } catch { /* cache lỗi không làm hỏng request */ }
}

function out(entry, status, ttl, warning) {
  const headers = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Fetched-At': String(entry.fetchedAt),
    'X-Cache': status,
    'X-TTL': String(ttl),
  };
  if (warning) headers['X-Warning'] = encodeURIComponent(warning);
  return new Response(entry.body, { headers });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
