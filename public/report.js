/* Báo cáo sản lượng – Tổng xưởng 1 (Nghĩa Sơn Chi Nhánh) & 5 tổ.
 *  Màn hình chính: tổng xưởng + 5 thẻ tổ. Bấm thẻ → chi tiết (theo công đoạn, theo ngày, theo LSX/SP).
 *  Sản lượng tổ = số lượng ra khỏi tổ (xong bước cuối của tổ trên từng chi tiết/cụm/SP).
 *  Tổng xưởng = thành phẩm xong Đóng gói. m³ quy đổi theo BOM Wood. */
'use strict';

const RP = { mode: 'day', anchor: '', from: '', to: '', m3: 'f', open: new Set() };
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

const fmtM3 = (n) => (Number(n) || 0).toLocaleString('vi-VN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmtD = (k) => `${k.slice(8)}/${k.slice(5, 7)}/${k.slice(0, 4)}`;
const fmtDM = (k) => `${k.slice(8)}/${k.slice(5, 7)}`;
const kindOf = (p) => (p.kind === 'SP' ? 'sp' : p.kind === 'CUM' ? 'cum' : 'ct');
const m3Of = (p) => (RP.m3 === 'r' ? p.m3r : p.m3f) || 0;
const blank = () => ({ ct: 0, cum: 0, sp: 0, m3: 0, e: 0, r: 0, n: 0 });
function addTo(o, st, e, r = 0, n = 0) { o[kindOf(st.part)] += e; o.m3 += e * m3Of(st.part); o.e += e; o.r += r; o.n += n; }
const isFinal = (st) => st.part.kind === 'SP' && st.idx === st.part.steps.length - 1;

/* ---------- Kỳ báo cáo ---------- */
function isoWeek(k) {
  const d = toDate(k);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / 864e5 - 3 + ((w1.getDay() + 6) % 7)) / 7);
}
function rpRange() {
  const a = RP.anchor;
  if (RP.mode === 'week') { const f = addDays(a, -((toDate(a).getDay() + 6) % 7)); return [f, addDays(f, 6)]; }
  if (RP.mode === 'month') { const f = a.slice(0, 8) + '01'; const d = toDate(f); d.setMonth(d.getMonth() + 1, 0); return [f, dkey(d)]; }
  if (RP.mode === 'custom') { let f = RP.from || a, t = RP.to || a; if (f > t) [f, t] = [t, f]; return [f, t]; }
  return [a, a];
}
function rpShift(n) {
  if (RP.mode === 'day') RP.anchor = addDays(RP.anchor, n);
  else if (RP.mode === 'week') RP.anchor = addDays(RP.anchor, 7 * n);
  else if (RP.mode === 'month') { const d = toDate(RP.anchor.slice(0, 8) + '01'); d.setMonth(d.getMonth() + n); RP.anchor = dkey(d); }
  else {
    const [f, t] = rpRange(), span = dayList(f, t).length;
    RP.from = addDays(f, n * span); RP.to = addDays(t, n * span);
  }
}
function rpLabel() {
  const [f, t] = rpRange();
  if (RP.mode === 'day') return `${WD[toDate(f).getDay()]}, ${fmtD(f)}`;
  if (RP.mode === 'week') return `Tuần ${isoWeek(f)} · ${fmtDM(f)} – ${fmtD(t)}`;
  if (RP.mode === 'month') return `Tháng ${f.slice(5, 7)}/${f.slice(0, 4)}`;
  return `${fmtD(f)} – ${fmtD(t)} (${dayList(f, t).length} ngày)`;
}
// Cột biểu đồ: theo ngày (≤ 62 ngày) hoặc theo tuần. Xem 1 ngày thì hiện thêm 13 ngày trước để so sánh.
function rpBuckets() {
  const [f, t] = rpRange();
  const days = dayList(RP.mode === 'day' ? addDays(t, -13) : f, t);
  if (days.length <= 62) return days.map((k) => ({ from: k, to: k, label: fmtDM(k), tip: `${WD[toDate(k).getDay()]} ${fmtD(k)}`, sel: k >= f && k <= t }));
  const out = [];
  for (const k of days) {
    const mon = addDays(k, -((toDate(k).getDay() + 6) % 7));
    let b = out[out.length - 1];
    if (!b || b.key !== mon) out.push((b = { key: mon, from: k, to: k, label: `T${isoWeek(k)}`, sel: true }));
    b.to = k;
    b.tip = `Tuần ${isoWeek(k)}: ${fmtD(b.from)} – ${fmtD(b.to)}`;
  }
  return out;
}

