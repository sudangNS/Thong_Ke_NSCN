/* Thống kê NSCN – xem LSX đang chạy & in phiếu pallet */
'use strict';

const SHEET_ID = '1VVW7Zrdw-KmO2HLIh1nchKE8DRGWDtd2hCrS-e_aKUU';
const GIDS = {
  mo_routing: '1233752704',
  mo: '512575770',
  mo_detail: '1681627449',
  product: '151523159',
  bom_wood: '1862351213',
  pallet_log: '2066587219', // ghi nhận sản lượng theo ngày (work_date, mo_route_id, qty)
};
const AUTO_REFRESH_MS = 5 * 60 * 1000;
// Số dòng ghi nhận mỗi bảng (phiếu có 2 bảng đôi): ít công đoạn → nhiều dòng hơn
const LOG_ROWS = { one: 9, two: 7 };
const CHECK_COLS = 5; // số ô công đoạn trên 1 hàng của phần đánh dấu
const GROUP_ORDER = ['Sơ chế', 'Tinh chế', 'Lắp ráp', 'Dầu', 'Đóng gói'];
const KIND_LABEL = { SP: 'Thành phẩm', CUM: 'Cụm', 'CT thuộc cụm': 'CT thuộc cụm', 'CT rời': 'CT rời' };

const S = {
  mos: [], steps: new Map(), loadedAt: 0, fetchedAt: 0, cacheInfo: '', mode: '',
  selected: new Set(), expand: new Map(), filterSig: '',
  view: [], scopes: new Map(), loading: false, previewIds: null, partByRef: new Map(),
};

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
const num = (s) => {
  s = String(s ?? '').trim();
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const fmt = (n) => (Number(n) || 0).toLocaleString('vi-VN');
const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || ''); };
const isDone = (status, done, req) => /hoàn thành|hoan thanh|xong|done|finish/i.test(status || '') || (req > 0 && done >= req);

/* ---------- CSV ---------- */
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0, n = text.length; i < n; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim());
  const out = [];
  for (const r of rows) {
    if (!r.some((v) => v !== '')) continue;
    const o = {};
    head.forEach((h, j) => { o[h] = (r[j] ?? '').trim(); });
    out.push(o);
  }
  return out;
}

