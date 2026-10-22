/* ══ 833 复习站 · 纯静态前端 ══ */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const J = async (p) => (await fetch(p)).json();
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n{3,}/g, '\n\n');
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(()=>t.classList.remove('on'), 190); };

/* ───── 数据 ───── */
let META = null, QS = [], QMAP = {}, MAPS = [], BYID = {}, PAGES = null;
let S = { cards:{}, reviews:[], wrong:{}, papers:[], star:{}, notes:{}, settings:null };
const DEF_SET = { dailyNew:20, ratio:2, order:'review', retention:0.9, dailyReview:120, autoClearWrong:2,
                 pdfPath:'', pdfOffset:15, highFirst:true };

/* ───── 存储 ───── */
function load(){
  try { const raw = localStorage.getItem('833review'); if (raw) S = Object.assign(S, JSON.parse(raw)); } catch(e){}
  S.settings = Object.assign({}, DEF_SET, S.settings || {});
  if (!S.star) S.star = {}; if (!S.notes) S.notes = {};
}
function save(){ localStorage.setItem('833review', JSON.stringify(S)); scheduleArchive(); }

/* ───── 调度器 FSRS-lite（D/S/R） ───── */
const FACTOR = 19/81, DECAY = -0.5, INIT_S = {1:0.4, 2:0.9, 3:1.6};
const GL = {1:'不会', 2:'模糊', 3:'清晰'};
function retrievability(elapsed, s){ return s<=0 ? 0 : Math.pow(1 + FACTOR*Math.max(0,elapsed)/s, DECAY); }
/* 间隔随目标留存率缩放：r 为期望留存率，s(天) 处 R≈0.9；r^-2 由 R(t)=(1+FACTOR·t/S)^DECAY 反解 */
function retentionDays(s){
  const rr = Math.min(0.98, Math.max(0.7, +((S.settings||{}).retention) || 0.9));
  return s * (Math.pow(rr, 1/DECAY) - 1) / FACTOR;
}
/* fuzz：按卡片 id 确定性抖动 ±4%，防同批卡片永远同天到期（Anki 同思路） */
function fuzzDays(id, days){
  if (days < 1) return days;
  let h = 0; for (const c of String(id)) h = (h*31 + c.charCodeAt(0)) >>> 0;
  return days * (1 + ((h % 9) - 4) / 100);
}
function nextState(card, g, now){
  let st = card.state || 'new', s = +card.s || 0, d = +card.d || 5;
  const elapsed = (now - (+card.last || now))/86400000;
  if (st === 'new' || s <= 0){
    s = INIT_S[g]; d = Math.max(1, Math.min(10, 5 + (g-2)*1.2));
    st = g === 1 ? 'relearning' : 'learning';
  } else {
    const r = retrievability(elapsed, s);
    if (g === 1){ s = Math.max(0.15, s*(0.35 + 0.15*(1-r))); d += 1.4; st = 'relearning'; }
    else {
      let grow = Math.exp(8/(9 - Math.min(d,8.5) + 1)) * Math.pow(s,-0.5) * (Math.exp((1-r)*0.9) - 1);
      if (g === 2) grow *= 0.7;
      s = s*(1+grow); d += (g===2 ? 0.7 : -0.6); st = 'review';
    }
  }
  d = Math.max(1, Math.min(10, 0.9*d + 0.1*5));
  let days;
  if (g === 1) days = 10/1440;
  else if (st === 'learning' && g === 2) days = 1;
  else days = Math.max(1, Math.round(fuzzDays(card.id || '', retentionDays(s))));
  const min = days * 1440;
  return { card:{state:st, s:+s.toFixed(4), d:+d.toFixed(3), due: now + min*60,   // min 为分钟 → 秒
                 reps:(+card.reps||0)+1, lapses:(+card.lapses||0)+(g===1?1:0), last:now}, days: min/1440 };
}
function preview(card, g, now){ return nextState(card, g, now).days; }
function fmtDays(v){ if (v == null) return '—'; if (v < 1/24) return Math.round(v*24*60)+'分钟'; if (v < 1) return Math.round(v*24)+'小时'; return Math.round(v)+'天'; }

/* ───── 掌握度 v2（DeepTutor mastery gate 思路：状态 × 可提取性 R，遗忘惩罚 + 复习加成） ───── */
function mastery(id){
  const c = S.cards[id]; if (!c || c.state === 'new') return 0;
  const now = Date.now()/1000;
  const s = +c.s || 0.1;
  const elapsed = Math.max(0, (now - (+c.last || now))/86400000);
  const r = retrievability(elapsed, s);              // 0~1 当前记忆可提取性（随时间衰减）
  const base = {learning:.4, relearning:.3, review:.65}[c.state] ?? .35;
  let m = base * (0.3 + 0.7*r);                      // 状态底盘 × 当前可提取性
  m += Math.min(0.15, (+c.reps||0) * 0.01);          // 复习次数加成（封顶 0.15）
  m -= Math.min(0.25, (+c.lapses||0) * 0.05);        // 遗忘（评"不会"）惩罚（封顶 0.25）
  return Math.max(0, Math.min(1, m));
}
const GATE_T = 0.8;                                   // 掌握闸控阈值：≥80% 视为已掌握
function masteryColor(m){ return m < 0.4 ? '#ff6b6b' : m < 0.75 ? '#ffb454' : '#38d69c'; }
function renderTypeMastery(){
  const box = $('#typeMastery'); if (!box || !QS.length) return;
  box.innerHTML = ['名词解释','问答题','计算题'].map(t => {
    const qs = QS.filter(q => q.type === t);
    const m = qs.length ? qs.reduce((s,q)=>s+mastery(q.id),0)/qs.length : 0;
    const pct = Math.round(m*100);
    return `<span class="tm-item" title="${t}平均掌握度 ${pct}%"><i>${t}</i><span class="tm-bar"><b style="width:${pct}%;background:${masteryColor(m)}"></b></span><em>${pct}%</em></span>`;
  }).join('');
}
function renderTodayRing(){
  const box = $('#todayRing'); if (!box || !QS.length) return;
  const t0 = new Date(); t0.setHours(0,0,0,0);
  const doneToday = S.reviews.filter(r => r.ts >= t0.getTime()/1000).length;
  const remain = dueCards().length + newCards().slice(0, Math.max(0, +S.settings.dailyNew || 0)).length;
  const total = doneToday + remain;
  const pct = total ? doneToday/total : 1;
  const C = 2*Math.PI*15;
  box.innerHTML = `<svg width="38" height="38" viewBox="0 0 38 38">
      <circle class="tr-bg" cx="19" cy="19" r="15" fill="none" stroke-width="4"/>
      <circle class="tr-fg" cx="19" cy="19" r="15" fill="none" stroke-width="4" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C*(1-pct)).toFixed(1)}"/></svg>
    <span>今日已练 <b>${doneToday}</b> 题${remain ? ` · 队列还剩 <b>${remain}</b> 题` : ' · <span class="done">今日目标完成 ✓</span>'}</span>`;
}

/* ───── 队列 ───── */
function dueCards(){
  const now = Date.now()/1000;
  return Object.values(S.cards).filter(c => c.due && c.due <= now && QMAP[c.id])
    .sort((a,b)=>a.due-b.due);
}
function newCards(){
  return QS.filter(q => !S.cards[q.id]);
}
function buildQueue(mode, opts){
  const set = S.settings;
  let rev = dueCards().map(c => ({ id:c.id, kind:'review', card:c }));
  let nw = newCards().map(q => ({ id:q.id, kind:'new' }));
  if (mode === 'wrong'){
    return Object.entries(S.wrong).filter(([id, w]) => !w.cleared && QMAP[id])
      .map(([id]) => ({id, kind:'wrong'}))
      .sort((a,b)=> (QMAP[b.id].freq - QMAP[a.id].freq));
  }
  const ratio = Math.max(0, +set.ratio || 0);
  const byFreq = (a,b)=> (QMAP[b.id].freq - QMAP[a.id].freq) || (QMAP[b.id].year - QMAP[a.id].year);
  if (set.highFirst){ nw.sort(byFreq); rev.sort(byFreq); }
  const limitNew = Math.max(0, +set.dailyNew || 0);
  const limitRev = Math.max(0, +set.dailyReview || 120);
  nw = nw.slice(0, limitNew);
  // 复习额度 = 新题数 × 比例；ratio=0（只复习）或没有新题时回落到每日复习上限
  const revCap = (ratio > 0 && nw.length) ? Math.min(limitRev, ratio * nw.length) : limitRev;
  rev = rev.slice(0, revCap);
  if (set.order === 'new') return [...nw, ...rev];
  if (set.order === 'mix' && ratio > 0 && rev.length){
    const out = []; let i=0, j=0;
    while (i < nw.length || j < rev.length){
      for (let k=0;k<ratio && j<rev.length;k++) out.push(rev[j++]);
      if (i < nw.length) out.push(nw[i++]);
    }
    return out;
  }
  return [...rev, ...nw];   // 先复习
}