/* ---------- Tổng hợp ---------- */
function rpRows(from, to, group) {
  const out = [];
  for (const [day, m] of P.daily) {
    if (day < from || day > to) continue;
    for (const [id, v] of m) {
      const st = S.steps.get(id);
      if (st && (!group || (group === 'xuong' ? isFinal(st) : st.group === group))) out.push({ day, st, e: v.e, r: v.r, n: v.n });
    }
  }
  return out;
}
function summarize(rows) {
  const groups = new Map(REPORT_GROUPS.map((g) => [g, { out: blank(), all: blank(), stages: new Map() }]));
  const xuong = blank();
  let n = 0;
  for (const { st, e, r, n: k } of rows) {
    let G = groups.get(st.group);
    if (!G) groups.set(st.group, (G = { out: blank(), all: blank(), stages: new Map() }));
    addTo(G.all, st, e, r, k);
    if (st.exit) addTo(G.out, st, e);
    let s = G.stages.get(st.stage);
    if (!s) G.stages.set(st.stage, (s = blank()));
    addTo(s, st, e, r, k);
    if (isFinal(st)) addTo(xuong, st, e, r);
    n += k;
  }
  return { groups, xuong, n };
}
const series = (buckets, group, pick) => buckets.map((b) => {
  const sm = summarize(rpRows(b.from, b.to, group));
  return pick(sm);
});

/* ---------- Thành phần giao diện ---------- */
function kpi(label, value, unit, sub = '') {
  return `<div class="kpi"><span class="kpi-l">${label}</span><span class="kpi-v">${value}<small>${unit}</small></span>${sub ? `<span class="kpi-s">${sub}</span>` : ''}</div>`;
}
// Biểu đồ cột 1 chuỗi (1 màu), cột kỳ đang xem đậm, các ngày tham chiếu nhạt
function bars(buckets, values, { unit = 'm³', f = fmtM3, tall = false } = {}) {
  const max = Math.max(0, ...values);
  if (!max) return `<div class="bars-empty ${tall ? 'tall' : ''}">Chưa có ghi nhận trong kỳ</div>`;
  const step = buckets.length > 20 ? Math.ceil(buckets.length / 10) : 1;
  const cols = buckets.map((b, i) => {
    const h = values[i] > 0 ? Math.max(2, (values[i] / max) * 100) : 0;
    return `<div class="bc ${b.sel ? 'sel' : ''}" data-tip="${esc(`${b.tip}: ${f(values[i])} ${unit}`)}">
      <i style="height:${h}%"></i><span>${i % step === 0 || i === buckets.length - 1 ? esc(b.label) : ''}</span></div>`;
  }).join('');
  return `<div class="bars ${tall ? 'tall' : ''}"><span class="bars-max">${f(max)} ${unit}</span>${cols}</div>`;
}
function pcsLine(o, withSp = true) {
  const a = [];
  if (o.ct) a.push(`<b>${fmtQ(o.ct)}</b> chi tiết`);
  if (o.cum) a.push(`<b>${fmtQ(o.cum)}</b> cụm`);
  if (o.sp && withSp) a.push(`<b>${fmtQ(o.sp)}</b> SP`);
  return a.join(' · ') || '<span class="muted">0</span>';
}