/* ---------- Đọc dữ liệu ---------- */
async function fetchSheet(name, force) {
  try {
    const r = await fetch(`api/sheet/${name}${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
    const ct = r.headers.get('content-type') || '';
    if (r.ok && ct.includes('csv')) {
      return {
        text: await r.text(),
        fetchedAt: Number(r.headers.get('X-Fetched-At')) || Date.now(),
        cache: r.headers.get('X-Cache') || '',
        warning: decodeURIComponent(r.headers.get('X-Warning') || ''),
      };
    }
    if (ct.includes('json')) throw Object.assign(new Error((await r.json()).error || `HTTP ${r.status}`), { fatal: true });
  } catch (e) {
    if (e.fatal) throw e;
  }
  // Không có proxy (chạy local) → đọc thẳng Google Sheet
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GIDS[name]}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Không đọc được bảng ${name} (HTTP ${r.status})`);
  return { text: await r.text(), fetchedAt: Date.now(), cache: 'DIRECT', warning: '' };
}

async function load(force = false) {
  if (S.loading) return;
  S.loading = true;
  setSync(force ? 'Đang làm mới…' : 'Đang tải dữ liệu…', 'busy');
  try {
    const names = Object.keys(GIDS);
    const res = await Promise.all(names.map((n) => fetchSheet(n, force)));
    const data = {};
    names.forEach((n, i) => { data[n] = parseCSV(res[i].text); });
    build(data);
    runProduction(data);
    recount();
    const rt = res[0];
    S.fetchedAt = Math.min(...res.map((r) => r.fetchedAt));
    S.mode = rt.cache === 'DIRECT' ? 'direct' : 'proxy';
    S.loadedAt = Date.now();
    S.warning = res.map((r) => r.warning).filter(Boolean).join('; ');
    for (const id of [...S.selected]) if (!S.steps.has(id)) S.selected.delete(id);
    fillFilters();
    if (!S.urlApplied) applyUrlParams();
    update();
    renderReport();
    updateSync();
    if (S.pendingPreview) { const ids = S.pendingPreview.flatMap(idsFromCode); S.pendingPreview = null; if (ids.length) openPreview(ids); }
  } catch (e) {
    console.error(e);
    setSync(`Lỗi tải dữ liệu: ${e.message}`, 'err');
    if (!S.mos.length) {
      const msg = `<div class="empty">Không tải được dữ liệu.<br><small>${esc(e.message)}</small></div>`;
      $('#tree').innerHTML = msg;
      $('#report').innerHTML = msg;
    }
  } finally {
    S.loading = false;
  }
}

function setSync(text, cls = '') {
  const el = $('#sync-status');
  el.textContent = text;
  el.className = `sync-status ${cls}`;
}
function updateSync() {
  if (!S.fetchedAt) return;
  const t = new Date(S.fetchedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const ageMin = Math.floor((Date.now() - S.fetchedAt) / 60000);
  const age = ageMin < 1 ? 'vừa xong' : `${ageMin} phút trước`;
  const src = S.mode === 'direct' ? ' · đọc trực tiếp Google (chế độ dev)' : '';
  setSync(`Dữ liệu Sheet lúc ${t} (${age})${src}${S.warning ? ' · ⚠ ' + S.warning : ''}`, S.warning ? 'warn' : '');
}

/* ---------- Dựng cây LSX → Dòng SP → Cụm → Chi tiết → Công đoạn ---------- */
function build(d) {
  const products = new Map(d.product.map((p) => [p.product_id, p]));
  const bom = new Map(d.bom_wood.map((b) => [b.bom_line_id, b]));
  const moRows = new Map(d.mo.map((m) => [m.mo_id, m]));
  const detRows = new Map(d.mo_detail.map((x) => [x.detail_id, x]));

  const mos = new Map(), dets = new Map(), parts = new Map(), steps = new Map();

  for (const r of d.mo_routing) {
    if (!r.mo_route_id) continue;
    let mo = mos.get(r.mo_id);
    if (!mo) {
      const m = moRows.get(r.mo_id) || {};
      const cust = m.customer || '';
      const end = m.end_customer || '';
      mo = {
        id: r.mo_id, no: m.mo_no || r.mo_id.replace(/^LSX-/, ''), customer: end && end !== cust ? `${cust} – ${end}` : cust,
        due: m.due_date || '', orderType: m.order_type || '', note: m.note || '', details: [], total: 0, done: 0,
      };
      mo.search = norm([mo.id, mo.no, mo.customer, mo.orderType].join(' '));
      mos.set(mo.id, mo);
    }
    let det = dets.get(r.detail_id);
    if (!det) {
      const x = detRows.get(r.detail_id) || {};
      const p = products.get(r.product_id) || {};
      const set = x.set_product_id && x.set_product_id !== r.product_id ? products.get(x.set_product_id) : null;
      det = {
        id: r.detail_id, mo, stt: x.lsx_stt || '', productId: r.product_id,
        name: x.product_name || p.product_name || r.product_id, nameVi: p.product_name_vi || '',
        code: x.product_code || p.product_code || '', bomCode: p.bom_product_code || '',
        qty: num(x.qty) || num(r.mo_qty), unit: x.unit || p.unit || '', due: x.due_date || mo.due,
        m3pcs: num(x.m3_per_pcs) || num(p.m3_per_pcs),
        size: p.size || '', wood: p.wood_type || '', color: p.color_code || '',
        setName: set ? (set.product_name_vi || set.product_name) : '', parts: [], total: 0, done: 0,
      };
      det.search = norm([det.id, det.name, det.nameVi, det.code, det.bomCode, det.productId, det.setName].join(' '));
      dets.set(det.id, det);
      mo.details.push(det);
    }
    let part = parts.get(r.part_ref);
    if (!part) {
      const b = bom.get(r.bom_line_id) || {};
      const dims = [b.thick_mm, b.width_mm, b.length_mm].map((v) => (v || '').trim());
      part = {
        ref: r.part_ref, det, name: r.part_name, kind: r.part_kind, level: r.level, cumRef: r.cum_ref,
        lineNo: num(r.line_no), code: b.part_code || '',
        size: dims.some(Boolean) ? dims.map((v) => v || '?').join(' × ') : (r.part_kind === 'SP' ? det.size : ''),
        material: b.material || '', qtyPer: num(r.qty_per_unit), qtyReq: num(r.qty_required), steps: [],
        bomQty: num(b.qty_per_unit), m3FinishLine: num(b.m3_finish), m3RoughLine: num(b.m3_rough),
      };
      parts.set(part.ref, part);
      det.parts.push(part);
    }
    const st = {
      id: r.mo_route_id, idn: norm(r.mo_route_id), part, no: num(r.step_no), stage: r.stage, group: r.stage_group,
      prev: r.prev_stage, next: r.next_stage, qtyReq: num(r.qty_required), qtyDone: num(r.qty_done), status: r.status || '',
    };
    st.done = isDone(st.status, st.qtyDone, st.qtyReq);
    st.rep = st.eff = st.qtyDone; // runProduction() cập nhật lại từ Pallet Log
    part.steps.push(st);
    steps.set(st.id, st);
  }

  // Tên cụm cho chi tiết thuộc cụm + chuỗi tìm kiếm
  S.partByRef = new Map();
  for (const p of parts.values()) {
    p.steps.sort((a, b) => a.no - b.no);
    buildSegs(p);
    const cum = p.kind === 'CUM' ? p : parts.get(p.cumRef);
    p.cumName = p.kind === 'SP' || p.kind === 'CT rời' ? '' : (cum ? cum.name : '');
    p.cumCode = cum ? cum.code : '';
    p.search = norm([p.ref, p.name, p.code, p.cumName, p.cumCode, KIND_LABEL[p.kind]].join(' '));
  }

  let seq = 0;
  const kindRank = { SP: 0, CUM: 1, 'CT thuộc cụm': 1, 'CT rời': 2 };
  S.mos = [...mos.values()].sort((a, b) => a.no.localeCompare(b.no, 'vi', { numeric: true }));
  for (const mo of S.mos) {
    mo.details.sort((a, b) => (num(a.stt) - num(b.stt)) || a.id.localeCompare(b.id));
    for (const det of mo.details) {
      det.parts.sort((a, b) => (kindRank[a.kind] - kindRank[b.kind]) || (a.lineNo - b.lineNo));
      for (const p of det.parts) for (const s of p.steps) s.seq = seq++;
    }
  }
  S.steps = steps;
}

/* Phiếu pallet theo TỔ: 1 chi tiết/cụm/SP mang 1 phiếu suốt các công đoạn liên tiếp cùng tổ.
 * QR trên phiếu = part_ref (mã chi tiết/cụm/SP trong LSX), dùng chung cho mọi phiếu tổ của chi tiết đó. */
function buildSegs(p) {
  p.segs = [];
  let seg = null;
  for (const s of p.steps) {
    if (!seg || seg.group !== s.group) p.segs.push((seg = { part: p, group: s.group, steps: [] }));
    seg.steps.push(s);
    s.seg = seg;
  }
  S.partByRef.set(String(p.ref).toUpperCase(), p);
}
// Danh sách phiếu (tổ) từ danh sách mã công đoạn, giữ thứ tự, không trùng
function segsOf(ids) {
  const out = new Set();
  for (const id of ids) { const s = S.steps.get(id); if (s && s.seg) out.add(s.seg); }
  return [...out];
}
const segStepIds = (ids) => segsOf(ids).flatMap((g) => g.steps.map((s) => s.id));
const segSelected = (g) => g.steps.some((s) => S.selected.has(s.id));
// Nhận mã công đoạn (mo_route_id) hoặc part_ref (QR trên phiếu) → danh sách mã công đoạn
function idsFromCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (S.steps.has(c)) return [c];
  const p = S.partByRef.get(c);
  return p ? p.steps.map((s) => s.id) : [];
}

// Tiến độ LSX / dòng SP (gọi sau runProduction vì "hoàn thành" tính theo số đã suy diễn)
function recount() {
  for (const mo of S.mos) {
    mo.total = mo.done = 0;
    for (const det of mo.details) {
      det.total = det.done = 0;
      for (const p of det.parts) for (const s of p.steps) { det.total++; if (s.done) det.done++; }
      mo.total += det.total; mo.done += det.done;
      det.sync = detSync(det);
    }
    mo.running = mo.done < mo.total;
  }
}

/* ---------- Bộ lọc ---------- */
const F_IDS = ['f-mo', 'f-customer', 'f-product', 'f-kind', 'f-group', 'f-stage', 'f-status'];

function setOptions(sel, items, allLabel) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  if (items.some(([v]) => v === cur)) sel.value = cur;
}
const groupRank = (g) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? 99 : i; };

