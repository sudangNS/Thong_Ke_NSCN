/* Sản lượng: đọc Pallet Log, suy ra công đoạn bị bỏ qua, tổng hợp theo ngày.
 *
 * Quy tắc (theo yêu cầu xưởng):
 *  - Mỗi chi tiết/cụm/SP đi qua chuỗi bước công đoạn (MO Routing).
 *  - Nếu công đoạn sau đã có số lượng thì mặc định các công đoạn trước cũng đã hoàn thành
 *    ít nhất bằng số đó (người ta có thể bỏ qua không báo 1 vài công đoạn).
 *      E[k] = max(R[k], E[k+1])          R = số đã báo, E = số tính (hiệu lực)
 *  - Lan truyền xuống cấp dưới: cụm đã vào bước đầu (Lắp ráp) n cái → các chi tiết của cụm
 *    coi như đã xong công đoạn cuối n × (SL chi tiết/SP ÷ SL cụm/SP). Tương tự SP (Ráp thành phẩm)
 *    → các cụm + chi tiết rời.
 *  - Sản lượng ngày = phần tăng của E trong ngày đó (gán cho ngày của dòng ghi nhận làm phát sinh).
 */
'use strict';

const REPORT_GROUPS = ['Sơ chế', 'Tinh chế', 'Lắp ráp', 'Dầu', 'Đóng gói'];
const TEAM_LABEL = { 'Đóng gói': 'Bao bì' };
const teamName = (g) => TEAM_LABEL[g] || g;

const P = { daily: new Map(), nLogs: 0, bad: [], minDay: '', maxDay: '', stageRank: new Map(), version: 0 };

/* ---------- Ngày ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
const dkey = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
const toDate = (k) => new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const addDays = (k, n) => { const d = toDate(k); d.setDate(d.getDate() + n); return dkey(d); };
const todayKey = () => dkey(new Date());
function parseDay(s) {
  s = String(s ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); // dd/mm/yyyy (định dạng Việt Nam trong Sheet)
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  return '';
}
const parseStamp = (s) => `${parseDay(s)} ${(/(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s || '') || []).slice(1).map((x) => pad2(x || 0)).join(':')}`;
function dayList(from, to) {
  const out = [];
  for (let k = from; k <= to && out.length < 4000; k = addDays(k, 1)) out.push(k);
  return out;
}

/* ---------- Liên kết cây: chi tiết → cụm → SP, m³ quy đổi, bước "ra tổ" ---------- */
function linkParts() {
  const segPos = new Map(); // stage -> [tổng vị trí trong đoạn của tổ, số lần]
  for (const mo of S.mos) for (const det of mo.details) {
    const sp = det.parts.find((p) => p.kind === 'SP') || null;
    for (const p of det.parts) { p.children = []; p.parent = null; p.m3Cache = null; }
    for (const p of det.parts) {
      if (p.kind === 'CT thuộc cụm') p.parent = det.parts.find((x) => x.kind === 'CUM' && x.ref === p.cumRef) || sp;
      else if (p.kind === 'CUM' || p.kind === 'CT rời') p.parent = sp;
      if (p.parent === p) p.parent = null;
      if (p.parent) p.parent.children.push(p);
      p.ratio = p.parent ? p.qtyPer / (p.parent.qtyPer || 1) : 0;
      let start = 0;
      // Bước "ra tổ" = công đoạn CUỐI CÙNG của tổ trong quy trình (MO Routing, theo step_no) của chi tiết/cụm/SP này.
      // Tổ của công đoạn lấy theo Works List → To (xem stepGroup trong app.js). Nếu quy trình quay lại cùng tổ
      // thì chỉ tính lần cuối, tránh đếm 2 lần.
      const lastIdx = new Map();
      p.steps.forEach((s, i) => lastIdx.set(s.group, i));
      p.steps.forEach((s, i) => {
        s.idx = i;
        if (i > 0 && p.steps[i - 1].group !== s.group) start = i;
        s.exit = lastIdx.get(s.group) === i;
        const a = segPos.get(s.stage) || [0, 0];
        a[0] += i - start; a[1]++;
        segPos.set(s.stage, a);
      });
    }
    for (const p of det.parts) { p.m3f = partM3(p, 'f'); p.m3r = partM3(p, 'r'); }
    const sum = det.parts.find((p) => p.kind === 'SP');
    if (sum && !sum.m3f && det.m3pcs) { sum.m3f = det.m3pcs; sum.m3r = det.m3pcs; }
  }
  P.stageRank = new Map([...segPos].map(([k, [t, n]]) => [k, t / n]));
}
// m³ của 1 đơn vị: chi tiết theo BOM; cụm/SP = tổng gỗ các thành phần
function partM3(p, mode) {
  if (p.children.length) return p.children.reduce((s, c) => s + partM3(c, mode) * c.ratio, 0);
  const line = mode === 'r' ? p.m3RoughLine || p.m3FinishLine : p.m3FinishLine;
  return line ? line / (p.bomQty || p.qtyPer || 1) : 0;
}
const stageOrder = (a, b) => (P.stageRank.get(a) ?? 99) - (P.stageRank.get(b) ?? 99) || a.localeCompare(b, 'vi');