/* ───── 视图切换 ───── */
$$('#tabs button').forEach(b => b.onclick = () => {
  $$('#tabs button').forEach(x=>x.classList.remove('on')); b.classList.add('on');
  const v = b.dataset.v === 'wrong' ? 'review' : b.dataset.v;   // 错题复用复习视图
  $$('.view').forEach(x=>x.classList.remove('on')); $('#v-'+v).classList.add('on');
  const mode = b.dataset.v;
  if (mode==='review') renderReview('review');
  if (mode==='wrong') renderReview('wrong');
  if (mode==='map') renderMap();
  if (mode==='bank') renderBank();
  if (mode==='stats') renderStats();
  if (mode==='paper') renderPaperHist();
  if (mode==='set') fillSet();
});

/* ═════ 复习 ═════ */
const RV = { queue:[], i:0, mode:'review', graded:null };
function starBtn(id, cls){
  const on = !!S.star[id];
  return `<button class="starbtn ${on?'on':''} ${cls||''}" data-id="${id}" title="${on?'取消星标':'星标收藏（S 键）'}">★</button>`;
}
function toggleStar(id){
  if (S.star[id]) delete S.star[id]; else S.star[id] = Date.now()/1000;
  save();
  $$('.starbtn[data-id="'+id+'"]').forEach(b => b.classList.toggle('on', !!S.star[id]));
  toast(S.star[id] ? '已加入星标收藏' : '已取消星标');
}
function renderReview(mode){
  RV.mode = mode; RV.i = 0; RV.graded = null;
  const starOnly = !!$('#rvStar').checked;
  $('#rvTitle').textContent = mode==='wrong' ? '错题重练' : (starOnly ? '星标复习' : '今日复习');
  const st = S.settings;
  const orderTxt = st.order==='new' ? '先新题' : st.order==='mix' ? '交错' : '先复习';
  $('#rvHint').textContent = mode==='wrong'
    ? '错题本 · 评"不会"自动收录，连续评"清晰"2次移出'
    : starOnly ? `星标 ${Object.keys(S.star).length} 题 · 全量练习，不受每日额度限制`
    : `每日新题 ${st.dailyNew} · ${st.ratio ? `复习:新题 = ${st.ratio}:1` : `只复习不开新题`} · ${orderTxt}`;
  const t = $('#rvType').value, y = $('#rvYear').value;
  let queue;
  if (starOnly && mode !== 'wrong'){
    queue = QS.filter(q => S.star[q.id]).map(q => ({id:q.id, kind:'star'}));   // 星标全量练习
  } else {
    queue = buildQueue(mode);
  }
  RV.queue = queue.filter(it => {
    const q = QMAP[it.id]; if (!q) return false;
    if (t && q.type !== t) return false;
    if (y && q.year !== +y) return false;
    return true;
  });
  drawCard();
}
function drawCard(){
  const area = $('#rvArea');
  if (!RV.queue.length){
    area.innerHTML = `<div class="empty">🎉 这里没有题了<br><span class="hint">${RV.mode==='wrong'?'错题本是空的 —— 去复习或组卷练一练':'今天的新题与到期复习都做完了 —— 明天再来，或去「随机组卷」实战'}</span></div>`;
    return;
  }
  if (RV.i >= RV.queue.length){
    area.innerHTML = `<div class="empty">✅ 本轮完成！共 <b>${RV.queue.length}</b> 题<br><span class="hint">下次到期会按间隔自动出现（FSRS-lite）</span></div>`;
    badges(); return;
  }
  const it = RV.queue[RV.i], q = QMAP[it.id], now = Date.now()/1000;
  const card = S.cards[q.id] || {id:q.id, state:'new', s:0, d:5, reps:0, lapses:0, last:0};
  const pv = [1,2,3].map(g => preview(card, g, now));
  const pct = Math.round((RV.i + 1) / RV.queue.length * 100);
  area.innerHTML = `<div class="qc">
    <div class="qprog"><i style="width:${pct}%"></i></div>
    <div class="qm">
      <span class="tg y">${q.year} 年</span>
      <span class="tg t">${q.type}</span>
      <span class="tg">第 ${q.no} 题</span>
      <span class="tg">${q.score} 分</span>
      ${q.freq ? `<span class="tg hot">真题 ${q.freq} 次${q.freq_years? '（'+q.freq_years.replace(/,/g,' ')+'）':''}</span>` : ''}
      ${q.tags && q.tags.length ? `<span class="tg">${esc(q.tags[0])}</span>` : ''}
      <span class="tg">掌握 ${(mastery(q.id)*100).toFixed(0)}%</span>
      ${starBtn(q.id)}
    </div>
    <div class="qtitle">${esc(q.title)}</div>
    <div class="qsub">第 ${RV.i+1} / ${RV.queue.length} 题　·　先自己想，评级后显示答案与教材页码<span class="kbdhint">键盘 1/2/3 评级 · 空格下一题</span></div>
    <div class="rates" id="rateBox">
      <div class="rate g1" data-g="1"><b>不会</b><small>${fmtDays(pv[0])}后</small></div>
      <div class="rate g2" data-g="2"><b>模糊</b><small>${fmtDays(pv[1])}后</small></div>
      <div class="rate g3" data-g="3"><b>清晰</b><small>${fmtDays(pv[2])}后</small></div>
    </div>
    <div id="ansArea"></div>
  </div>`;
  $$('#rateBox .rate').forEach(r => r.onclick = () => grade(+r.dataset.g));
}
async function grade(g){
  if (RV.graded) return;
  const it = RV.queue[RV.i], q = QMAP[it.id], now = Date.now()/1000;
  const old = S.cards[q.id] || {id:q.id, state:'new', s:0, d:5, reps:0, lapses:0, last:0};
  const r = nextState(old, g, now);
  RV.prevCard = old; RV.graded = g;
  S.cards[q.id] = Object.assign({}, old, r.card, {first: old.first || now});
  S.reviews.push({id:q.id, ts:now, grade:g, mode:RV.mode});
  applyWrong(q.id, g, now);
  save(); badges();
  $$('#rateBox .rate').forEach(x => { x.classList.add('locked'); x.classList.toggle('chosen', +x.dataset.g === g); });
  const pages = (q.pages || []).slice(0, 4);
  $('#ansArea').innerHTML = `<div class="ansbox"><div class="ans-label">答案要点</div><div class="ans-text">${fmt(q.answer)}</div></div>
    ${pages.length ? `<div class="pgrow"><span class="hint">教材原文</span>${pages.map(p => `<button class="pgchip" data-pg="${p}">P${p}</button>`).join('')}<button class="btn primary sm" id="viewMain">查看课本原页</button></div>` : ''}
    <div class="notearea" id="noteArea"></div>
    <div class="regrade"><span class="hint">已评「${GL[g]}」，看答案后如与实际不符可改判：</span>
      <div class="rbtns"><button class="g1" data-g="1">不会</button><button class="g2" data-g="2">模糊</button><button class="g3" data-g="3">清晰</button></div>
      <button class="btn primary" id="nextQ">下一题 →</button>
    </div>`;
  $$('#ansArea .pgchip').forEach(b => b.onclick = () => openViewer(+b.dataset.pg, q.id));
  const vm = $('#viewMain'); if (vm) vm.onclick = () => openViewer(pages[0], q.id);
  $$('#ansArea .regrade button[data-g]').forEach(b => b.onclick = () => regrade(+b.dataset.g));
  $('#nextQ').onclick = nextCard;
  renderNote($('#noteArea'), q.id);
  setTimeout(() => { const a = $('#ansArea'); if (a) a.scrollIntoView({behavior:'smooth', block:'nearest'}); }, 30);
}