function fillFilters() {
  const mos = S.mos, dets = mos.flatMap((m) => m.details);
  const all = [...S.steps.values()];
  setOptions($('#f-mo'), mos.map((m) => [m.id, `${m.no}${m.customer ? ' · ' + m.customer : ''}`]), 'Tất cả');
  setOptions($('#f-customer'), [...new Set(mos.map((m) => m.customer).filter(Boolean))].sort().map((c) => [c, c]), 'Tất cả');
  const prods = new Map();
  dets.forEach((d) => prods.set(d.productId, `${d.name}${d.code ? ' (' + d.code + ')' : ''}`));
  setOptions($('#f-product'), [...prods].sort((a, b) => a[1].localeCompare(b[1], 'vi')), 'Tất cả');
  setOptions($('#f-kind'), Object.entries(KIND_LABEL), 'Tất cả');
  const groups = [...new Set(all.map((s) => s.group).filter(Boolean))].sort((a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b, 'vi'));
  setOptions($('#f-group'), groups.map((g) => [g, g]), 'Tất cả');
  fillStageOptions();
  setOptions($('#f-status'), [...new Set(all.map((s) => s.status).filter(Boolean))].sort().map((s) => [s, s]), 'Tất cả');
}
function fillStageOptions() {
  const g = $('#f-group').value;
  const m = new Map();
  for (const s of S.steps.values()) if (s.stage && (!g || s.group === g)) m.set(s.stage, s.group);
  const items = [...m].sort((a, b) => groupRank(a[1]) - groupRank(b[1]) || a[0].localeCompare(b[0], 'vi')).map(([st, gr]) => [st, g ? st : `${st} (${gr})`]);
  setOptions($('#f-stage'), items, 'Tất cả');
}

function readFilters() {
  return {
    q: $('#q').value.trim(), mo: $('#f-mo').value, customer: $('#f-customer').value, product: $('#f-product').value,
    kind: $('#f-kind').value, group: $('#f-group').value, stage: $('#f-stage').value, status: $('#f-status').value,
    running: $('#f-running').checked,
  };
}