/* ---------- Suy diễn ---------- */
function recompute(p, floor, out, force) {
  const changedFloor = floor !== p.floor;
  p.floor = floor;
  const n = p.steps.length;
  let next = floor;
  for (let i = n - 1; i >= 0; i--) {
    const e = Math.max(p.R[i], next);
    if (e !== p.E[i]) { if (out) out(p.steps[i], e - p.E[i]); p.E[i] = e; }
    next = e;
  }
  const head = n ? p.E[0] : floor;
  for (const c of p.children) {
    const f = head * c.ratio;
    if (force || f !== c.floor || changedFloor) recompute(c, f, out, force);
  }
}

function runProduction(d) {
  linkParts();
  const parts = S.mos.flatMap((m) => m.details.flatMap((x) => x.parts));
  for (const p of parts) { p.R = p.steps.map(() => 0); p.E = p.steps.map(() => 0); p.floor = 0; }

  const logs = [], bad = [];
  (d.pallet_log || []).forEach((l, i) => {
    const id = String(l.mo_route_id || '').trim().toUpperCase();
    const st = S.steps.get(id);
    const day = parseDay(l.work_date) || parseDay(l.created_at);
    const qty = num(l.qty), ng = num(l.qty_ng); // qty = hàng đạt, qty_ng = hàng hỏng (cột mới, có thể chưa có)
    if (!st || !day || (!qty && !ng)) { bad.push({ row: i + 2, id, day, qty, why: !st ? 'Mã phiếu không có trong MO Routing' : !day ? 'Thiếu/sai ngày' : 'Số lượng đạt và NG đều = 0' }); return; }
    logs.push({ st, day, qty, ng, t: parseStamp(l.created_at), i });
  });
  logs.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0) || a.i - b.i);

  const daily = new Map();
  const cell = (day, id) => {
    let m = daily.get(day);
    if (!m) daily.set(day, (m = new Map()));
    let v = m.get(id);
    if (!v) m.set(id, (v = { e: 0, r: 0, ng: 0, n: 0 }));
    return v;
  };
  for (const lg of logs) {
    const p = lg.st.part;
    p.R[lg.st.idx] += lg.qty;
    const c = cell(lg.day, lg.st.id);
    c.r += lg.qty; c.ng += lg.ng; c.n++;
    recompute(p, p.floor, (st, delta) => { cell(lg.day, st.id).e += delta; });
  }

  // Ảnh chụp hiện tại: lấy max(Pallet Log, qty_done trong MO Routing) rồi suy diễn lại toàn bộ
  for (const p of parts) p.steps.forEach((s, i) => { p.R[i] = Math.max(p.R[i], s.qtyDone); });
  for (const p of parts) if (!p.parent) recompute(p, 0, null, true);
  for (const p of parts) p.steps.forEach((s, i) => {
    s.rep = p.R[i]; s.eff = p.E[i];
    s.done = isDone(s.status, s.eff, s.qtyReq);
  });

  const days = [...daily.keys()].sort();
  // Dòng thời gian E theo từng bước (để tính tuổi tồn)
  const tl = new Map();
  for (const d of days) for (const [id, v] of daily.get(d)) {
    if (!v.e) continue;
    let a = tl.get(id);
    if (!a) tl.set(id, (a = []));
    a.push([d, v.e]);
  }
  Object.assign(P, { daily, tl, wipCache: new Map(), nLogs: logs.length, bad, minDay: days[0] || '', maxDay: days[days.length - 1] || '', version: P.version + 1 });
}