/* ---------- Màn hình chính ---------- */
function renderOverview() {
  const [f, t] = rpRange();
  const sm = summarize(rpRows(f, t));
  const bk = rpBuckets();
  const xSeries = series(bk, 'xuong', (s) => s.xuong.m3);
  const maxTeam = Math.max(0, ...REPORT_GROUPS.map((g) => sm.groups.get(g).out.m3));
  const cmp = REPORT_GROUPS.map((g) => {
    const o = sm.groups.get(g).out;
    return `<button class="cmp-row" data-go="${esc(g)}" type="button"><span class="cmp-n">${esc(teamName(g))}</span>
      <span class="cmp-bar"><i style="width:${maxTeam ? (o.m3 / maxTeam) * 100 : 0}%"></i></span>
      <span class="cmp-v">${fmtM3(o.m3)} m³</span></button>`;
  }).join('');
  const x = sm.xuong;
  const teams = REPORT_GROUPS.map((g) => {
    const G = sm.groups.get(g);
    const top = [...G.stages].sort((a, b) => stageOrder(a[0], b[0])).map(([s, v]) =>
      `<li><span>${esc(s)}</span><b>${fmtQ(v.e)}</b></li>`).join('');
    return `<div class="team" role="button" tabindex="0" data-go="${esc(g)}">
      <header><h3>Tổ ${esc(teamName(g))}</h3><span class="go">Chi tiết ›</span></header>
      <div class="team-m3">${fmtM3(G.out.m3)}<small> m³</small></div>
      <div class="team-pcs">${pcsLine(G.out)}</div>
      ${bars(bk, series(bk, g, (s) => s.groups.get(g).out.m3))}
      <ul class="team-st">${top || '<li class="muted">Chưa có công đoạn nào ghi nhận</li>'}</ul>
    </div>`;
  }).join('');
  return `${warnBad()}
    <section class="card xuong">
      <header class="card-h" data-go="xuong"><h2>Tổng xưởng 1 <small>Nghĩa Sơn Chi Nhánh</small></h2><span class="spacer"></span><span class="go">Xem chi tiết theo LSX / SP ›</span></header>
      <div class="xuong-body">
        <div>
          <div class="kpis">
            ${kpi('Thành phẩm đóng gói', fmtQ(x.sp), ' SP')}
            ${kpi('m³ thành phẩm', fmtM3(x.m3), ' m³')}
            ${kpi('Lượt ghi nhận', fmt(sm.n), ' dòng', 'trong Pallet Log')}
          </div>
          ${bars(bk, xSeries, { tall: true })}
        </div>
        <div class="cmp"><div class="cmp-t">m³ ra khỏi từng tổ</div>${cmp}</div>
      </div>
    </section>
    <div class="teams">${teams}</div>
    ${note()}`;
}

function note() {
  return `<details class="rp-note"><summary>Cách tính sản lượng</summary><ul>
    <li><b>Sản lượng tổ</b> = số chi tiết / cụm / SP <b>ra khỏi tổ</b> (xong bước cuối thuộc tổ đó trên từng chi tiết). Danh sách công đoạn trong thẻ là số lượt qua từng công đoạn.</li>
    <li><b>Tổng xưởng</b> = thành phẩm xong <b>Đóng gói</b>.</li>
    <li><b>Bỏ qua công đoạn</b>: công đoạn sau đã có số thì công đoạn trước được tính hoàn thành bằng số đó (gán vào ngày báo công đoạn sau). Cụm đã ráp → chi tiết của cụm tính đã xong; SP đã ráp → cụm và chi tiết rời tính đã xong.</li>
    <li><b>m³</b> quy đổi theo BOM Wood (${RP.m3 === 'r' ? 'm³ phôi sơ chế – cột m3_rough' : 'm³ tinh – cột m3_finish'}); cụm/SP = tổng gỗ các chi tiết bên trong. Gỗ đi qua nhiều tổ nên <b>không cộng m³ các tổ với nhau</b>.</li>
    <li>Nguồn: tab <b>Pallet Log</b> (ngày = work_date). Dữ liệu ghi nhận ${P.minDay ? `từ ${fmtD(P.minDay)} đến ${fmtD(P.maxDay)}` : 'chưa có'}.</li>
  </ul></details>`;
}
function warnBad() {
  if (!P.bad.length) return '';
  const list = P.bad.slice(0, 20).map((b) => `<li>Dòng ${b.row}: ${esc(b.id || '(trống)')} – ${esc(b.why)}</li>`).join('');
  return `<details class="rp-warn"><summary>⚠ ${fmt(P.bad.length)} dòng Pallet Log không tính được vào báo cáo</summary><ul>${list}</ul></details>`;
}