/* Tính "view": danh sách đã lọc + chỉ mục phạm vi chọn (scope → mã phiếu) */
function compute() {
  const f = readFilters();
  const tokens = norm(f.q).split(/\s+/).filter(Boolean);
  // Mã công đoạn dạng ...-S01: lọc đúng bước đó. QR phiếu (part_ref) tìm như chữ thường.
  const stepToks = tokens.filter((t) => /-s\d+$/.test(t));
  const textToks = tokens.map((t) => (/-s\d+$/.test(t) ? t.replace(/-s\d+$/, '') : t));
  const sig = JSON.stringify(f);
  if (sig !== S.filterSig) { S.expand.clear(); S.filterSig = sig; }
  S.filtering = Boolean(tokens.length || f.product || f.kind || f.group || f.stage || f.status);

  const scopes = new Map();
  const add = (k, ids) => { let a = scopes.get(k); if (!a) scopes.set(k, (a = [])); a.push(...ids); };
  const view = [];
  let nSteps = 0, nParts = 0;
  const segSet = new Set();

  for (const mo of S.mos) {
    if (f.mo && mo.id !== f.mo) continue;
    if (f.customer && mo.customer !== f.customer) continue;
    if (f.running && !mo.running && !f.mo) continue;
    const vMo = { mo, details: [], n: 0 };
    for (const det of mo.details) {
      if (f.product && det.productId !== f.product) continue;
      const vDet = { det, groups: new Map(), n: 0 };
      for (const p of det.parts) {
        if (f.kind && p.kind !== f.kind) continue;
        if (textToks.length) {
          const hay = `${mo.search} ${det.search} ${p.search}`;
          if (!textToks.every((t) => hay.includes(t))) continue;
        }
        const steps = p.steps.filter((s) =>
          (!f.group || s.group === f.group) && (!f.stage || s.stage === f.stage) &&
          (!f.status || s.status === f.status) && (!stepToks.length || stepToks.includes(s.idn)));
        if (!steps.length) continue;
        const gk = p.kind === 'SP' ? 'sp' : p.kind === 'CT rời' ? 'loose' : (p.kind === 'CUM' ? p.ref : p.cumRef || 'loose');
        let g = vDet.groups.get(gk);
        if (!g) vDet.groups.set(gk, (g = { key: gk, parts: [], n: 0 }));
        g.parts.push({ p, steps });
        const ids = steps.map((s) => s.id);
        g.n += ids.length; vDet.n += ids.length; vMo.n += ids.length;
        add(`p:${p.ref}`, ids); add(`g:${det.id}|${gk}`, ids); add(`d:${det.id}`, ids); add(`m:${mo.id}`, ids); add('all', ids);
        nSteps += ids.length; nParts++;
        steps.forEach((s) => segSet.add(s.seg));
      }
      if (vDet.n) vMo.details.push(vDet);
    }
    if (vMo.n) view.push(vMo);
  }
  // Thứ tự nhóm: Thành phẩm → các cụm (theo line_no) → chi tiết rời
  for (const vm of view) for (const vd of vm.details) {
    vd.groupList = [...vd.groups.values()].sort((a, b) => rankGroup(a, vd.det) - rankGroup(b, vd.det));
  }
  S.view = view; S.scopes = scopes; S.counts = { nSteps, nSegs: segSet.size, nParts, nMo: view.length, nDet: view.reduce((s, v) => s + v.details.length, 0) };
}
function rankGroup(g, det) {
  if (g.key === 'sp') return -1;
  if (g.key === 'loose') return 1e9;
  const cum = det.parts.find((p) => p.ref === g.key);
  return cum ? cum.lineNo : 1e8;
}

function isOpen(key) {
  if (S.expand.has(key)) return S.expand.get(key);
  return key.startsWith('m:') || S.filtering;
}

/* ---------- Render ---------- */
function update() {
  F_IDS.forEach((id) => { const el = $('#' + id); el.classList.toggle('on', Boolean(el.value)); });
  compute();
  render();
}

function scopeBtn(key, label) {
  // Đếm theo phiếu tổ (1 chi tiết × 1 tổ), không theo từng công đoạn
  const segs = segsOf(S.scopes.get(key) || []);
  const nSel = segs.reduce((s, g) => s + (segSelected(g) ? 1 : 0), 0);
  const state = nSel === 0 ? '' : nSel === segs.length ? 'all' : 'some';
  const icon = state === 'all' ? '☑' : state === 'some' ? '◩' : '☐';
  return `<button class="scope ${state}" type="button" data-scope="${esc(key)}" title="Chọn/bỏ chọn ${segs.length} phiếu tổ">${icon} ${label ?? segs.length}</button>`;
}
const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);
function progress(done, total) {
  const p = pct(done, total);
  return `<span class="prog" title="${done}/${total} bước công đoạn hoàn thành"><i style="width:${p}%"></i></span><span class="prog-t">${p}%</span>`;
}

function render() {
  const c = S.counts;
  $('#result-count').innerHTML = `<b>${c.nMo}</b> LSX · <b>${c.nDet}</b> dòng SP · <b>${fmt(c.nParts)}</b> chi tiết/cụm · <b>${fmt(c.nSteps)}</b> công đoạn · <b>${fmt(c.nSegs)}</b> phiếu tổ`;
  $('#btn-select-all').textContent = `Chọn tất cả ${fmt(c.nSegs)} phiếu đang lọc`;
  $('#btn-select-all').disabled = !c.nSteps;
  if (!S.view.length) {
    $('#tree').innerHTML = `<div class="empty">Không có kết quả phù hợp.</div>`;
  } else {
    $('#tree').innerHTML = S.view.map(renderMo).join('');
  }
  renderSelbar();
}

function renderMo(vm) {
  const mo = vm.mo, key = `m:${mo.id}`, open = isOpen(key);
  const due = mo.due ? `<span class="meta">Hạn ${fmtDate(mo.due)}</span>` : '';
  return `<section class="mo ${open ? 'open' : ''}">
    <header class="mo-head" data-toggle="${esc(key)}">
      <span class="caret">▸</span>
      <span class="mo-no">LSX ${esc(mo.no)}</span>
      <span class="mo-cust">${esc(mo.customer)}</span>
      ${mo.orderType ? `<span class="tag">${esc(mo.orderType)}</span>` : ''}
      ${due}
      <span class="meta">${vm.details.length} dòng SP</span>
      <span class="spacer"></span>
      ${progress(mo.done, mo.total)}
      ${scopeBtn(`m:${mo.id}`)}
    </header>
    ${open ? `<div class="mo-body">${mo.note ? `<p class="note">Ghi chú: ${esc(mo.note)}</p>` : ''}${vm.details.map(renderDet).join('')}</div>` : ''}
  </section>`;
}