/* ═════ 个人笔记（每题一句：口诀/易错点） ═════ */
function renderNote(box, id){
  if (!box) return;
  const n = S.notes[id];
  box.innerHTML = (n && n.t)
    ? `<div class="noteshow"><span class="ns-label">我的笔记</span><div class="ns-text">${esc(n.t)}</div>
       <button class="btn ghost sm ns-edit">编辑</button></div>`
    : `<button class="btn ghost sm notebtn">✎ 记一笔（口诀 / 易错点）</button>`;
  const open = () => {
    box.innerHTML = `<div class="noteedit">
        <textarea id="noteTa" rows="3" maxlength="500" placeholder="一句话笔记：口诀、易错点、自己的理解…">${esc((S.notes[id]||{}).t || '')}</textarea>
        <div class="row"><button class="btn primary sm" id="noteSave">保存</button>
        <button class="btn ghost sm" id="noteCancel">取消</button></div></div>`;
    const ta = $('#noteTa');
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    $('#noteSave').onclick = () => {
      const t = ta.value.trim();
      if (t) S.notes[id] = {t, ts: Date.now()/1000}; else delete S.notes[id];
      save(); toast(t ? '笔记已保存' : '笔记已清除'); renderNote(box, id);
    };
    $('#noteCancel').onclick = () => renderNote(box, id);
  };
  const btn = box.querySelector('.notebtn'); if (btn) btn.onclick = open;
  const ed = box.querySelector('.ns-edit'); if (ed) ed.onclick = open;
}
function nextCard(){ RV.i++; RV.graded = null; RV.prevCard = null; drawCard(); }
function applyWrong(id, g, now){
  const w = S.wrong[id];
  if (g === 1){
    const e = w || {added:now, n_wrong:0, n_clear:0, cleared:null};
    e.n_wrong = (e.n_wrong || 0) + 1; e.cleared = null; e.added = now; S.wrong[id] = e;
  } else if (w && !w.cleared){
    w.n_clear = (w.n_clear || 0) + 1;
    if (w.n_clear >= (S.settings.autoClearWrong || 2)) w.cleared = now;
  }
}
function regrade(g){
  if (!RV.graded || !RV.prevCard || g === RV.graded) return;
  const it = RV.queue[RV.i], q = QMAP[it.id], now = Date.now()/1000;
  const prevG = RV.graded;
  const r = nextState(RV.prevCard, g, now);
  S.cards[q.id] = Object.assign({}, RV.prevCard, r.card);
  const last = S.reviews[S.reviews.length-1];
  if (last && last.id === q.id) last.grade = g;
  if (prevG === 1 && g !== 1){
    const w = S.wrong[q.id];
    if (w){ w.n_wrong = Math.max(0, (w.n_wrong || 1) - 1); if (!w.n_wrong) delete S.wrong[q.id]; }
  } else if (prevG !== 1 && g === 1){
    applyWrong(q.id, 1, now);
  } else if (g === 3){
    applyWrong(q.id, 3, now);
  }
  save(); badges();
  toast(`已改判为「${GL[g]}」，下次 ${fmtDays(r.days)}后`);
  nextCard();
}
$('#rvType').onchange = () => renderReview(RV.mode);
$('#rvYear').onchange = () => renderReview(RV.mode);
$('#rvHighFirst').onchange = e => { S.settings.highFirst = e.target.checked; save(); renderReview(RV.mode); };
$('#rvShuffle').onclick = () => { RV.queue.sort(()=>Math.random()-0.5); RV.i=0; RV.graded=null; drawCard(); };

/* 键盘：1/2/3 评级，空格/→ 下一题；输入框内不拦截 */
document.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if ($('#viewer')?.classList.contains('on')){
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowLeft') viewerStep(-1);
    if (e.key === 'ArrowRight') viewerStep(1);
    return;
  }
  if (e.key === '?' || (e.shiftKey && e.key === '/')){ openHelp(); return; }
  if (e.key === 'Escape'){ $('#modal').classList.remove('on'); return; }
  if (!$('#v-review').classList.contains('on')) return;
  if ((e.key === 's' || e.key === 'S') && RV.queue[RV.i]){ toggleStar(RV.queue[RV.i].id); return; }
  if (e.key === '1' || e.key === '2' || e.key === '3'){ if (!RV.graded) grade(+e.key); return; }
  if (e.key === 'f' || e.key === 'F'){
    if (RV.graded){ const pgs = (QMAP[RV.queue[RV.i].id]||{}).pages; if (pgs && pgs.length) openViewer(+pgs[0], RV.queue[RV.i].id); }
    return;
  }
  if ((e.key === ' ' || e.key === 'ArrowRight') && RV.graded){ e.preventDefault(); nextCard(); }
});