/* ---------- Chi tiết 1 tổ ---------- */
function renderTeam(g) {
  const [f, t] = rpRange();
  const rows = rpRows(f, t, g);
  const sm = summarize(rows), G = sm.groups.get(g) || { out: blank(), all: blank(), stages: new Map() };
  const bk = rpBuckets();
  const days = dayList(f, t);
  const matrix = days.length > 1 && days.length <= 31;
  const stages = [...G.stages.keys()].sort(stageOrder);

  // Công đoạn × ngày
  const byDay = new Map();
  for (const r of rows) { const k = `${r.st.stage}|${r.day}`; byDay.set(k, (byDay.get(k) || 0) + r.e); }
  const head = `<tr><th>Công đoạn</th><th class="n">Chi tiết</th><th class="n">Cụm</th><th class="n">SP</th><th class="n">m³</th><th class="n" title="Số lượng tổ tự báo trên phiếu">Đã báo</th><th class="n" title="Số tính thêm do công đoạn sau đã báo">Suy ra</th>${matrix ? days.map((d) => `<th class="n d">${fmtDM(d)}</th>`).join('') : ''}</tr>`;
  const body = stages.map((s) => {
    const v = G.stages.get(s);
    return `<tr><td>${esc(s)}</td><td class="n">${fmtQ(v.ct)}</td><td class="n">${fmtQ(v.cum)}</td><td class="n">${fmtQ(v.sp)}</td><td class="n">${fmtM3(v.m3)}</td>
      <td class="n">${fmtQ(v.r)}</td><td class="n ${v.e - v.r > 0.5 ? 'inf' : ''}">${fmtQ(Math.max(0, v.e - v.r))}</td>
      ${matrix ? days.map((d) => { const q = byDay.get(`${s}|${d}`) || 0; return `<td class="n d">${q ? fmtQ(q) : ''}</td>`; }).join('') : ''}</tr>`;
  }).join('');
  const o = G.out;
  return `${crumb(`Tổ ${teamName(g)}`)}
    <section class="card">
      <div class="kpis">
        ${kpi('m³ ra khỏi tổ', fmtM3(o.m3), ' m³')}
        ${o.ct || !o.cum ? kpi('Chi tiết ra tổ', fmtQ(o.ct), ' ct') : ''}
        ${o.cum ? kpi('Cụm ra tổ', fmtQ(o.cum), ' cụm') : ''}
        ${o.sp ? kpi('SP ra tổ', fmtQ(o.sp), ' SP') : ''}
        ${kpi('Lượt ghi nhận', fmt(G.all.n), ' dòng')}
      </div>
      ${bars(bk, series(bk, g, (x) => (x.groups.get(g) || { out: blank() }).out.m3), { tall: true })}
    </section>
    <section class="card"><h3 class="card-t">Theo công đoạn</h3>
      ${stages.length ? `<div class="tbl-wrap"><table class="tbl">${head}${body}</table></div>` : '<p class="muted">Chưa có ghi nhận trong kỳ.</p>'}
    </section>
    <section class="card"><h3 class="card-t">Theo LSX · sản phẩm <small>bấm dòng để xem từng chi tiết</small></h3>${detTable(rows, g)}</section>`;
}

function detTable(rows, g) {
  const dets = new Map();
  for (const { st, e } of rows) {
    const det = st.part.det;
    let D = dets.get(det.id);
    if (!D) dets.set(det.id, (D = { det, out: blank(), parts: new Map(), stages: new Set() }));
    if (st.exit) addTo(D.out, st, e);
    let Pp = D.parts.get(st.part.ref);
    if (!Pp) D.parts.set(st.part.ref, (Pp = { p: st.part, st: new Map(), m3: 0 }));
    Pp.st.set(st.stage, (Pp.st.get(st.stage) || 0) + e);
    if (st.exit) Pp.m3 += e * m3Of(st.part);
    D.stages.add(st.stage);
  }
  if (!dets.size) return '<p class="muted">Chưa có ghi nhận trong kỳ.</p>';
  const list = [...dets.values()].sort((a, b) => a.det.mo.no.localeCompare(b.det.mo.no, 'vi', { numeric: true }) || num(a.det.stt) - num(b.det.stt));
  return `<div class="tbl-wrap"><table class="tbl tbl-det">
    <tr><th>LSX</th><th>Sản phẩm</th><th class="n">Chi tiết</th><th class="n">Cụm</th><th class="n">SP</th><th class="n">m³</th><th>Đồng bộ hiện tại</th></tr>
    ${list.map((D) => {
      const d = D.det, open = RP.open.has(d.id);
      const stg = [...D.stages].sort(stageOrder);
      const sub = open ? `<tr class="sub"><td colspan="7"><table class="tbl tbl-in">
          <tr><th>Chi tiết / cụm</th>${stg.map((s) => `<th class="n">${esc(s)}</th>`).join('')}<th class="n">m³ ra tổ</th></tr>
          ${[...D.parts.values()].map((x) => `<tr><td>${esc(x.p.name)} <span class="kind">${esc(KIND_LABEL[x.p.kind] || x.p.kind)}</span></td>
            ${stg.map((s) => `<td class="n">${x.st.has(s) ? fmtQ(x.st.get(s)) : ''}</td>`).join('')}<td class="n">${fmtM3(x.m3)}</td></tr>`).join('')}
        </table></td></tr>` : '';
      return `<tr class="row ${open ? 'open' : ''}" data-det="${esc(d.id)}"><td><span class="caret">▸</span> ${esc(d.mo.no)}${d.stt ? ` · D${esc(d.stt)}` : ''}</td>
        <td>${esc(d.name)} <span class="muted">${fmt(d.qty)} ${esc(d.unit)}</span></td>
        <td class="n">${fmtQ(D.out.ct)}</td><td class="n">${fmtQ(D.out.cum)}</td><td class="n">${fmtQ(D.out.sp)}</td><td class="n">${fmtM3(D.out.m3)}</td>
        <td>${syncBar(d).replace(/^<div class="sync-bar">|<\/div>$/g, '')}</td></tr>${sub}`;
    }).join('')}
  </table></div>`;
}