function renderDet(vd) {
  const d = vd.det, key = `d:${d.id}`, open = isOpen(key);
  return `<div class="det ${open ? 'open' : ''}">
    <div class="det-head" data-toggle="${esc(key)}">
      <span class="caret">▸</span>
      <span class="det-stt" title="${esc(d.id)}">${d.stt ? 'Dòng ' + esc(d.stt) : ''} <small>#${esc(d.id.split('-').pop())}</small></span>
      <span class="det-name" title="${esc(d.nameVi)}">${esc(d.name)}</span>
      ${d.code ? `<span class="code">${esc(d.code)}</span>` : ''}
      ${d.setName ? `<span class="tag tag-set" title="Thuộc bộ sản phẩm">${esc(/^bộ\s/i.test(d.setName) ? d.setName : 'Bộ ' + d.setName)}</span>` : ''}
      <span class="meta">SL ${fmt(d.qty)} ${esc(d.unit)}</span>
      ${d.size ? `<span class="meta">${esc(d.size)}</span>` : ''}
      ${d.due ? `<span class="meta">Hạn ${fmtDate(d.due)}</span>` : ''}
      <span class="spacer"></span>
      ${progress(d.done, d.total)}
      ${scopeBtn(`d:${d.id}`)}
    </div>
    ${syncBar(d)}
    ${open ? `<div class="det-body">${vd.groupList.map((g) => renderGroup(g, d)).join('')}</div>` : ''}
  </div>`;
}

const fmtQ = (n) => fmt(Math.round(Number(n) || 0));

// SL đồng bộ: 1 số duy nhất = chi tiết ít nhất (đã xong công đoạn cuối ÷ SL chi tiết/SP)
function syncBar(d) {
  const x = (d.sync || {}).ct;
  if (!x) return '';
  const p = d.qty ? Math.min(100, Math.round((x.v / d.qty) * 100)) : 0;
  const cls = x.v <= 0 ? 'zero' : x.v >= d.qty ? 'full' : '';
  const tip = `Đủ bộ chi tiết cho ${fmt(x.v)}/${fmt(d.qty)} SP (tính theo chi tiết ít nhất, đã chia SL chi tiết/SP)` +
    (x.v < d.qty ? `\nÍt nhất: ${x.by} – có ${fmtQ(x.have)}, cần ${fmt(x.need)}/SP` : '');
  return `<div class="sync-bar"><span class="sync-chip ${cls}" title="${esc(tip)}"><b>SL đồng bộ</b> ${fmt(x.v)}/${fmt(d.qty)}<i style="width:${p}%"></i></span>` +
    (x.v < d.qty ? `<span class="sync-lbl">ít nhất: ${esc(x.by)}</span>` : '') + '</div>';
}

function renderGroup(g, d) {
  let title;
  if (g.key === 'sp') title = '<b>Thành phẩm</b>';
  else if (g.key === 'loose') title = '<b>Chi tiết rời</b>';
  else {
    const cum = d.parts.find((p) => p.ref === g.key);
    title = `<b>Cụm: ${esc(cum ? cum.name : g.key)}</b>${cum && cum.code ? ` <span class="code">${esc(cum.code)}</span>` : ''}`;
  }
  return `<div class="grp grp-${g.key === 'sp' ? 'sp' : g.key === 'loose' ? 'loose' : 'cum'}">
    <div class="grp-head">${title}<span class="spacer"></span>${scopeBtn(`g:${d.id}|${g.key}`)}</div>
    <div class="parts">${g.parts.map(renderPart).join('')}</div>
  </div>`;
}

function renderPart({ p, steps }) {
  const chips = steps.map((s) => {
    const inferred = s.eff > s.rep + 1e-9;
    const cls = ['step', S.selected.has(s.id) ? 'sel' : '', s.done ? 'done' : s.eff > 0 ? 'doing' : '', inferred ? 'inf' : ''].join(' ');
    const tip = `${s.id} · ${s.group} · ${s.status}\nĐã báo: ${fmtQ(s.rep)}` + (inferred ? ` · suy ra từ công đoạn sau: ${fmtQ(s.eff)}` : '');
    return `<button type="button" class="${cls}" data-step="${esc(s.id)}" title="${esc(tip)}">
      <span class="sn">${s.no}</span>${esc(s.stage)}<small>${inferred ? '≥' : ''}${fmtQ(s.eff)}/${fmt(s.qtyReq)}</small></button>`;
  }).join('');
  return `<div class="part kind-${p.kind === 'CUM' ? 'cum' : p.kind === 'SP' ? 'sp' : 'ct'}">
    <div class="part-info">
      <div class="part-name">${esc(p.name)} <span class="kind">${esc(KIND_LABEL[p.kind] || p.kind)}</span></div>
      <div class="part-sub">
        ${p.code ? `<span class="code">${esc(p.code)}</span>` : ''}
        ${p.size ? `<span>KT ${esc(p.size)}</span>` : ''}
        ${p.material ? `<span>${esc(p.material)}</span>` : ''}
        <span>${fmt(p.qtyPer)}/pcs · tổng ${fmt(p.qtyReq)}</span>
      </div>
      <div class="part-act">${scopeBtn(`p:${p.ref}`, 'Chọn')} <button type="button" class="link" data-view="${esc(p.ref)}">Xem phiếu</button></div>
    </div>
    <div class="steps">${chips}</div>
  </div>`;
}