/* ═════ 组卷 ═════ */
function makePaper(){
  const years = $$('#paperYears input:checked').map(x=>+x.value);
  const quota = {'名词解释':+$('#pq1').value,'问答题':+$('#pq2').value,'计算题':+$('#pq3').value};
  const scores = {'名词解释':+$('#ps1').value,'问答题':+$('#ps2').value,'计算题':+$('#ps3').value};
  const highFirst = $('#pHigh').checked, avoid = $('#pAvoid').checked;
  const gate = !!($('#pGate') && $('#pGate').checked);   // 闸控：排除掌握度 ≥ GATE_T 的题
  const pool = QS.filter(q => years.includes(q.year));
  const picked = [], used = new Set(), seenTitles = new Set(), seenTags = new Set();
  const tkey = q => (q.title || '').replace(/[\s，。、；：？！“”‘’（）()【】\[\]]/g, '').replace(/[与和及]/g, '').slice(0, 40);
  for (const [typ, n] of Object.entries(quota)){
    if (!n) continue;
    let cand = pool.filter(q => q.type === typ && !used.has(q.id) && !seenTitles.has(tkey(q)));
    if (gate){
      const kept = cand.filter(q => mastery(q.id) < GATE_T);
      if (kept.length >= Math.min(n, 3)) cand = kept;    // 闸控池足够才启用，否则自动放宽
    }
    const byYear = {}; cand.forEach(q => (byYear[q.year] = byYear[q.year]||[]).push(q));
    Object.values(byYear).forEach(v => v.sort(()=>Math.random()-0.5));
    const order = []; let i = 0;
    while (order.length < cand.length){
      let added = false;
      for (const y of Object.keys(byYear).sort()){
        if (i < byYear[y].length){ order.push(byYear[y][i]); added = true; }
      }
      if (!added) break; i++;
    }
    if (avoid) order.sort((a,b)=> (mastery(a.id)-mastery(b.id)) || (b.freq-a.freq));
    const take = q => { seenTitles.add(tkey(q)); used.add(q.id); picked.push(q); (q.tags||[]).forEach(t=>seenTags.add(t)); };
    // 第一轮：考点去重（真题跨年重复考点只抽一题）
    for (const q of order){
      if (picked.filter(x => x.type === typ).length >= n) break;
      if (seenTitles.has(tkey(q))) continue;
      if ((q.tags||[]).length && q.tags.some(t => seenTags.has(t))) continue;
      take(q);
    }
    // 第二轮：考点池不足时放宽，允许不同年份同考点题补足配额
    for (const q of order){
      if (picked.filter(x => x.type === typ).length >= n) break;
      if (seenTitles.has(tkey(q))) continue;
      take(q);
    }
  }
  const ord = {'名词解释':0,'问答题':1,'计算题':2};
  picked.sort((a,b)=> (ord[a.type]-ord[b.type]) || (highFirst ? (b.freq-a.freq) : (a.year-b.year)));
  const total = picked.reduce((s,q)=> s + (scores[q.type] ?? q.score), 0);
  const dur = +$('#pDur').value;
  const paper = { pid:'P'+Date.now().toString(36), title:'随机组卷 '+new Date().toLocaleDateString('zh-CN'),
                 items:picked.map(q=>({id:q.id,type:q.type,year:q.year,no:q.no,title:q.title,score:scores[q.type] ?? q.score,
                                        pages:q.pages,freq:q.freq||0,tags:q.tags||[]})), total, duration:dur, ts:Date.now() };
  PR = {};                                  // 新卷重置评分记录
  S.papers.unshift(paper); S.papers = S.papers.slice(0,30); save();
  $('#pMsg').textContent = `已生成 ${picked.length} 题 / ${total} 分`;
  $('#pPrint').disabled = false;
  drawSheet(paper);
}
$('#pMake').onclick = makePaper;
$('#pPrint').onclick = () => window.print();
function drawSheet(p){
  const byType = {}; p.items.forEach(it => (byType[it.type] = byType[it.type]||[]).push(it));
  let html = `<div class="sheet" id="sheet"><h1>东华大学 833 纺织材料学 模拟卷</h1>
    <div class="sm">${esc(p.title)}　·　${p.items.length} 题 / ${p.total} 分　·　限时 ${p.duration} 分钟
      <span class="tmr" id="tmr">00:00</span></div>
    <div class="sm" style="border:0;padding-top:0">姓名：____________　学号：____________　班级：____________　得分：____________</div>`;
  for (const t of ['名词解释','问答题','计算题']){
    if (!byType[t]) continue;
    html += `<h2>${t}（${byType[t].length} 题 / ${byType[t].reduce((a,b)=>a+b.score,0)} 分）</h2>`;
    byType[t].forEach((it,i)=>{
      html += `<div class="it" data-id="${it.id}"><div><span class="no">${i+1}.</span> ${esc(it.title)} <span class="sc">（${it.score} 分）</span></div>
        <div class="ansbox2"></div>
        <div class="rate2"><button class="ok" data-g="3">✓ 会</button><button class="fz" data-g="2">~ 模糊</button><button class="bd" data-g="1">✗ 不会</button></div></div>`;
    });
  }
  html += `<div class="seal">密封线以内不要答题　·　本卷由 833 复习站随机组卷生成　·　${new Date().toLocaleString('zh-CN')}</div></div>`;
  $('#paperArea').innerHTML = html;
  $$('#paperArea .rate2 button').forEach(b => b.onclick = async () => {
    const box = b.closest('.it'), g = +b.dataset.g, id = box.dataset.id;
    box.querySelector('.rate2').innerHTML = `<span class="hint">已评：${GL[g]}</span>`;
    PR[id] = g;
    const now = Date.now()/1000, old = S.cards[id] || {id, state:'new', s:0, d:5, reps:0, lapses:0, last:0};
    const r = nextState(old, g, now);
    S.cards[id] = Object.assign({}, old, r.card, {first: old.first || now});
    S.reviews.push({id, ts:now, grade:g, mode:'paper'});
    if (g === 1){ const w = S.wrong[id] || {added:now, n_wrong:0, n_clear:0, cleared:null}; w.n_wrong++; w.cleared=null; S.wrong[id]=w; }
    save(); badges();
    finishPaper(p);                          // 全部评完即出报告
  });
  startTimer();
}
/* ═════ 交卷报告与试卷历史（DeepTutor grouped assessments 理念） ═════ */
let PR = {};                                  // pid → 题目评分记录 {qid: grade}
function finishPaper(p){
  const items = p.items || [];
  if (!items.length || items.some(it => PR[it.id] == null)) return;   // 尚未评完
  const got = items.reduce((s,it)=> s + it.score*(PR[it.id]===3?1:PR[it.id]===2?0.5:0), 0);
  const byType = {}, byYear = {}, byTag = {};
  let nOk = 0, nFz = 0, nBad = 0;
  for (const it of items){
    const g = PR[it.id];
    if (g === 3) nOk++; else if (g === 2) nFz++; else nBad++;
    const b = byType[it.type] = byType[it.type] || {t:0, ok:0, fz:0, bad:0, got:0, full:0};
    b.t++; if (g === 3) b.ok++; else if (g === 2) b.fz++; else b.bad++;
    b.got += it.score * (g === 3 ? 1 : g === 2 ? 0.5 : 0); b.full += it.score;
    const y = byYear[it.year] = byYear[it.year] || {t:0, ok:0};
    y.t++; if (g === 3) y.ok++;
    for (const t of (it.tags && it.tags.length ? it.tags.slice(0,3) : ['（未标注考点）'])){
      const tb = byTag[t] = byTag[t] || {t:0, bad:0, fz:0, ok:0, freq:0};
      tb.t++; if (g === 1) tb.bad++; else if (g === 2) tb.fz++; else tb.ok++;
      tb.freq = Math.max(tb.freq, it.freq || 0);
    }
  }
  const weak = Object.entries(byTag).filter(([,b]) => b.bad + b.fz > 0)
    .sort((a,b) => (b[1].bad*2 + b[1].fz) - (a[1].bad*2 + a[1].fz) || b[1].freq - a[1].freq)
    .slice(0, 8)
    .map(([tag,b]) => ({tag, bad:b.bad, fz:b.fz, freq:b.freq}));
  p.summary = {got: Math.round(got), full: p.total, nOk, nFz, nBad, byType, byYear, weak, ts: Date.now()};
  save();
  showReport(p, true);
}
function showReport(p, withBtns){
  const s = p.summary; if (!s) return;
  const el = $('#paperReport'); if (el) el.remove();
  $('#paperArea').insertAdjacentHTML('beforeend', `
  <div class="report" id="paperReport">
    <h3>交卷报告 <span class="hint">${esc(p.title || '')}</span></h3>
    <div class="rmeta">
      <span class="rtag">预估 <b>${s.got}</b> / ${s.full} 分</span>
      <span class="rtag" style="color:#a9f0d6">清晰 <b>${s.nOk}</b></span>
      <span class="rtag" style="color:#ffd9a0">模糊 <b>${s.nFz}</b></span>
      <span class="rtag" style="color:#ffb0b0">不会 <b>${s.nBad}</b></span>
    </div>
    <div class="rsec">分题型</div>
    <div>${Object.entries(s.byType).map(([t,b]) =>
      `<span class="rtag">${t} <b>${Math.round(b.got)}/${b.full}</b> · 清晰${b.ok} 模糊${b.fz} 不会${b.bad}</span>`).join('')}</div>
    <div class="rsec">薄弱考点（按错误权重排序，优先重练）</div>
    <div>${s.weak.length ? s.weak.map(w =>
      `<span class="rtag weak">${esc(w.tag)} · 不会${w.bad}/模糊${w.fz}${w.freq ? ` · 真题${w.freq}次` : ''}</span>`).join('')
      : '<span class="hint">本卷没有薄弱考点，继续保持 ✓</span>'}</div>
    <div class="rsec">分年份</div>
    <div>${Object.entries(s.byYear).map(([y,b]) =>
      `<span class="rtag">${y} 年 清晰 <b>${b.ok}</b>/${b.t}</span>`).join('')}</div>
    ${withBtns ? `<div class="row" style="margin-top:14px">
      <button class="btn primary" id="repWrong">去错题本重练 →</button>
      <button class="btn ghost" id="repRedo">重做本卷</button>
    </div>` : ''}
  </div>`);
  if (withBtns){
    $('#repWrong').onclick = () => { const b = $$('#tabs button').find(x => x.dataset.v === 'wrong'); if (b) b.click(); };
    $('#repRedo').onclick = () => { PR = {}; drawSheet(p); window.scrollTo({top:0, behavior:'smooth'}); };
  }
}
function renderPaperHist(){
  const card = $('#phistCard'); if (!card) return;
  const ps = S.papers || [];
  card.style.display = ps.length ? '' : 'none';
  $('#phistList').innerHTML = ps.map(p => `
    <div class="phitem" data-pid="${p.pid}">
      <span class="pht">${esc(p.title || '随机组卷')}</span>
      <span class="phm">${(p.items || []).length} 题 / ${p.total || 0} 分</span>
      ${p.summary ? `<span class="phm">预估 <b style="color:var(--acc2)">${p.summary.got}</b>/${p.summary.full} 分</span>` : '<span class="phm">未评完</span>'}
      <span class="phm">${new Date(p.ts).toLocaleString('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'})}</span>
    </div>`).join('');
  $$('#phistList .phitem').forEach(el => el.onclick = () => {
    const p = S.papers.find(x => x.pid === el.dataset.pid); if (!p) return;
    PR = {}; drawSheet(p);
    if (p.summary) showReport(p, false);
    $('#paperArea').scrollIntoView({behavior:'smooth', block:'start'});
  });
}
function startTimer(){
  let sec = 0; clearInterval(window.__tmr);
  window.__tmr = setInterval(()=>{ sec++; $('#tmr').textContent = String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0'); }, 1000);
}

/* ═════ 导图（自绘 SVG 树 + 掌握度染色） ═════ */
let mapState = { key:null, collapsed:new Set((()=>{ try{ return JSON.parse(localStorage.getItem('833mapCollapse')||'[]'); }catch(e){ return []; } })()), zoom:1 };
function saveCollapse(){ try{ localStorage.setItem('833mapCollapse', JSON.stringify([...mapState.collapsed])); }catch(e){} }
function nodeMastery(n){
  const ids = collectQuestions(n);
  if (!ids.length) return null;
  return ids.reduce((s,id) => s + mastery(id), 0) / ids.length;
}
function renderMap(){
  const tabs = $('#mapTabs');
  if (!tabs.dataset.done){
    tabs.innerHTML = MAPS.map(m => `<button data-k="${m.id}" class="${m.title.startsWith('绪论')?'on':''}">${esc(m.title.replace('部分','').replace('知识导图',''))}</button>`).join('');
    tabs.dataset.done = '1';
    $$('#mapTabs button').forEach(b => b.onclick = () => {
      $$('#mapTabs button').forEach(x=>x.classList.remove('on')); b.classList.add('on');
      mapState.key = b.dataset.k; mapState.collapsed = new Set(); saveCollapse(); drawMap();
    });
  }
  if (!mapState.key) mapState.key = (MAPS.find(m=>m.title.startsWith('绪论'))||MAPS[0]).id;
  drawMap();
}
$('#mapIn').onclick = () => { mapState.zoom = Math.min(1.8, (mapState.zoom||1)+0.15); drawMap(); };
$('#mapOut').onclick = () => { mapState.zoom = Math.max(0.5, (mapState.zoom||1)-0.15); drawMap(); };
$('#mapFit').onclick = () => { mapState.zoom = 1; drawMap(); };
let __rz;
window.addEventListener('resize', () => { clearTimeout(__rz); __rz = setTimeout(() => { if ($('#v-map').classList.contains('on')) renderMap(); }, 180); });
function drawMap(){
  const m = MAPS.find(x => x.id === mapState.key); if (!m) return;
  if (window.innerWidth <= 760){ renderOutline(m); return; }
  const NODE_W = 210, NODE_H = 32, GAP_Y = 10, GAP_X = 66, PAD = 26;
  const isFolded = n => mapState.collapsed.has((n.parentId||'') + '/' + n.id);   // 与点击存储同表达式
  const measure = n => {
    const kids = isFolded(n) ? [] : (n.children||[]);
    if (!kids.length) return { w: NODE_W, h: NODE_H };
    const ms = kids.map(measure);
    const h = ms.reduce((s,x)=>s+x.h,0) + GAP_Y*(kids.length-1);
    return { w: NODE_W + GAP_X + Math.max(...ms.map(x=>x.w)), h: h };
  };
  const place = (n, x, yTop) => {
    n._x = x; n._y = yTop;
    const kids = isFolded(n) ? [] : (n.children||[]);
    if (!kids.length) return;
    const ms = kids.map(c => measure(c));
    let y = yTop;
    kids.forEach((c,i) => { place(c, x + NODE_W + GAP_X, y); y += ms[i].h + GAP_Y; });
  };
  const M = measure(m); place(m, PAD, PAD);
  const H = M.h + PAD*2, W = M.w + PAD*2;
  const nodes = []; (function collect(n){ nodes.push(n); if (isFolded(n)) return; (n.children||[]).forEach(collect); })(m);
  const links = [];
  (function link(n){ if (isFolded(n)) return; (n.children||[]).forEach(c => { links.push([n,c]); link(c); }); })(m);
  const color = g => ({'绪论':'#8b7cff','纤维':'#4da3ff','纱线':'#38d69c','织物':'#ffb454','工艺':'#ff6b6b'}[g] || '#4da3ff');
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  links.forEach(([a,b]) => {
    const x1 = a._x + NODE_W, y1 = a._y + NODE_H/2, x2 = b._x, y2 = b._y + NODE_H/2;
    svg += `<path d="M${x1},${y1} C${x1+32},${y1} ${x2-32},${y2} ${x2},${y2}" fill="none" stroke="var(--line2)" stroke-width="1.4"/>`;
  });
  nodes.forEach(n => {
    const c = color(n.group);
    const hasKids = (n.children||[]).length > 0;
    const open = !mapState.collapsed.has(n.id);
    const isRoot = !n.parent && !n.parentId;
    const label = n.title.length > 13 ? n.title.slice(0,12)+'…' : n.title;
    const mm = nodeMastery(n);                       // 关联真题平均掌握度 → 描边染色（OpenMAIC 交互引导理念）
    const stroke = mm == null ? c : masteryColor(mm);
    const sw = isRoot ? 0 : (mm == null ? 1.3 : 2);
    svg += `<g class="mt" data-id="${n.id}" transform="translate(${n._x},${n._y})"><title>${esc(n.title)}${mm != null ? ' · 掌握 ' + Math.round(mm*100) + '%' : ''}</title>
      <rect width="${NODE_W}" height="${NODE_H}" rx="9" fill="${isRoot? c : 'var(--bg2)'}" stroke="${stroke}" stroke-width="${sw}"/>
      <text class="${isRoot?'sec':''}" x="12" y="${NODE_H/2}">${esc(label)}</text>
      ${hasKids ? `<circle cx="${NODE_W-13}" cy="${NODE_H/2}" r="8" fill="${c}" opacity=".9"/><text x="${NODE_W-13}" y="${NODE_H/2+1}" text-anchor="middle" font-size="10" fill="#08111c" font-weight="700">${open?'−':'+'}</text>` : ''}
      ${n.questions && n.questions.length ? `<text class="cnt" x="${NODE_W-30}" y="${NODE_H/2}" text-anchor="end">${n.questions.length}题</text>` : ''}
    </g>`;
  });
  svg += '</svg>';
  const z = mapState.zoom || 1;
  $('#mapSvg').innerHTML = `<div class="svgbox" style="width:${W*z}px;height:${H*z}px"><div style="transform:scale(${z});transform-origin:0 0;width:${W}px;height:${H}px">${svg}</div></div>`;
  $('#mapZoomTxt').textContent = Math.round(z*100)+'%';
  $$('#mapSvg .mt').forEach(g => {
    g.onclick = ev => {
      const id = g.dataset.id;
      const n = findNode(MAPS.find(x=>x.id===mapState.key), id);
      if (n && (n.children||[]).length && ev.target.tagName === 'circle'){
        const k = (n.parentId||'') + '/' + id;
        mapState.collapsed.has(k) ? mapState.collapsed.delete(k) : mapState.collapsed.add(k);
        saveCollapse(); drawMap(); return;
      }
      if (n) openDrawer(n);
    };
  });
}
function renderOutline(m){
  const rows = [];
  (function walk(n, d){
    const qn = collectQuestions(n).length;
    const mm = nodeMastery(n);
    rows.push(`<button class="olrow" data-id="${n.id}" style="--d:${Math.min(d,6)}"><i class="oldot" style="background:${mm == null ? 'var(--line2)' : masteryColor(mm)}"></i><span class="olt">${esc(n.title)}</span>${qn ? `<i class="olq">${qn}</i>` : ''}</button>`);
    (n.children||[]).forEach(c => walk(c, d+1));
  })(m, 0);
  $('#mapSvg').innerHTML = `<div class="outline">${rows.join('')}</div>`;
  $$('#mapSvg .olrow').forEach(b => b.onclick = () => {
    const n = findNode(m, b.dataset.id); if (!n) return;
    openDrawer(n);
    $('#mapDrawer').classList.add('on');
    if (window.innerWidth <= 900) $('#mapDrawer').scrollIntoView({behavior:'smooth', block:'start'});
  });
}
function findNode(root, id){ if (root.id === id) return root; for (const c of (root.children||[])){ const r = findNode(c, id); if (r) return r; } return null; }
function collectQuestions(n){
  const ids = [...(n.questions||[])];
  (n.children||[]).forEach(c => ids.push(...collectQuestions(c)));
  return [...new Set(ids)];
}
function openDrawer(n){
  const d = $('#mapDrawer');
  const ids = collectQuestions(n);
  const own = new Set(n.questions||[]);
  const qs = ids.map(id => QMAP[id]).filter(Boolean).sort((a,b)=> b.freq-a.freq);
  const pages = String(n.page||'').split('/').filter(Boolean).map(p=>p.replace(/^P/,''));
  d.innerHTML = `<div class="dh">${esc(n.title)}</div>
    <div class="dm">${esc(n.group||'')} · 真题 ${qs.length} 道${pages.length ? ` · 教材 ${pages.map(p=>'P'+p).join(' ')}` : ''}</div>
    ${pages.length ? `<div class="pgrow">${pages.map(p=>`<button class="pgchip" data-pg="${p}">课本 P${p}</button>`).join('')}</div>` : ''}
    ${n.text ? `<div class="dpoints"><b>分支要点</b>${esc(n.text)}</div>` : ''}
    <div class="dsec">真题（题目 + 答案）${ids.length > own.size ? '<span class="hint">含子分支</span>' : ''}</div>
    <div id="dqs">${qs.length ? qs.map(q => `
      <div class="qitem" data-id="${q.id}">
        <div class="qmeta">
          <span class="tg y">${q.year}</span><span class="tg t">${q.type}</span>
          ${q.freq?`<span class="tg hot">${q.freq}次</span>`:''}
          ${q.pages&&q.pages.length?`<button class="pglink" data-pg="${q.pages[0]}" data-qid="${q.id}">课本 P${q.pages[0]}</button>`:''}
        </div>
        <div class="qt">${esc(q.title)}</div>
        <div class="qa">${fmt(q.answer)}</div>
      </div>`).join('') : '<div class="hint">该分支暂无匹配真题</div>'}</div>`;
  $$('#mapDrawer .pglink').forEach(a => a.onclick = ev => { ev.stopPropagation(); openViewer(+a.dataset.pg, a.dataset.qid); });
  $$('#mapDrawer .pgchip').forEach(b => b.onclick = () => openViewer(+b.dataset.pg));
  $$('#dqs .qitem').forEach(b => b.onclick = ev => { if (ev.target.classList.contains('pglink')) return; openModal(b.dataset.id); });
}
/* ═════ 课本原页查看器（图片预渲染，不再依赖 file:///） ═════ */
const VSTATE = { pages:[], idx:-1, qid:null, zoom:false };
function pageList(){
  return (PAGES && PAGES.pages) ? Object.keys(PAGES.pages).map(Number).sort((a,b)=>a-b) : [];
}
function openViewer(printPage, qid){
  if (!PAGES || !PAGES.pages || !PAGES.pages[printPage]){
    toast('该页未缓存：运行 build_pages.py 生成教材页'); return;
  }
  VSTATE.qid = qid || null;
  VSTATE.pages = pageList();
  VSTATE.idx = VSTATE.pages.indexOf(+printPage);
  VSTATE.zoom = false;
  const v = $('#viewer');
  v.classList.add('on'); v.setAttribute('aria-hidden','false');
  document.body.style.overflow = 'hidden';
  renderViewer();
}
function closeViewer(){
  const v = $('#viewer');
  v.classList.remove('on'); v.setAttribute('aria-hidden','true');
  document.body.style.overflow = '';
}
function viewerStep(d){
  if (!VSTATE.pages.length) return;
  const i = Math.min(VSTATE.pages.length-1, Math.max(0, VSTATE.idx + d));
  if (i === VSTATE.idx) return;
  VSTATE.idx = i; renderViewer();
}
function renderViewer(){
  const p = VSTATE.pages[VSTATE.idx], e = PAGES.pages[p];
  if (!e) return;
  $('#vTitle').textContent = `P${p} · 教材原页`;
  $('#vPage').value = p;
  $('#vPrev').disabled = VSTATE.idx <= 0;
  $('#vNext').disabled = VSTATE.idx >= VSTATE.pages.length-1;
  const wrap = $('#vWrap');
  wrap.style.width = VSTATE.zoom ? '220%' : '100%';
  const hl = (e.hl && VSTATE.qid && e.hl[VSTATE.qid]) || [];
  const img = $('#vImg');
  img.onload = () => {
    if (!hl.length) return;
    const body = $('#vBody');
    body.scrollTop = Math.max(0, hl[0][1] * img.clientHeight - body.clientHeight / 3);
  };
  img.src = PAGES.base + e.f;
  $('#vHl').innerHTML = hl.map(r => `<i style="left:${r[0]*100}%;top:${r[1]*100}%;width:${r[2]*100}%;height:${r[3]*100}%"></i>`).join('');
  $('#vHint').textContent = hl.length ? `已高亮 ${hl.length} 处本题考点` : '未定位到高亮，请对照原文';
}

/* ═════ 题库 ═════ */
function renderBank(){
  const y = $('#bkYear').value, t = $('#bkType').value, k = $('#bkKw').value.trim();
  const sort = $('#bkSort').value;
  const onlyStar = !!$('#bkStar').checked;
  let list = QS.filter(q => (!y || q.year === +y) && (!t || q.type === t) && (!k || q.title.includes(k) || q.answer.includes(k)));
  if (onlyStar) list = list.filter(q => S.star[q.id]);
  if (sort === 'freq') list = list.slice().sort((a,b)=> b.freq-a.freq || b.year-a.year);
  else if (sort === 'year') list = list.slice().sort((a,b)=> b.year-a.year || a.no-b.no);
  else list = list.slice().sort((a,b)=> TYPES.indexOf(a.type)-TYPES.indexOf(b.type) || b.year-a.year);
  $('#bankCnt').textContent = `${list.length} 题${onlyStar ? '（星标）' : ''}`;
  $('#bankList').innerHTML = list.slice(0,300).map(q => `
    <div class="bi" data-id="${q.id}">
      <div class="qm">
        <span class="tg y">${q.year}</span><span class="tg t">${q.type}</span><span class="tg">第${q.no}题</span>
        ${q.freq?`<span class="tg hot">真题${q.freq}次</span>`:''}
        <span class="tg">掌握 <span class="mbar"><i style="width:${Math.round(mastery(q.id)*100)}%"></i></span> ${Math.round(mastery(q.id)*100)}%</span>
        ${starBtn(q.id)}
        ${S.notes[q.id] ? '<span class="tg noteg">有笔记</span>' : ''}
      </div>
      <div class="bt">${esc(q.title)}</div>
    </div>`).join('') || `<div class="empty">${onlyStar ? '还没有星标题目 —— 在复习或题库里点 ★ 收藏' : '没有匹配题目'}</div>`;
  $$('#bankList .bi').forEach(b => b.onclick = () => openModal(b.dataset.id));
}
['#bkYear','#bkType','#bkSort'].forEach(s => $(s).onchange = renderBank);
$('#bkStar').onchange = renderBank;
let kwT; $('#bkKw').oninput = () => { clearTimeout(kwT); kwT = setTimeout(renderBank, 240); };

async function openModal(id){
  const q = QMAP[id]; if (!q) return;
  $('#mBody').innerHTML = `<div class="qm">
      <span class="tg y">${q.year} 年</span><span class="tg t">${q.type}</span><span class="tg">第${q.no}题</span>
      <span class="tg">${q.score} 分</span>${q.freq?`<span class="tg hot">真题${q.freq}次${q.freq_years?'（'+q.freq_years+'）':''}</span>`:''}
      ${q.pages&&q.pages.length?`<button class="pglink" data-pg="${q.pages[0]}" data-qid="${q.id}">课本 P${q.pages[0]}</button>`:''}
      ${starBtn(id)}
    </div>
    <div class="qtitle">${esc(q.title)}</div>
    <div class="ansbox">${fmt(q.answer)}</div>
    <div class="notearea" id="mNote"></div>`;
  $('#modal').classList.add('on');
  const a = $('#mBody .pglink'); if (a) a.onclick = e => { e.stopPropagation(); openViewer(+a.dataset.pg, a.dataset.qid); };
  renderNote($('#mNote'), id);
}
/* 星标全局委托：任何动态渲染的 .starbtn 都能点 */
document.addEventListener('click', ev => {
  const b = ev.target.closest('.starbtn');
  if (b){ ev.stopPropagation(); toggleStar(b.dataset.id); }
});
$('#rvStar').onchange = () => renderReview(RV.mode);
$('.m-x').onclick = ()=>$('#modal').classList.remove('on');
$('.m-bg').onclick = ()=>$('#modal').classList.remove('on');

/* 查看器交互 */
$('#vClose').onclick = closeViewer;
$$('.v-bg').forEach(b => b.onclick = closeViewer);
$('#vPrev').onclick = () => viewerStep(-1);
$('#vNext').onclick = () => viewerStep(1);
$('#vZoom').onclick = () => { VSTATE.zoom = !VSTATE.zoom; renderViewer(); };
$('#vGo').onclick = () => {
  const p = +$('#vPage').value;
  if (PAGES && PAGES.pages && PAGES.pages[p]){ VSTATE.idx = pageList().indexOf(p); renderViewer(); }
  else toast('该页未缓存，仅收录真题引用的页面');
};
$('#vPage').onkeydown = e => { if (e.key === 'Enter') $('#vGo').click(); };

/* ═════ 统计 · 学习日志（DeepTutor Learning Journal 理念） ═════ */
function dayKey(tsMs){ const d = new Date(tsMs); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function renderStats(){
  const byYear = {}; META.years.forEach(y => byYear[y] = {t:0, ok:0});
  S.reviews.forEach(r => { const q = QMAP[r.id]; if (!q) return; byYear[q.year].t++; if (r.grade === 3) byYear[q.year].ok++; });
  const dayAgg = {};                                   // 日期 → {n, ok, new}
  S.reviews.forEach(r => {
    const k = dayKey(r.ts*1000);
    const a = dayAgg[k] = dayAgg[k] || {n:0, ok:0, nw:0};
    a.n++; if (r.grade === 3) a.ok++;
  });
  Object.values(S.cards).forEach(c => { if (c.first){ const k = dayKey(c.first*1000); if (dayAgg[k]) dayAgg[k].nw++; } });
  const days = new Set(Object.keys(dayAgg));
  let streak = 0, cur = dayKey(Date.now());
  while (days.has(cur)){ streak++; const dt = new Date(cur + 'T00:00:00'); dt.setDate(dt.getDate()-1); cur = dayKey(dt.getTime()); }
  const dueN = dueCards().length, wrongN = Object.values(S.wrong).filter(w=>!w.cleared).length;
  const mstats = { '0':0,'1':0,'2':0,'3':0,'4':0,'5':0 };
  Object.values(S.cards).forEach(c => mstats[Math.min(5, Math.floor(mastery(c.id)*5))]++);

  /* 26 周热力图（GitHub contribution 风格，按周列 × 星期行） */
  const DAY = 86400000, today = new Date(); today.setHours(0,0,0,0);
  const start = new Date(today.getTime() - (175 + today.getDay()) * DAY);   // 对齐到 26 周前的周日
  const maxN = Math.max(1, ...Object.values(dayAgg).map(a => a.n));
  let heat = '';
  for (let w = 0; w < 26; w++) for (let d = 0; d < 7; d++){
    const t = start.getTime() + (w*7 + d) * DAY;
    if (t > today.getTime() + DAY - 1) continue;
    const a = dayAgg[dayKey(t)];
    const lv = !a ? 0 : a.n >= Math.ceil(maxN*0.75) ? 4 : a.n >= Math.ceil(maxN*0.5) ? 3 : a.n >= Math.ceil(maxN*0.25) ? 2 : 1;
    const dtxt = dayKey(t).slice(5);
    heat += `<i class="${lv ? 'h'+Math.min(4,lv) : ''}" title="${dtxt} · ${a ? a.n+' 题（清晰 '+a.ok+'）' : '未学习'}"></i>`;
  }
  /* 未来 7 天到期负载 */
  const now = Date.now()/1000;
  const fut = Array.from({length:7}, () => 0);
  Object.values(S.cards).forEach(c => {
    if (!c.due) return;
    const dd = Math.floor((c.due - now) / 86400);
    if (dd < 0) return;
    fut[Math.min(6, dd)]++;
  });
  const maxFut = Math.max(1, ...fut);
  const dow = ['日','一','二','三','四','五','六'];
  const futRows = fut.map((n,i) => {
    const label = i === 0 ? '今天' : i === 1 ? '明天' : dow[(new Date(today.getTime()+i*DAY)).getDay()];
    return `<div class="dayrow"><span>${label}</span><span class="daybar"><i class="fut" style="width:${Math.round(n/maxFut*100)}%"></i></span><span class="hint">${n} 题</span></div>`;
  }).join('');
  /* 最近 7 天日志 */
  const recent = Array.from({length:7}, (_,i) => {
    const t = today.getTime() - (6-i) * DAY;
    return {label: i === 6 ? '今天' : dayKey(t).slice(5), a: dayAgg[dayKey(t)]};
  });
  const maxR = Math.max(1, ...recent.map(r => r.a ? r.a.n : 0));
  const recentRows = recent.map(({label, a}) => {
    const okPct = a && a.n ? Math.round(a.ok/a.n*100) : 0;
    return `<div class="dayrow"><span>${label}</span><span class="daybar">${a ? `<i class="ok" style="width:${Math.round(a.n/maxR*100)}%"></i>` : ''}</span><span class="hint">${a ? `${a.n} 题 · 新学${a.nw} · ${okPct}%` : '—'}</span></div>`;
  }).join('');

  $('#statArea').innerHTML = `
    <div class="stats">
      <div class="stat"><b>${dueN}</b><span>今日待复习</span></div>
      <div class="stat"><b>${wrongN}</b><span>错题本</span></div>
      <div class="stat"><b>${S.reviews.length}</b><span>累计作答</span></div>
      <div class="stat"><b>${streak}</b><span>连续学习天数</span></div>
      <div class="stat"><b>${Object.keys(S.cards).length}</b><span>已接触题目</span></div>
      <div class="stat"><b>${META.total}</b><span>题库总量</span></div>
    </div>
    <div class="card pad"><h2>学习热力图 <small>近 26 周 · 每格一天，越绿作答越多</small></h2>
      <div class="heatwrap"><div class="heatgrid">${heat}</div></div>
      <div class="heatlegend">少 <i></i><i class="h1" style="background:#1f4030"></i><i class="h2" style="background:#2c6b4a"></i><i class="h3" style="background:#38d69c;opacity:.72"></i><i class="h4" style="background:#38d69c"></i> 多</div>
    </div>
    <div class="grid3">
      <div class="card pad"><h2>最近 7 天 <small>作答量与新学</small></h2>${recentRows}</div>
      <div class="card pad"><h2>未来 7 天到期 <small>提前安排复习量</small></h2>${futRows}</div>
    </div>
    <div class="card pad"><h2>各年正确率 <small>评「清晰」记为正确</small></h2>
      ${META.years.map(y=>{ const v = byYear[y]; const r = v.t ? Math.round(v.ok/v.t*100) : 0;
        return `<div class="yrow"><span>${y}</span><span class="ybar"><i style="width:${r}%;opacity:${0.3+Math.min(1,v.t/12)*0.7}"></i></span><span class="hint">${v.ok}/${v.t} · ${r}%</span></div>`; }).join('')}
    </div>
    <div class="card pad"><h2>掌握度分布</h2>
      ${Object.entries(mstats).map(([k,v])=>`<div class="yrow"><span>${['未学','入门','熟悉','熟练','精通','专家'][+k]||k}</span><span class="ybar"><i style="width:${Math.min(100,v*6)}%;opacity:.9"></i></span><span class="hint">${v} 题</span></div>`).join('')}
    </div>`;
}

/* ═════ 设置 ═════ */
function fillSet(){
  const s = S.settings;
  $('#setNew').value = s.dailyNew; $('#setRatio').value = s.ratio; $('#setOrder').value = s.order;
  $('#setRet').value = s.retention; $('#setClear').value = s.autoClearWrong; $('#setRev').value = s.dailyReview;
  if ($('#pdfOffset')) $('#pdfOffset').value = s.pdfOffset;
}
$('#setSave').onclick = () => {
  S.settings.dailyNew = +$('#setNew').value; S.settings.ratio = +$('#setRatio').value;
  S.settings.order = $('#setOrder').value; S.settings.retention = +$('#setRet').value;
  S.settings.autoClearWrong = +$('#setClear').value; S.settings.dailyReview = +$('#setRev').value;
  save(); toast('已保存');
  const st = S.settings;
  $('#rvHint').textContent = `每日新题 ${st.dailyNew} · ${st.ratio ? `复习:新题 = ${st.ratio}:1` : `只复习不开新题`} · ${st.order==='new'?'先新题':st.order==='mix'?'交错':'先复习'}`;
  if ($('#v-review').classList.contains('on')) renderReview(RV.mode);
};
if ($('#pdfTest')) $('#pdfTest').onclick = () => { const first = pageList()[0]; if (first) openViewer(first); else toast('还没有教材页，先运行 build_pages.py'); };
/* ───── 数据安全：导出/导入/备份提醒/自动存档 ───── */
function exportPayload(){
  return JSON.stringify({exportedAt:Date.now(), settings:S.settings, cards:S.cards, reviews:S.reviews,
                         wrong:S.wrong, papers:S.papers, star:S.star||{}, notes:S.notes||{}}, null, 1);
}
function markBackedUp(){
  try { localStorage.setItem('833lastBackup', JSON.stringify({ts:Date.now(), n:S.reviews.length})); } catch(e){}
  hideBackupBar();
}
$('#expBtn').onclick = () => {
  const blob = new Blob([exportPayload()], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = '833复习进度_'+new Date().toISOString().slice(0,10)+'.json'; a.click();
  markBackedUp(); toast('已导出（含星标与笔记）');
};
$('#impFile').onchange = async e => { const f = e.target.files[0]; if (!f) return;
  const d = JSON.parse(await f.text());
  if (d.settings) S.settings = Object.assign(S.settings, d.settings);
  if (d.cards) S.cards = Object.assign(S.cards, d.cards);
  if (d.wrong) S.wrong = Object.assign(S.wrong, d.wrong);
  if (d.papers) S.papers = d.papers||[];
  if (d.reviews) S.reviews = d.reviews||[];
  if (d.star) S.star = d.star;
  if (d.notes) S.notes = d.notes;
  save(); markBackedUp(); toast('已导入进度'); badges(); fillSet(); renderReview(RV.mode);
};
$('#resetBtn').onclick = () => { if (!confirm('清空全部学习进度？（题库保留，星标与笔记会一并清空）')) return;
  S.cards = {}; S.reviews = []; S.wrong = {}; S.papers = []; S.star = {}; S.notes = {}; save(); badges(); toast('已重置'); };

/* 备份提醒：累计新增作答 >200 条或距上次备份 >7 天时提示 */
function checkBackup(){
  const bar = $('#backupBar'); if (!bar) return;
  let rec = null;
  try { rec = JSON.parse(localStorage.getItem('833lastBackup') || 'null'); } catch(e){}
  if (rec && localStorage.getItem('833nextRemind') && Date.now() < +localStorage.getItem('833nextRemind')) return;
  const nNew = S.reviews.length - (rec ? rec.n : 0);
  const days = rec ? (Date.now() - rec.ts) / 86400000 : 99;
  if (rec && nNew < 200 && days < 7) return;
  $('#backupTxt').textContent = rec
    ? `已 ${Math.round(days)} 天未备份，期间新增 ${nNew} 次作答——建议备份一次（进度只在本机浏览器里）`
    : '你的学习进度只保存在本机浏览器，清缓存即丢失——建议先备份一次';
  bar.hidden = false;
}
function hideBackupBar(){ const bar = $('#backupBar'); if (bar) bar.hidden = true; }
$('#backupNow').onclick = () => $('#expBtn').click();
$('#backupLater').onclick = () => {
  try { localStorage.setItem('833nextRemind', String(Date.now() + 7*86400000)); } catch(e){}
  hideBackupBar();
};

/* 自动存档：桌面 Chrome/Edge 用 File System Access API 绑定本地文件，学习后节流自动写入 */
let ARCHIVE_HANDLE = null, archiveTimer = null;
function idb(){ return new Promise((res, rej) => {
  const rq = indexedDB.open('833fs', 1);
  rq.onupgradeneeded = () => rq.result.createObjectStore('h');
  rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});}
async function idbSet(k, v){ const db = await idb(); return new Promise((res, rej) => {
  const tx = db.transaction('h', 'readwrite'); tx.objectStore('h').put(v, k);
  tx.oncomplete = res; tx.onerror = () => rej(tx.error); });}
async function idbGet(k){ const db = await idb(); return new Promise((res, rej) => {
  const tx = db.transaction('h', 'readonly'); const r = tx.objectStore('h').get(k);
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });}
function scheduleArchive(){
  if (!ARCHIVE_HANDLE) return;
  clearTimeout(archiveTimer);
  archiveTimer = setTimeout(writeArchive, 4000);        // 节流 4s，避免每次评级都写盘
}
async function writeArchive(){
  if (!ARCHIVE_HANDLE) return;
  try {
    const w = await ARCHIVE_HANDLE.createWritable();
    await w.write(exportPayload()); await w.close();
    markBackedUp();
  } catch(e){ /* 权限失效等情况静默，导出兜底 */ }
}
async function initArchive(){
  if (!('showSaveFilePicker' in window)) return;        // 移动端与 Firefox/Safari 不支持，隐藏入口
  $('#bindArchive').hidden = false;
  try {
    const h = await idbGet('archive');
    if (h && await h.queryPermission({mode:'readwrite'}) === 'granted'){ ARCHIVE_HANDLE = h; }
    else if (h) $('#archiveHint').textContent = '已绑定过存档文件，刷新后首次学习时需重新授权写入。';
  } catch(e){}
  if (ARCHIVE_HANDLE) $('#bindArchive').textContent = '已绑定存档 · 每次学习自动保存';
}
$('#bindArchive').onclick = async () => {
  try {
    const h = await showSaveFilePicker({suggestedName:'833进度存档.json',
      types:[{description:'JSON', accept:{'application/json':['.json']}}]});
    ARCHIVE_HANDLE = h; await idbSet('archive', h);
    await writeArchive();
    $('#bindArchive').textContent = '已绑定存档 · 每次学习自动保存';
    toast('存档已绑定，之后学习会自动写入该文件');
  } catch(e){ /* 用户取消 */ }
};
const THEMES = ['dark', 'sepia', 'light'];
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme || 'dark';
  const t = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  document.documentElement.dataset.theme = t; localStorage.setItem('833theme', t);
  toast(t === 'sepia' ? '暖纸模式 · 适合长时间阅读' : t === 'dark' ? '暗色模式' : '浅色模式');
};
function openHelp(){
  $('#mBody').innerHTML = `<h2 style="margin-bottom:12px">快捷键</h2>
    <div class="kbdrow">
      <kbd>1 / 2 / 3</kbd><span>评级：不会 / 模糊 / 清晰</span>
      <kbd>空格 或 →</kbd><span>看完答案后，下一题</span>
      <kbd>F</kbd><span>查看本题课本原页</span>
      <kbd>S</kbd><span>星标 / 取消星标当前题</span>
      <kbd>← / →</kbd><span>教材页查看器中翻页</span>
      <kbd>Esc</kbd><span>关闭弹窗 / 查看器</span>
      <kbd>?</kbd><span>呼出本帮助</span>
    </div>
    <p class="hint" style="margin-top:12px">整套复习流可以不碰鼠标完成。</p>`;
  $('#modal').classList.add('on');
}

/* ═════ 徽标 / 初始化 ═════ */
function badges(){
  $('#bDue').textContent = dueCards().length;
  $('#bWrong').textContent = Object.values(S.wrong).filter(w=>!w.cleared).length;
  renderTypeMastery();
  renderTodayRing();
}
async function boot(){
  load();
  const th = localStorage.getItem('833theme'); if (th) document.documentElement.dataset.theme = th;
  const [meta, qs, mm] = await Promise.all([J('data/meta.json'), J('data/questions.json'), J('data/mindmaps.json')]);
  META = meta; QS = qs; QMAP = Object.fromEntries(qs.map(q=>[q.id,q]));
  MAPS = mm.maps; MAPS.forEach(m => { const w = (function go(n){ (n.children||[]).forEach(c=>{ c.parentId = n.id; go(c); }); })(m); });
  PAGES = await J('data/pages.json').catch(() => null);
  const pn = pageList().length;
  $('#brandSub').textContent = `题库 ${META.total} 题 · 导图 ${MAPS.length} 册${pn ? ` · 教材 ${pn} 页` : ''} · 本地存储`;
  $('#paperYears').innerHTML = META.years.map(y=>`<label><input type="checkbox" value="${y}" checked>${y}</label>`).join('');
  $('#bkYear').innerHTML = '<option value="">全部年份</option>' + META.years.map(y=>`<option>${y}</option>`).join('');
  $('#rvYear').innerHTML = '<option value="">全部年份</option>' + META.years.map(y=>`<option>${y}</option>`).join('');
  save();
  badges(); fillSet(); renderReview('review');
  checkBackup(); initArchive();
}
boot();

/* PWA：注册 Service Worker（localhost 与 https 均为安全上下文；file:// 下自动跳过） */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
})();