/* ---------- Chi tiết tổng xưởng: theo dòng SP × tổ ---------- */
function renderXuong() {
  const [f, t] = rpRange();
  const rows = rpRows(f, t);
  const bk = rpBuckets();
  const sm = summarize(rows);
  const dets = new Map();
  for (const { st, e } of rows) {
    const det = st.part.det;
    let D = dets.get(det.id);
    if (!D) dets.set(det.id, (D = { det, g: new Map(), x: blank() }));
    if (st.exit) D.g.set(st.group, (D.g.get(st.group) || 0) + e * m3Of(st.part));
    if (isFinal(st)) addTo(D.x, st, e);
  }
  const list = [...dets.values()].sort((a, b) => a.det.mo.no.localeCompare(b.det.mo.no, 'vi', { numeric: true }) || num(a.det.stt) - num(b.det.stt));
  const x = sm.xuong;
  return `${crumb('Tổng xưởng 1')}
    <section class="card">
      <div class="kpis">${kpi('Thành phẩm đóng gói', fmtQ(x.sp), ' SP')}${kpi('m³ thành phẩm', fmtM3(x.m3), ' m³')}${kpi('Lượt ghi nhận', fmt(sm.n), ' dòng')}</div>
      ${bars(bk, series(bk, 'xuong', (s) => s.xuong.sp), { unit: 'SP', f: fmtQ, tall: true })}
    </section>
    <section class="card"><h3 class="card-t">m³ ra từng tổ theo LSX · sản phẩm</h3>
      ${list.length ? `<div class="tbl-wrap"><table class="tbl">
        <tr><th>LSX</th><th>Sản phẩm</th>${REPORT_GROUPS.map((g) => `<th class="n">${esc(teamName(g))}</th>`).join('')}<th class="n">TP (SP)</th><th>Đồng bộ hiện tại</th></tr>
        ${list.map((D) => `<tr><td>${esc(D.det.mo.no)}${D.det.stt ? ` · D${esc(D.det.stt)}` : ''}</td><td>${esc(D.det.name)}</td>
          ${REPORT_GROUPS.map((g) => `<td class="n">${D.g.get(g) ? fmtM3(D.g.get(g)) : ''}</td>`).join('')}
          <td class="n">${D.x.sp ? fmtQ(D.x.sp) : ''}</td><td>${syncBar(D.det).replace(/^<div class="sync-bar">|<\/div>$/g, '')}</td></tr>`).join('')}
        <tr class="tot"><td colspan="2">Cộng</td>${REPORT_GROUPS.map((g) => `<td class="n">${fmtM3(sm.groups.get(g).out.m3)}</td>`).join('')}<td class="n">${fmtQ(x.sp)}</td><td></td></tr>
      </table></div>` : '<p class="muted">Chưa có ghi nhận trong kỳ.</p>'}
    </section>`;
}