function renderSelbar() {
  const n = segsOf(S.selected).length;
  $('#selbar').hidden = n === 0;
  $('#sel-count').textContent = fmt(n);
}

/* ---------- Chọn phiếu ----------
 * Chọn theo phiếu tổ: bấm 1 công đoạn là chọn/bỏ cả phiếu tổ chứa công đoạn đó. */
function toggleIds(ids) {
  const segs = segsOf(ids);
  const allSel = segs.every(segSelected);
  if (!allSel && segs.length > 300 && !confirm(`Chọn ${fmt(segs.length)} phiếu?`)) return;
  segs.forEach((g) => g.steps.forEach((s) => (allSel ? S.selected.delete(s.id) : S.selected.add(s.id))));
  render();
}

/* ---------- Phiếu pallet ---------- */
function certOf(wood) {
  const w = String(wood || '');
  if (!/fsc/i.test(w) || /non[\s-]*fsc/i.test(w)) return 'NON FSC';
  const m = /FSC\s*(100\s*%|mix[^,;]*|recycled[^,;]*)?/i.exec(w);
  return m ? m[0].replace(/\s+/g, ' ').trim().toUpperCase() : 'FSC';
}

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
}

// Nhận hàng từ đâu / giao đi đâu của 1 phiếu tổ
function segFlow(g) {
  const p = g.part, a = g.steps[0], b = g.steps[g.steps.length - 1];
  const before = p.steps[a.idx - 1], after = p.steps[b.idx + 1];
  const from = before ? `tổ ${esc(before.group)} (${esc(before.stage)})` : p.kind === 'CUM' || p.kind === 'SP' ? 'ráp từ chi tiết/cụm' : 'kho gỗ';
  let to;
  if (after) to = `tổ ${esc(after.group)} (${esc(after.stage)})`;
  else {
    const par = p.parent; // cụm cha hoặc SP (production.js → linkParts)
    to = par ? `ráp vào ${esc(par.kind === 'SP' ? 'thành phẩm' : par.name)}` : 'Kết thúc';
  }
  return `Nhận từ: ${from} · Giao tới: <b>${to}</b>`;
}

function phieuHTML({ g, k, n }) {
  const p = g.part, d = p.det, mo = d.mo;
  const team = g.group || g.steps[0].stage; // tên tổ = nhóm công đoạn (Sơ chế, Tinh chế, Lắp ráp, Dầu, Đóng gói)
  const lsx = `${mo.no}${d.stt ? ' – Dòng ' + d.stt : ''}`;
  const cum = p.kind === 'SP' ? '—' : p.kind === 'CT rời' ? 'Chi tiết rời' : p.cumName;
  const qtyReq = Math.max(...g.steps.map((s) => s.qtyReq));
  // Danh sách công đoạn tại tổ: ô vuông để thống kê đánh dấu khi xong
  const checks = g.steps.map((s) => `<div class="ph-ck"><span class="ph-box"></span>
      <span class="ph-ck-t"><small>Bước ${s.no}</small>${esc(s.stage)}</span></div>`).join('');
  const two = g.steps.length > CHECK_COLS;
  const nRows = two ? LOG_ROWS.two : LOG_ROWS.one;
  const logTable = () => `<table class="ph-log">
      <colgroup><col style="width:33%"><col style="width:17%"><col style="width:32%"><col></colgroup>
      <thead><tr><th>Công đoạn</th><th>Ngày</th><th>Người làm</th><th>Số lượng</th></tr></thead>
      <tbody>${'<tr><td></td><td></td><td></td><td></td></tr>'.repeat(nRows)}</tbody>
    </table>`;
  return `<div class="phieu">
    <div class="ph-title">PHIẾU PALLET TỔ ${esc(team.toUpperCase())}</div>
    <div class="ph-head">
      <div class="ph-logo"><img src="assets/logo.png" alt=""></div>
      <table class="ph-info">
        <colgroup><col style="width:23mm"><col><col style="width:19mm"><col style="width:33mm"></colgroup>
        <tr><th>Lệnh sản xuất:</th><td>${esc(lsx)}</td><th>Kích thước:</th><td>${esc(p.size)}</td></tr>
        <tr><th>Sản phẩm:</th><td class="${d.name.length > 34 ? 'sm' : ''}" title="${esc(d.code)}">${esc(d.name)}</td><th>NVL:</th><td class="${(p.material || d.wood).length > 16 ? 'sm' : ''}">${esc(p.material || d.wood)}</td></tr>
        <tr><th>Cụm:</th><td>${esc(cum)}</td><th>SL/Pcs:</th><td>${fmt(p.qtyPer)}</td></tr>
        <tr><th>Tên chi tiết:</th><td class="big">${esc(p.name)}${p.code ? ` <small>${esc(p.code)}</small>` : ''}</td><th>SL Tổng:</th><td class="big">${fmt(qtyReq)}</td></tr>
        <tr><th>Mã lô gỗ:</th><td class="fill"></td><th>Pallet số:</th><td class="${n > 1 ? 'big' : 'fill'}">${n > 1 ? `${k} / ${n}` : ''}</td></tr>
        <tr><th>Mã lô dầu:</th><td class="fill"></td><th>Hạn giao:</th><td>${d.due ? fmtDate(d.due) : ''}</td></tr>
      </table>
      <div class="ph-qr">${qrSvg(p.ref)}<div class="ph-id">${esc(p.ref)}</div></div>
    </div>
    <div class="ph-cert"><span class="ph-flow">${segFlow(g)}</span><b>${esc(certOf(d.wood))}</b></div>
    <div class="ph-cks-l">Công đoạn tại tổ (${g.steps.length}) – tô/đánh dấu khi hoàn thành:</div>
    <div class="ph-cks">${checks}</div>
    <div class="ph-logs">${logTable()}${logTable()}</div>
    <div class="ph-sign"><div>Thống Kê</div><div>Tổ Trưởng</div></div>
  </div>`;
}