/* ---------- Hàng tồn trên chuyền (WIP) ----------
 * Xét từng khoảng giữa 2 bước liên tiếp của 1 chi tiết/cụm/SP:  tồn = E[bước trước] − E[bước sau]
 *  - 2 bước khác tổ  → "chờ làm" tại tổ của bước sau (tổ trước đã giao qua, tổ sau chưa làm)
 *  - 2 bước cùng tổ  → "đang làm dở" tại tổ đó
 *  - bước cuối của chi tiết/cụm → "chờ ráp" tại tổ của bước đầu cụm/SP cha
 *      tồn = E[bước cuối] − E[bước đầu của cha] × (SL con/SL cha)
 * Hàng chưa vào bước đầu tiên (gỗ ở kho) và SP đã đóng gói không tính là tồn trên chuyền.
 * Nhờ suy diễn E[k] ≥ E[k+1] nên tồn luôn ≥ 0, mỗi món nằm đúng 1 tổ → m³ tồn cộng được giữa các tổ.
 * Tuổi tồn (FIFO): ngày nhập của đơn vị cũ nhất chưa được công đoạn sau nhận. */
function effAsOf(day) {
  const E = new Map();
  for (const [d, m] of P.daily) if (d <= day) for (const [id, v] of m) if (v.e) E.set(id, (E.get(id) || 0) + v.e);
  return E;
}
function oldestSince(tl, outQty, asOf) {
  let cum = 0;
  for (const [d, e] of tl || []) {
    if (d > asOf) break;
    cum += e;
    if (cum > outQty + 1e-6) return d;
  }
  return '';
}
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);

function wipAsOf(day) {
  const key = day;
  if (P.wipCache && P.wipCache.has(key)) return P.wipCache.get(key);
  const E = effAsOf(day);
  const g = (s) => E.get(s.id) || 0;
  const out = [];
  for (const mo of S.mos) for (const det of mo.details) for (const p of det.parts) {
    const n = p.steps.length;
    for (let i = 0; i < n; i++) {
      const s = p.steps[i], up = g(s);
      if (up <= 1e-9) continue;
      let to, down;
      if (i < n - 1) { to = p.steps[i + 1]; down = g(to); }
      else if (p.parent && p.parent.steps.length) { to = p.parent.steps[0]; down = g(to) * p.ratio; }
      else continue; // SP đã xong bước cuối (đóng gói) → ra khỏi chuyền
      const qty = up - down;
      if (qty <= 1e-6) continue;
      const since = oldestSince(P.tl.get(s.id), down, day);
      out.push({
        part: p, from: s, to, group: to.group, qty,
        kind: i === n - 1 ? 'rap' : to.group === s.group ? 'do' : 'cho',
        since, age: since ? daysBetween(since, day) : 0,
      });
    }
  }
  if (P.wipCache) P.wipCache.set(key, out);
  return out;
}

/* ---------- Đồng bộ chi tiết trên dòng SP ----------
 * Số SP có thể ráp đủ = min( số đã xong ở mốc ÷ SL/SP ) trên mọi chi tiết/cụm của dòng SP.
 * Giao diện chỉ hiện 1 số "SL đồng bộ" = mốc 'ct' (chi tiết ít nhất đã xong công đoạn cuối). */
const SYNC_KEYS = [
  ['sc', 'Phôi SC', 'phôi đã xong Sơ chế'],
  ['tc', 'TC', 'chi tiết đã xong Tinh chế'],
  ['ct', 'CT xong', 'chi tiết đã xong công đoạn cuối (sẵn sàng ráp)'],
  ['cum', 'Cụm', 'cụm đã xong'],
  ['rap', 'Ráp TP', 'thành phẩm đã ráp'],
  ['dg', 'Đóng gói', 'thành phẩm đã đóng gói'],
];
function detSync(det) {
  const res = {};
  const take = (key, p, idx) => {
    if (idx < 0 || !p.E) return;
    const per = p.qtyPer || 1;
    const v = Math.floor(p.E[idx] / per + 1e-9);
    if (!res[key] || v < res[key].v) res[key] = { v, by: p.name, have: p.E[idx], need: per };
  };
  const lastOf = (p, g) => { for (let i = p.steps.length - 1; i >= 0; i--) if (p.steps[i].group === g) return i; return -1; };
  for (const p of det.parts) {
    const last = p.steps.length - 1;
    if (p.kind === 'CT thuộc cụm' || p.kind === 'CT rời') {
      take('sc', p, lastOf(p, 'Sơ chế'));
      take('tc', p, lastOf(p, 'Tinh chế'));
      take('ct', p, last);
    } else if (p.kind === 'CUM') take('cum', p, last);
    else if (p.kind === 'SP') {
      // Chỉ lấy "Ráp TP" khi SP thực sự có bước ráp (vd Herbal Box chỉ có Đóng gói)
      if (last > 0 || (p.steps[0] && p.steps[0].group !== 'Đóng gói')) take('rap', p, 0);
      take('dg', p, last);
    }
  }
  return res;
}