function crumb(title) {
  return `<nav class="crumb"><a href="#/san-luong">‹ Tổng quan xưởng</a><span>/</span><b>${esc(title)}</b><span class="spacer"></span>
    ${REPORT_GROUPS.map((g) => `<a class="pill ${S.sub === g ? 'on' : ''}" href="#/san-luong/${encodeURIComponent(g)}">${esc(teamName(g))}</a>`).join('')}</nav>`;
}

/* ---------- Điều khiển ---------- */
function renderReport() {
  if (S.tab !== 'san-luong') return;
  document.querySelectorAll('#rp-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === RP.mode));
  $('#rp-label').textContent = rpLabel();
  $('#rp-date').value = RP.anchor;
  $('#rp-date').hidden = RP.mode === 'custom';
  $('#rp-custom').hidden = RP.mode !== 'custom';
  const [f, t] = rpRange();
  $('#rp-from').value = f; $('#rp-to').value = t;
  $('#rp-m3').value = RP.m3;
  if (!S.mos.length) { if (S.loading) $('#report').innerHTML = '<div class="empty">Đang tải dữ liệu…</div>'; return; }
  const sub = S.sub;
  $('#report').innerHTML = sub === 'xuong' ? renderXuong() : REPORT_GROUPS.includes(sub) ? renderTeam(sub) : renderOverview();
  try { localStorage.setItem('nscn.rp', JSON.stringify({ mode: RP.mode, m3: RP.m3 })); } catch { /* ignore */ }
  // Giữ kỳ đang xem trên link để chia sẻ: #/san-luong/<tổ>?k=week&d=2026-11-12
  const q = new URLSearchParams({ k: RP.mode });
  if (RP.mode === 'custom') { q.set('from', f); q.set('to', t); } else q.set('d', RP.anchor);
  if (RP.m3 !== 'f') q.set('m3', RP.m3);
  history.replaceState(null, '', `#/san-luong${sub ? '/' + encodeURIComponent(sub) : ''}?${q}`);
}
function rpFromQuery(q) {
  const ok = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k || '');
  if (['day', 'week', 'month', 'custom'].includes(q.get('k'))) RP.mode = q.get('k');
  if (ok(q.get('d'))) RP.anchor = q.get('d');
  if (ok(q.get('from'))) RP.from = q.get('from');
  if (ok(q.get('to'))) RP.to = q.get('to');
  if (['f', 'r'].includes(q.get('m3'))) RP.m3 = q.get('m3');
}

function initReport() {
  RP.anchor = todayKey();
  try { const s = JSON.parse(localStorage.getItem('nscn.rp') || '{}'); if (s.mode) RP.mode = s.mode; if (s.m3) RP.m3 = s.m3; } catch { /* ignore */ }
  $('#rp-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    if (b.dataset.mode === 'custom' && RP.mode !== 'custom') { const [f, t] = rpRange(); RP.from = f; RP.to = t; }
    RP.mode = b.dataset.mode;
    renderReport();
  });
  $('#rp-prev').addEventListener('click', () => { rpShift(-1); renderReport(); });
  $('#rp-next').addEventListener('click', () => { rpShift(1); renderReport(); });
  $('#rp-today').addEventListener('click', () => {
    RP.anchor = todayKey();
    if (RP.mode === 'custom') { RP.from = addDays(RP.anchor, -6); RP.to = RP.anchor; }
    renderReport();
  });
  $('#rp-date').addEventListener('change', (e) => { if (e.target.value) { RP.anchor = e.target.value; renderReport(); } });
  $('#rp-from').addEventListener('change', (e) => { if (e.target.value) { RP.from = e.target.value; renderReport(); } });
  $('#rp-to').addEventListener('change', (e) => { if (e.target.value) { RP.to = e.target.value; renderReport(); } });
  $('#rp-m3').addEventListener('change', (e) => { RP.m3 = e.target.value; renderReport(); });
  $('#report').addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { location.hash = `#/san-luong/${encodeURIComponent(go.dataset.go)}`; return; }
    const row = e.target.closest('[data-det]');
    if (row) { const id = row.dataset.det; RP.open.has(id) ? RP.open.delete(id) : RP.open.add(id); renderReport(); }
  });
  $('#report').addEventListener('keydown', (e) => {
    const go = e.target.closest('.team[data-go]');
    if (go && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go.click(); }
  });

  // Tooltip cho cột biểu đồ
  const tip = $('#tip');
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 6)}px`;
  });
}