// Sắp xếp phiếu tổ: theo chi tiết (thứ tự LSX → SP → chi tiết → tổ) hoặc chia theo tổ
function sortSegs(segs, mode) {
  const seq = (g) => g.steps[0].seq;
  if (mode === 'stage') segs.sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.group.localeCompare(b.group, 'vi') || seq(a) - seq(b));
  else segs.sort((a, b) => seq(a) - seq(b));
  return segs;
}

function renderPreview() {
  const paper = $('#pv-paper').value, mode = $('#pv-sort').value;
  const copies = Math.max(1, Math.min(20, parseInt($('#pv-copies').value, 10) || 1));
  // Mỗi bản in = 1 pallet; in n bản thì đánh số Pallet 1/n … n/n (in 1 bản thì để trống ghi tay)
  const segs = sortSegs(segsOf(S.previewIds), mode);
  const st = segs.flatMap((g) => Array.from({ length: copies }, (_, i) => ({ g, k: i + 1, n: copies })));
  const per = paper === 'a4' ? 2 : 1;
  $('#page-size').textContent = paper === 'a4' ? '@page { size: A4 portrait; margin: 0; }' : '@page { size: A5 landscape; margin: 0; }';
  const pages = [];
  for (let i = 0; i < st.length; i += per) {
    pages.push(`<div class="page page-${paper}">${st.slice(i, i + per).map(phieuHTML).join('<div class="cut"></div>')}</div>`);
  }
  $('#print-pages').innerHTML = pages.join('');
  $('#pv-title').textContent = `${fmt(segs.length)} phiếu tổ${copies > 1 ? ` × ${copies} bản` : ''} · ${fmt(pages.length)} tờ ${paper === 'a4' ? 'A4' : 'A5'}`;
  try { localStorage.setItem('nscn.paper', paper); localStorage.setItem('nscn.sort', mode); } catch { /* ignore */ }
}

function openPreview(ids) {
  if (!ids.length) return;
  const nSeg = segsOf(ids).length;
  if (nSeg > 500 && !confirm(`Xem trước ${fmt(nSeg)} phiếu có thể chậm. Tiếp tục?`)) return;
  S.previewIds = ids;
  renderPreview();
  $('#preview').hidden = false;
  document.body.classList.add('previewing');
  $('#preview').scrollTop = 0;
}
function closePreview() {
  $('#preview').hidden = true;
  document.body.classList.remove('previewing');
  $('#print-pages').innerHTML = '';
  S.previewIds = null;
}
async function doPrint() {
  const imgs = [...document.querySelectorAll('#print-pages img')];
  await Promise.all(imgs.map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))));
  window.print();
}

/* Link chia sẻ: ?q=...&mo=LSX-..&stage=..&group=..&phieu=ID1,ID2&paper=a4 */
function applyUrlParams() {
  S.urlApplied = true;
  const u = new URLSearchParams(location.search);
  if (u.has('q')) $('#q').value = u.get('q');
  const map = { mo: 'f-mo', customer: 'f-customer', product: 'f-product', kind: 'f-kind', group: 'f-group', status: 'f-status' };
  for (const [k, id] of Object.entries(map)) if (u.has(k)) $('#' + id).value = u.get(k);
  fillStageOptions();
  if (u.has('stage')) $('#f-stage').value = u.get('stage');
  if (u.get('running') === '0') $('#f-running').checked = false;
  if (u.has('paper')) $('#pv-paper').value = u.get('paper');
  if (u.has('pallet')) $('#pv-copies').value = u.get('pallet');
  if (u.has('phieu')) S.pendingPreview = u.get('phieu').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

/* ---------- Menu tab & phân quyền ----------
 * Mỗi tab gắn 1 quyền. Quyền lấy từ /api/me (Cloudflare Access + biến PERMS).
 * Ẩn tab chỉ là giao diện; chức năng ghi/sửa dữ liệu phải kiểm quyền lại ở server. */
const TABS = [
  { id: 'san-luong', label: 'Báo cáo sản lượng', perm: 'report' },
  { id: 'phieu', label: 'Phiếu sản xuất', perm: 'phieu' },
  { id: 'kiem-tra', label: 'Kiểm tra dữ liệu', perm: 'audit', soon: true },
];
S.perms = new Set(['*']);
S.tab = '';
S.sub = '';
const can = (perm) => S.perms.has('*') || S.perms.has(perm);

async function loadMe() {
  try {
    const r = await fetch('api/me', { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
      const me = await r.json();
      S.me = me;
      S.perms = new Set(me.perms || []);
      if (me.email) $('#me').textContent = me.email;
    }
  } catch { /* chạy local không có Function → đủ quyền */ }
}

function renderTabs() {
  $('#tabs').innerHTML = TABS.filter((t) => can(t.perm)).map((t) =>
    `<a class="tab ${S.tab === t.id ? 'on' : ''}" href="#/${t.id}">${esc(t.label)}${t.soon ? ' <small>sắp có</small>' : ''}</a>`).join('');
}

function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [tab, ...rest] = path.split('/');
  if (query) rpFromQuery(new URLSearchParams(query));
  const allowed = TABS.filter((t) => can(t.perm));
  let t = allowed.find((x) => x.id === tab);
  if (!t) {
    // Link chia sẻ cũ (?q=…&phieu=…) mở thẳng tab phiếu
    const legacy = ['q', 'mo', 'phieu', 'stage', 'group', 'product'].some((k) => new URLSearchParams(location.search).has(k));
    t = (legacy && allowed.find((x) => x.id === 'phieu')) || allowed[0];
  }
  S.tab = t ? t.id : '';
  S.sub = rest.map(decodeURIComponent).join('/');
  document.body.dataset.tab = S.tab;
  renderTabs();
  if (S.tab === 'san-luong') renderReport();
  if (S.tab === 'kiem-tra') {
    $('#audit').innerHTML = `<div class="empty"><b>Kiểm tra &amp; đối chiếu dữ liệu</b><br>
      Đang đánh giá phương án (xem docs/Draft/DE_XUAT_KIEM_TRA_DU_LIEU.md). Chức năng sẽ bật sau khi duyệt.</div>`;
  }
  if (!t) $('#report').innerHTML = '<div class="empty">Tài khoản chưa được cấp quyền xem mục nào.</div>';
}

/* ---------- Sự kiện ---------- */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function init() {
  $('#year').textContent = new Date().getFullYear();
  initReport();
  window.addEventListener('hashchange', route);
  await loadMe();
  route();
  try {
    const p = localStorage.getItem('nscn.paper'); if (p) $('#pv-paper').value = p;
    const s = localStorage.getItem('nscn.sort'); if (s) $('#pv-sort').value = s;
  } catch { /* ignore */ }

  $('#q').addEventListener('input', debounce(update, 200));
  $('#q').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // Quét QR (máy quét gửi Enter): nếu đúng 1 mã phiếu thì mở luôn phiếu đó
    const ids = idsFromCode($('#q').value);
    if (ids.length) openPreview(ids);
  });
  F_IDS.forEach((id) => $('#' + id).addEventListener('change', () => { if (id === 'f-group') fillStageOptions(); update(); }));
  $('#f-running').addEventListener('change', update);
  $('#btn-clear').addEventListener('click', () => {
    $('#q').value = '';
    F_IDS.forEach((id) => { $('#' + id).value = ''; });
    fillStageOptions();
    update();
  });
  $('#btn-refresh').addEventListener('click', () => load(true));
  $('#btn-expand').addEventListener('click', () => {
    S.view.forEach((vm) => { S.expand.set(`m:${vm.mo.id}`, true); vm.details.forEach((vd) => S.expand.set(`d:${vd.det.id}`, true)); });
    render();
  });
  $('#btn-collapse').addEventListener('click', () => {
    S.view.forEach((vm) => { S.expand.set(`m:${vm.mo.id}`, true); vm.details.forEach((vd) => S.expand.set(`d:${vd.det.id}`, false)); });
    render();
  });
  $('#btn-select-all').addEventListener('click', () => toggleIds(S.scopes.get('all') || []));
  $('#btn-sel-clear').addEventListener('click', () => { S.selected.clear(); render(); });
  $('#btn-preview').addEventListener('click', () => openPreview([...S.selected]));

  $('#tree').addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    if (step) { toggleIds([step.dataset.step]); return; }
    const scope = e.target.closest('[data-scope]');
    if (scope) { e.stopPropagation(); toggleIds(S.scopes.get(scope.dataset.scope) || []); return; }
    const view = e.target.closest('[data-view]');
    if (view) { openPreview(S.scopes.get(`p:${view.dataset.view}`) || []); return; }
    const tg = e.target.closest('[data-toggle]');
    if (tg) { const k = tg.dataset.toggle; S.expand.set(k, !isOpen(k)); render(); }
  });

  $('#pv-close').addEventListener('click', closePreview);
  $('#pv-print').addEventListener('click', doPrint);
  $('#pv-paper').addEventListener('change', renderPreview);
  $('#pv-sort').addEventListener('change', renderPreview);
  $('#pv-copies').addEventListener('change', renderPreview);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.previewIds) closePreview(); });

  // Tự làm mới: chỉ khi tab đang mở, không đang xem trước/in
  setInterval(() => {
    updateSync();
    if (document.visibilityState === 'visible' && !S.previewIds && Date.now() - S.loadedAt >= AUTO_REFRESH_MS) load(false);
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !S.previewIds && Date.now() - S.loadedAt >= AUTO_REFRESH_MS) load(false);
  });

  load(false);
}

// Chạy sau khi mọi script (production.js, report.js) đã nạp
document.addEventListener('DOMContentLoaded', init);
