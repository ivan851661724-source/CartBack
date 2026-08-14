'use strict';
/* CartBack v4 · Elegance 高级质感版 前端逻辑
 * 结构：五模块外壳不变；确认/方案/发送横幅进对话流；受众=机会清单；邮件=卡片；数据=叙事条+sparkline+SVG趋势；设置=四步向导。
 * 后端契约不变（/api/bootstrap|state|act|draft|config|reset|audience|opportunities|auth/*）。
 */
const FIELDS = [
  ['audience', '针对谁'], ['pain', '为什么挽回'], ['goal', '要什么结果'], ['offer', '给什么钩子']
];
const STAGE_TXT = { S0: 'S0 接入', S1: 'S1 澄清', S2: 'S2 对齐', S3: 'S3 执行' };
const CHAT_PLACEHOLDER = '说清楚你想挽回谁、为啥、要什么结果…';
const state = { token: null, status: null, act: null, kpis: null, trend: null, drafts: [], audience: [], opportunities: null, planPushed: false, planShown: null, lastSent: null, editingDraft: null };

// HTML 转义：所有来自后端/LLM/CSV 导入的文本进 innerHTML 前必须过此函数（P0-2：防 XSS 与 DOM 截断）
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 意向 → 方案卡受众标签（与引擎 extractNeeds 口径对齐）
function intentToAudience(intent) {
  const t = intent || '';
  if (/加购/.test(t)) return '加购未付客户';
  if (/弃购|未付/.test(t)) return '弃购 / 下单未付客户';
  if (/浏览/.test(t)) return '浏览未买客户';
  if (/沉睡|流失/.test(t)) return '沉睡 / 流失老客';
  return '高意向流失人群';
}
// 受众意向是否匹配方案卡受众描述（与 server matchAudienceByDesc 一致）
function matchAudienceDesc(intent, desc) {
  const d = (desc || '').toLowerCase();
  if (/弃购|未付/.test(d)) return /弃购|未付|下单未付/.test(intent);
  if (/加购/.test(d)) return /加购/.test(intent);
  if (/浏览/.test(d)) return /浏览/.test(intent);
  if (/老客|沉睡|流失/.test(d)) return /老客|沉睡|流失/.test(intent);
  return true;
}

const $ = s => document.querySelector(s);
const api = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['x-local-token'] = state.token;
  // 整改 2a：同源显式带 cookie（登录后自动携带 cb_session，session 优先鉴权）
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  if (res.status === 403) throw new Error('鉴权失败（本地令牌不匹配）');
  return res.json();
};

/* ---------- Toast（替换 alert） ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  $('#toastText').textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ---------- 初始化 ---------- */
async function boot() {
  const b = await api('/api/bootstrap');
  state.token = b.token; state.status = b.status;
  refreshMe();            // 登录态初始化（不阻塞主流程）
  await loadState();
  await loadOpportunities();
  await ensureAct();
  renderAll();
  bindEvents();
}
async function loadState() {
  const s = await api('/api/state');
  state.status = s.status; state.kpis = s.kpis; state.trend = s.trend;
  state.metrics = s.metrics || {}; state.demoAnchorRoi = s.demoAnchorRoi;
  state.drafts = s.drafts; state.audience = s.audience;
  if (s.acts && s.acts[0]) state.act = s.acts[0];
  // 会话重建（重置/切换）后 planPushed 复位，允许方案卡重新进对话流
  if (state.act && !state.act.messages.length) state.planPushed = false;
}
async function ensureAct() {
  if (!state.act) {
    const r = await api('/api/act', { method: 'POST' });
    state.act = r.act;
  }
}

/* ---------- 渲染 ---------- */
function renderAll() {
  renderMode(); renderChat(); renderDrafts(); renderData(); renderAud(); renderSet(); renderOpportunities(); updateNeedsHud();
}
function renderMode() {
  const real = state.status && state.status.mode === 'real';
  const badge = $('#modeBadge');
  if (!badge) return;
  badge.textContent = real ? '真实' : '演示';
  badge.classList.toggle('real', real);
}
/* 对话头在线状态 + 顶栏进度条（needs 已收集数） */
function updateNeedsHud() {
  const n = state.act && state.act.needs ? Object.values(state.act.needs).filter(Boolean).length : 0;
  const ch = $('#chInfo'); if (ch) ch.textContent = `Agent 在线 · 已记录 ${n} 项信息`;
  const hp = $('#hpCur'); if (hp) hp.textContent = n;
  const hpT = $('#hpText');
  if (hpT) {
    hpT.textContent = n === 4 ? '信息齐了！看一下对话里的确认卡，点「可以，去发」就能生成邮件方案。'
      : n === 0 ? '跟助手聊聊想挽回谁、为啥、要什么结果，信息齐了自动出方案。'
      : `已收集 ${n} 项，继续聊（还差：${FIELDS.filter(([k]) => !(state.act && state.act.needs && state.act.needs[k])).map(([, l]) => l).join('、')}）`;
  }
}

function renderChat() {
  const box = $('#chat'); box.innerHTML = '';
  if (!state.act.messages || !state.act.messages.length) {
    const g = document.createElement('div');
    g.className = 'msg agent';
    g.innerHTML = '<div class="avatar agent"><svg viewBox="0 0 24 24"><path d="M4 12h11M12 6l6 6-6 6"/></svg></div><div class="bubble">你好，我是你的挽回邮件教练 👋<br>告诉我你想挽回哪类人、为什么、希望拿到什么结果，我帮你一步步生成方案卡。</div>';
    box.appendChild(g);
    return;
  }
  (state.act.messages || []).forEach(m => {
    const d = document.createElement('div');
    d.className = 'msg ' + (m.role === 'user' ? 'user' : 'agent');
    const av = m.role === 'user'
      ? '<div class="avatar user">我</div>'
      : '<div class="avatar agent"><svg viewBox="0 0 24 24"><path d="M4 12h11M12 6l6 6-6 6"/></svg></div>';
    d.innerHTML = av + '<div class="bubble"></div>';
    d.querySelector('.bubble').textContent = m.content;
    box.appendChild(d);
  });
  box.scrollTop = box.scrollHeight;
  // 恢复对话流卡片（P0-1：renderChat 重建 #chat 会抹掉已 append 的卡，需按状态恢复）
  if (state.planShown === 'confirm' && state.act && state.act.planCard) pushConfirm(state.act.planCard, true);
  else if (state.planShown === 'plan' && state.act && state.act.planCard) pushPlan(state.act.planCard, true);
  else if (state.planShown === 'sent' && state.lastSent) pushSent(state.lastSent.res, state.lastSent.draft, true);
}

/* ---------- P0-1：方案卡组件进对话流 ---------- */
function pushConfirm(planCard, silent) {
  const box = $('#chat'); if (!box) return;
  state.planShown = 'confirm';
  const el = document.createElement('div'); el.className = 'confirm';
  const rows = FIELDS.map(([k, label]) => {
    const v = { audience: planCard.audience, pain: planCard.pain, goal: planCard.goal, offer: planCard.discount || planCard.offer }[k] || '';
    return `<div class="c-row"><span class="ck"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></span><span class="k">${label}</span><span class="v">${esc(v)}</span></div>`;
  }).join('');
  const n = Object.values(planCard.needs || planCard).filter(v => v && typeof v === 'string').length;
  el.innerHTML = `<div class="c-head"><span class="spark"><svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/></svg></span>
    <span class="ct">需求已收集完整！这样配置可以吗？</span><span class="cnt"><b>${Math.max(4, n)}</b><span>/4</span></span></div>
    <div class="c-progress"><i></i></div><div class="c-list">${rows}</div>
    <div class="c-actions"><button class="btn primary" id="cfYes">可以，去发</button><button class="btn ghost" id="cfNo">再聊聊</button></div>`;
  box.appendChild(el);
  if (!silent) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#cfYes').onclick = () => { el.remove(); pushPlan(planCard); };
  $('#cfNo').onclick = () => { el.remove(); state.planPushed = false; state.planShown = null; const i = $('#chatInput'); if (i) { i.focus(); i.placeholder = '说说要改哪块：受众、钩子、折扣还是发送时机…'; } };
}
function pushPlan(card, silent) {
  const box = $('#chat'); if (!box) return;
  state.planShown = 'plan';
  const el = document.createElement('div'); el.className = 'plan';
  el.innerHTML = `<div class="p-top"><span class="pt-ic"><svg viewBox="0 0 24 24"><path d="M4 12h11M12 6l6 6-6 6"/></svg></span>
    <span class="pt-t">${esc(card.audience || '')} · 方案已生成</span><span class="pt-s">${esc(card.sendTiming || '')}</span></div>
    <div class="p-body">
      <div class="p-subj"><svg class="pen" viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>主题：${esc(card.subject || '')}</div>
      <div class="p-body-text">${esc(card.body || '')}</div>
      <div class="p-meta">
        <div class="pm"><div class="l">收件人</div><div class="v">${esc(card.matchedCount || 0)} 人</div></div>
        <div class="pm"><div class="l">折扣</div><div class="v">${esc(card.discount || '')}</div></div>
        <div class="pm"><div class="l">优惠码</div><div class="v brand">${esc(card.coupon || '')}</div></div>
      </div>
    </div>
    <div class="p-foot">
      <span class="lang"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>语种跟随收件人：${esc((card.locale || 'en').toUpperCase())}</span>
      <button class="btn ghost sm" id="plEdit">微调</button>
      <button class="btn primary sm" id="plSend">确认发送</button>
    </div>`;
  box.appendChild(el);
  if (!silent) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#plEdit').onclick = () => { const i = $('#chatInput'); if (i) { i.focus(); i.placeholder = '说说要改哪块：受众、钩子、折扣还是发送时机…'; } };
  $('#plSend').onclick = async () => {
    try {
      const r = await api('/api/draft', { method: 'POST', body: JSON.stringify({ actId: state.act.id, planCard: card }) });
      if (r.error) { toast(r.error); return; }
      const d = r.draft;
      const s = await api(`/api/draft/${d.id}/send`, { method: 'POST', body: JSON.stringify({ subject: d.subject, body: d.body }) });
      if (s.error) { toast(s.error); return; }
      el.remove();
      state.lastSent = { res: s.result || {}, draft: d };
      pushSent(s.result || {}, d);
      await loadState(); renderDrafts();
    } catch (e) { toast('发送失败：' + (e.message || e)); }
  };
}
function pushSent(sendRes, draft, silent) {
  const box = $('#chat'); if (!box) return;
  state.planShown = 'sent';
  const el = document.createElement('div'); el.className = 'sent-banner';
  const cost = +((sendRes && sendRes.cost) || draft.cost || 0).toFixed(2);
  const gmv = +(draft.estGmv || 0).toFixed(2);
  el.innerHTML = `<div class="sb-ic"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></div>
    <div><div class="sb-t">已触达 ${(sendRes && sendRes.recipients) || 0} 位顾客</div>
    <div class="sb-s">预计捞回 <b class="num">¥${gmv}</b> · 花费 ¥${cost} · 去看看回流 →</div></div>
    <button class="btn sm primary sb-cta" id="sbGo">看回流</button>`;
  box.appendChild(el);
  if (!silent) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#sbGo').onclick = () => switchTab('data');
  if (!silent) toast('邮件已发出 · 回流中…');
}

/* ---------- 邮件（统计条 + 卡片网格） ---------- */
const SEG_MAP = { draft: [1, 0, 0], sending: [1, 0, 0], sent: [1, 1, 0], recovering: [1, 1, 1], timeout: [1, 1, 0], failed: [1, 0, 0] };
function renderDrafts() {
  const grid = $('#mailGrid'); if (!grid) return;
  const ds = state.drafts;
  const stC = $('#stCount'); if (stC) stC.textContent = ds.length;
  const stR = $('#stReach'); if (stR) stR.textContent = ds.reduce((s, d) => s + (d.matchedCount || 0), 0);
  const stG = $('#stGmv'); if (stG) stG.textContent = '¥' + ds.reduce((s, d) => s + (+d.estGmv || 0), 0).toFixed(0);
  grid.innerHTML = '';
  if (!ds.length) { grid.innerHTML = '<div class="empty-note">还没有邮件。去「助手」跟 agent 聊完，会自动生成方案卡。</div>'; return; }
  ds.forEach(d => {
    const seg = (SEG_MAP[d.status] || [1, 0, 0]).map((s, i) => `<div class="seg ${s ? 'fill' : ''} ${(s && d.status === 'recovering') ? 'ok' : ''}"></div>`).join('');
    const el = document.createElement('div'); el.className = 'mail-card glass-card';
    el.innerHTML = `
      <div class="mc-top"><span class="mc-subj">${esc(d.subject || '')}</span><span class="status-badge ${esc(d.status)}">${esc(d.status)}</span></div>
      <div class="mc-meta"><span>触达 <b>${esc(d.matchedCount || 0)}</b> 人</span><span>${esc(d.sendTiming || '—')}</span></div>
      <div class="mc-progress">${seg}</div>
      <div class="mc-step"><span>草稿</span><span>发送</span><span>触达</span><span>回流</span></div>
      <div class="mc-foot"><span class="tag tag-gray">${esc((d.locale || 'en').toUpperCase())} · 跟随收件人</span><span class="mc-meta brand" style="margin:0"><b>¥${(+d.estGmv || 0).toFixed(0)}</b></span></div>`;
    el.onclick = () => openDraftEditor(d);
    grid.appendChild(el);
  });
  const nb = $('#navBadge');
  if (nb) { nb.textContent = ds.length; nb.classList.toggle('show', ds.length > 0); }
}
/* 邮件编辑器弹窗：主题/正文可改，发送以最新内容为准（P0-1） */
function openDraftEditor(d) {
  state.editingDraft = d;
  $('#editSubj').value = d.subject || '';
  $('#editBody').value = d.body || '';
  $('#editMsg').textContent = ''; $('#editMsg').classList.remove('err');
  openEditModal();
}
async function sendEditedDraft() {
  const d = state.editingDraft;
  const subj = $('#editSubj').value.trim();
  const body = $('#editBody').value;
  const msg = $('#editMsg');
  if (!subj || !body) { msg.textContent = '主题和正文不能为空'; msg.classList.add('err'); return; }
  const r = await api(`/api/draft/${d.id}/send`, { method: 'POST', body: JSON.stringify({ subject: subj, body: body }) });
  if (r.error) { msg.textContent = r.error; msg.classList.add('err'); return; }
  closeEditModal();
  toast('邮件已发送（以编辑后内容为准）');
  await loadState(); renderDrafts(); renderData();
}

/* ---------- 数据（叙事条 + KPI sparkline + SVG 趋势） ---------- */
function sparkline(seed, color) {
  const pts = []; let v = seed;
  for (let i = 0; i < 11; i++) { v = v * (0.84 + Math.random() * 0.32); pts.push(Math.round(v)); }
  const min = Math.min(...pts), max = Math.max(...pts), w = 64, h = 22;
  const step = (max - min) || 1;
  const coords = pts.map((p, i) => `${(i / (pts.length - 1)) * w},${h - 3 - ((p - min) / step) * (h - 9)}`);
  const last = coords[coords.length - 1].split(',');
  const gid = 'sp' + Math.random().toString(36).slice(2, 7);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${color}" stop-opacity=".45"/><stop offset="100%" stop-color="${color}" stop-opacity="1"/></linearGradient></defs>
    <polyline points="${coords.join(' ')}" fill="none" stroke="url(#${gid})" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="${color}" stroke="#fff" stroke-width="1"/></svg>`;
}
function countUp(el, target, prefix) {
  const t0 = performance.now(), dur = 850;
  function tick(t) {
    const p = Math.min(1, (t - t0) / dur);
    const v = Math.round(target * (1 - Math.pow(1 - p, 3)));
    el.textContent = prefix + v.toLocaleString();
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
function renderData() {
  const k = state.kpis || {};
  const real = state.status && state.status.mode === 'real';
  const dh = $('#dataModeHint');
  if (dh) dh.textContent = real ? '北极星：真实回流 GMV / ROI · 只显示真实归因结果' : '北极星：真实回流 GMV / ROI（当前演示数据 · 回流为仿真）';
  // 叙事条
  const net = (+k.gmv || 0) - (+k.cost || 0);
  const nvG = $('#nvGmv'); if (nvG) nvG.textContent = '¥' + (+k.gmv || 0).toFixed(0);
  const nvR = $('#nvRoi'); if (nvR) nvR.textContent = (k.roi || 0).toFixed(1) + '×';
  const nvS = $('#nvSub'); if (nvS) nvS.textContent = `${k.sent || 0} 封邮件 · 触达 ${k.sent || 0} 人 · 花费 ¥${(+k.cost || 0).toFixed(0)} · 净赚 ¥${net.toFixed(0)}`;
  const nvT = $('#nvModeTag'); if (nvT) nvT.textContent = real ? '真实数据' : '演示数据';
  // KPI 六宫格（含 sparkline + 数字滚动）
  const kpis = [
    { l: '触达', v: k.sent || 0, dot: '#FF7F4D', brand: false },
    { l: '打开率', v: ((k.openRate || 0) * 100).toFixed(1) + '%', dot: '#16A34A', brand: false },
    { l: '点击率', v: ((k.clickRate || 0) * 100).toFixed(1) + '%', dot: '#16A34A', brand: false },
    { l: '转化订单', v: k.convert || 0, dot: '#16A34A', brand: false },
    { l: '回流 GMV', v: '¥' + (+k.gmv || 0).toFixed(0), dot: '#FF7F4D', brand: true },
    { l: 'ROI', v: (k.roi || 0).toFixed(1) + '×', dot: '#FF7F4D', brand: true }
  ];
  const box = $('#kpis'); box.innerHTML = '';
  kpis.forEach(kp => {
    const e = document.createElement('div'); e.className = 'kpi glass-card';
    e.innerHTML = `<div class="k-l"><span class="kdot" style="background:${kp.dot}"></span>${kp.l}</div>
      <div class="k-n num ${kp.brand ? 'brand' : ''}" data-count="${esc(kp.v)}">${esc(kp.v)}</div>
      <div class="k-d">·</div>${sparkline(kp.brand ? 60 : 40, kp.brand ? '#FF7F4D' : '#16A34A')}`;
    box.appendChild(e);
    // 数字滚动：仅「¥前缀 + 纯整数」生效（v 可能为数字，先转字符串）
    const el = e.querySelector('.k-n');
    const m = String(kp.v).match(/^(\D*)([\d,]+)$/);
    if (m) { const num = parseInt(m[2].replace(/,/g, ''), 10); if (!isNaN(num) && num > 0) countUp(el, num, m[1]); }
  });
  // 漏斗（发送 → 打开 → 点击 → 转化）
  const f = $('#funnel'); f.innerHTML = '';
  const steps = [['发送', k.sent], ['打开', k.open], ['点击', k.click], ['转化', k.convert]];
  const max = Math.max(k.sent, 1);
  steps.forEach(([l, v]) => {
    const pct = (v / max * 100).toFixed(0);
    const e = document.createElement('div'); e.className = 'f-row';
    e.innerHTML = `<span class="f-label">${l}</span><div class="f-track"><div class="f-fill" style="width:${Math.max(pct, 4)}%"><span>${pct}%</span></div></div><span class="f-val num">${v}</span>`;
    f.appendChild(e);
  });
  // SVG 趋势线（state.trend 的 gmv）
  renderTrendSVG();
  // 运维指标（架构 §7 B6）
  const m = state.metrics || {};
  const mt = $('#metrics');
  if (mt) {
    mt.innerHTML = `<div class="m-item">发信量 <b>${m.send_volume || 0}</b></div>` +
      `<div class="m-item">Token <b>${m.token_usage || 0}</b></div>` +
      `<div class="m-item">发送失败 <b>${m.send_fail || 0}</b></div>` +
      `<div class="m-item">真实发送 <b>${m.send_real || 0}</b></div>` +
      `<div class="m-item">护栏命中 <b>${(m.guardrail_L0 || 0) + (m.guardrail_L2 || 0) + (m.guardrail_L4 || 0) + (m.guardrail_L3 || 0)}</b></div>` +
      `<div class="m-note">成本 ¥${k.cost} · 全量预估可挽回 GMV ¥${k.estTotal}（示意）· 演示 ROI 锚点 ${state.demoAnchorRoi}×（非真实业绩）</div>`;
  }
  // 异常条
  const alert = $('#alertBar'); const alertT = $('#alertText');
  const issues = [];
  if (k.failed) issues.push(`${k.failed} 封发送失败`);
  if (k.timeout) issues.push(`${k.timeout} 封超时`);
  if (issues.length && alert) { alertT.textContent = '⚠ ' + issues.join('，') + '，请检查 ESP 配置或重试。'; alert.classList.add('show'); }
  else if (alert) { alert.classList.remove('show'); }
}
function renderTrendSVG() {
  const el = $('#trendChart'); if (!el) return;
  const data = (state.trend || []).map(x => x.gmv);
  if (!data.length) { el.innerHTML = '<div class="empty-note">暂无趋势数据</div>'; return; }
  const max = Math.max(...data) || 1, w = 620, h = 150, pad = 8;
  const pts = data.map((v, i) => ({ x: pad + i * (w - pad * 2) / (data.length - 1), y: h - ((v / max) * (h - 30)) - 10 }));
  const line = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${pad},${h} ${line} ${w - pad},${h}`;
  const last = pts[pts.length - 1];
  let grid = '';
  for (let g = 0; g < 4; g++) { const gy = h - ((g + 1) / 5) * (h - 26) - 10; grid += `<line x1="${pad}" y1="${gy}" x2="${w - pad}" y2="${gy}" stroke="rgba(148,163,184,.14)" stroke-width="1" stroke-dasharray="2 4"/>`; }
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs><linearGradient id="aG4" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(255,127,77,.26)"/><stop offset="100%" stop-color="rgba(255,127,77,0)"/>
      </linearGradient></defs>
      ${grid}
      <polygon points="${area}" fill="url(#aG4)"/>
      <polyline id="trendLine" points="${line}" fill="none" stroke="#FF7F4D" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="${last.x}" y1="${last.y}" x2="${last.x}" y2="${h}" stroke="rgba(255,127,77,.35)" stroke-width="1" stroke-dasharray="3 3"/>
      <circle cx="${last.x}" cy="${last.y}" r="3.5" fill="#FF7F4D" stroke="#fff" stroke-width="2"/>
      <circle cx="${last.x}" cy="${last.y}" r="8" fill="none" stroke="rgba(255,127,77,.25)" stroke-width="1.5">
        <animate attributeName="r" values="5;11;5" dur="2.4s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values=".8;0;.8" dur="2.4s" repeatCount="indefinite"/>
      </circle>
    </svg>`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ln = document.getElementById('trendLine');
    if (ln) {
      const len = ln.getTotalLength();
      ln.style.strokeDasharray = len; ln.style.strokeDashoffset = len;
      ln.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)';
      requestAnimationFrame(() => { ln.style.strokeDashoffset = 0; });
    }
  }));
}

/* ---------- 受众（机会清单） ---------- */
function renderAud() {
  const tb = $('#oppList'); tb.innerHTML = '';
  // 按预估回流价值降序
  [...state.audience].sort((a, b) => (+b.estGmv || 0) - (+a.estGmv || 0)).forEach((a, i) => {
    const el = document.createElement('div'); el.className = 'opp';
    const urg = a.urgencyDays != null ? `${a.urgencyDays} 天紧迫` : '—';
    el.innerHTML = `
      <div class="av">${esc((a.name || '?').slice(0, 1))}</div>
      <div class="who"><div class="n">${esc(a.name || '—')}</div><div class="e">${esc(a.email || '')}</div></div>
      <div class="sig">
        <span class="tag tag-intent">${esc(a.intent || '')}</span>
        <span class="tag ${a.risk === '高' ? 'tag-risk' : 'tag-gray'}">风险 ${esc(a.risk || '')}</span>
        <span class="tag tag-price">价敏 ${esc(a.price || '')}</span>
        <span class="tag tag-brand"><span class="tdot"></span>${esc(urg)}</span>
      </div>
      <div class="money"><div class="ab">弃购额 ¥${(+a.abandoned_value || 0).toFixed(0)}</div>
        <div class="gmv">¥${(+a.estGmv || 0).toFixed(0)}</div><div class="ab" style="font-size:9.5px">预估回流</div></div>
      <button class="btn sm primary go" data-i="${i}">去聊这拨人</button>`;
    el.onclick = (e) => { if (e.target.closest('.go')) return; openDrawer(a); };
    el.querySelector('.go').onclick = () => jumpToConfig(a.intent, a);
    tb.appendChild(el);
  });
}
// 受众「去聊这拨人」→ 跳对话（预选受众）；有具体对象时把上下文带进输入框
async function jumpToConfig(intent, aud) {
  const r = await api('/api/act', { method: 'POST', body: JSON.stringify({ preset: { audience: intentToAudience(intent) } }) });
  state.act = r.act; state.planPushed = false; state.planShown = null;
  switchTab('chat'); renderChat();
  if (aud) {
    const inp = $('#chatInput');
    inp.value = `帮我挽回 ${aud.intent || ''} 的人，弃购额约 ¥${+aud.abandoned_value || 0}`;
    inp.focus();
  }
}

/* 新流失主动提醒（环节⑥）渲染到对话页顶部机会卡 */
async function loadOpportunities() {
  try { state.opportunities = await api('/api/opportunities'); renderOpportunities(); } catch (e) {}
}
function renderOpportunities() {
  const box = $('#oppCard'); const o = state.opportunities;
  if (!o || (!o.newCount && !o.untargeted)) { if (box) box.classList.add('hidden'); return; }
  const items = (o.opportunities || []).map(x =>
    `<span class="opp-item">${esc(x.name)}（${esc(x.intent)}·预估¥${(x.estGmv || 0).toFixed(0)}·${x.urgencyDays}天）</span>`).join('');
  box.innerHTML = `<div class="opp-msg">🔔 ${esc(o.message)}</div><div class="opp-items">${items}</div>` +
    `<button class="btn sm primary" id="oppGo">捞一波</button>`;
  box.classList.remove('hidden');
  $('#oppGo').onclick = () => {
    const top = (o.opportunities && o.opportunities[0]) || null;
    if (top) jumpToConfig(top.intent, top);
  };
}

/* 受众画像抽屉（v4：一句话画像） */
function openDrawer(a) {
  const dr = $('#drawer'); if (!dr) return;
  $('#dAv').textContent = (a.name || '?').slice(0, 1);
  $('#dName').textContent = a.name || '—';
  $('#dEmail').textContent = a.email || '';
  const intent = a.intent || '';
  const oneLiner = /加购/.test(intent) ? '已加购未结账，购买意愿强、只差临门一脚——折扣 + 提醒最有效。'
    : /弃购|未付/.test(intent) ? '结算中途离开，可能被运费/支付劝退，适合免邮 + 小额折扣再推一把。'
    : /浏览/.test(intent) ? '还在犹豫期，适合低门槛钩子（新品尝鲜价）慢慢养。'
    : '处于流失边缘，先弄清原因再针对性给钩子。';
  $('#drawerBody').innerHTML = `
    <div class="d-sec"><h4>为什么值得捞</h4>
      <div class="d-sig">
        <span class="tag tag-intent">${esc(intent)}</span>
        <span class="tag ${a.risk === '高' ? 'tag-risk' : 'tag-gray'}">流失风险 ${esc(a.risk || '')}</span>
        <span class="tag tag-price">价格敏感 ${esc(a.price || '')}</span>
      </div>
      <div class="kv" style="margin-top:10px"><span>来源</span><b>${esc(a.source || '—')}</b></div>
      <div class="kv"><span>评分</span><b>${esc(a.score != null ? a.score : '—')}</b></div>
    </div>
    <div class="d-sec"><h4>价值</h4>
      <div class="kv"><span>购物车金额</span><b>¥${(+a.abandoned_value || 0).toFixed(2)}</b></div>
      <div class="kv"><span>预估回流 GMV</span><b class="brand">¥${(+a.estGmv || 0).toFixed(2)}</b></div>
      <div class="kv"><span>挽回紧迫度</span><b>${a.urgencyDays != null ? esc(a.urgencyDays) + ' 天' : '—'}</b></div>
    </div>
    <div class="d-sec"><h4>一句话画像</h4>
      <div style="font-size:12.5px;color:var(--text);line-height:1.7">${esc(oneLiner)}</div>
    </div>
    <button class="btn primary d-cta" id="dGo">去对话里挽回这拨人</button>`;
  dr.classList.add('open');
  $('#dGo').onclick = () => { closeDrawer(); jumpToConfig(intent, a); };
}
function closeDrawer() { const dr = $('#drawer'); if (dr) dr.classList.remove('open'); }

/* ---------- 设置（四步向导） ---------- */
function renderSet() {
  const s = state.status || {};
  const aiT = $('#aiTag'); if (aiT) { aiT.textContent = s.aiConfigured ? '已连接' : '待配置'; aiT.className = 'tag ' + (s.aiConfigured ? 'tag-intent' : 'tag-gray'); }
  const esT = $('#espTag'); if (esT) { esT.textContent = s.espConfigured ? '已连接' : '待配置'; esT.className = 'tag ' + (s.espConfigured ? 'tag-intent' : 'tag-price'); }
  const mT = $('#modeTag'); if (mT) { mT.textContent = s.mode === 'real' ? '真实' : '演示'; mT.className = 'tag ' + (s.mode === 'real' ? 'tag-intent' : 'tag-gray'); }
  $('#segDemo').classList.toggle('active', s.mode !== 'real');
  $('#segReal').classList.toggle('active', s.mode === 'real');
  const mw = $('#modeWarn'); if (mw) mw.classList.toggle('show', s.mode === 'real');
  $('#aiKey').value = s.aiConfigured ? '••••••••' : '';
  $('#espKey').value = s.espConfigured ? '••••••••' : '';
  $('#espFrom').value = s.espFrom || '';
  $('#aiModel').value = s.aiModel || 'deepseek-chat';
  const cs = $('#configStatus');
  if (cs) cs.innerHTML = `AI：${s.aiConfigured ? '已配置' : '未配置（离线桩模型）'} · ESP：${s.espConfigured ? '已配置（真实发送）' : '仿真发送'} · 发件域：${esc(s.espFrom || '—')} · 模型：${esc(s.aiModel || 'deepseek-chat')}`;
}

/* ---------- 事件 ---------- */
function switchTab(name) {
  closeDrawer();
  document.querySelectorAll('.nav').forEach(t => {
    const on = t.dataset.nav === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.view').forEach(p => p.classList.toggle('active', p.id === 'view-' + name));
  const crumb = $('#crumb');
  if (crumb) crumb.textContent = '/ ' + ({ chat: '助手', mail: '邮件配置', data: '数据看板', aud: '受众', set: '设置' }[name] || name);
}
function bindEvents() {
  document.querySelectorAll('.nav').forEach(t => t.onclick = () => switchTab(t.dataset.nav));
  $('#chatSend').onclick = sendMsg;
  $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });
  $('#segDemo').onclick = () => setMode('demo');
  $('#segReal').onclick = () => setMode('real');
  document.querySelectorAll('.save-cfg').forEach(b => b.onclick = saveConfig);
  document.querySelectorAll('.js-reset').forEach(b => b.onclick = resetData);
  $('#resetData').onclick = resetData;
  $('#storeCta').onclick = () => openImportModal();
  $('#hpSkip').onclick = () => { const p = $('#hintPill'); if (p) p.style.display = 'none'; };
  $('#showImport').onclick = openImportModal;
  $('#importClose').onclick = closeImportModal;
  $('#importModal').addEventListener('click', e => { if (e.target === $('#importModal')) closeImportModal(); });
  $('#doImport').onclick = doImport;
  $('#editClose').onclick = closeEditModal;
  $('#editModal').addEventListener('click', e => { if (e.target === $('#editModal')) closeEditModal(); });
  $('#editSend').onclick = sendEditedDraft;
  $('#drawerClose').onclick = closeDrawer;
  $('#userBtn').onclick = () => {
    if (me && me.user) {
      if (confirm('退出登录？')) authLogout();
    } else {
      authMode = 'login';
      $('#authTitle').textContent = '登录';
      $('#authName').style.display = 'none';
      $('#authSubmit').textContent = '登录';
      $('#authMsg').textContent = ''; $('#authMsg').classList.remove('err');
      openAuthModal();
    }
  };
  $('#authClose').onclick = closeAuthModal;
  $('#authModal').addEventListener('click', e => { if (e.target === $('#authModal')) closeAuthModal(); });
  $('#authToggle').onclick = () => {
    authMode = authMode === 'register' ? 'login' : 'register';
    $('#authTitle').textContent = authMode === 'register' ? '登录 / 注册' : '登录';
    $('#authName').style.display = authMode === 'register' ? '' : 'none';
    $('#authSubmit').textContent = authMode === 'register' ? '注册并登录' : '登录';
  };
  $('#authSubmit').onclick = authSubmit;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeImportModal(); closeEditModal(); closeDrawer(); closeAuthModal(); } });
}
function openImportModal() { const m = $('#importModal'); if (m) m.classList.add('open'); }
function closeImportModal() { const m = $('#importModal'); if (m) m.classList.remove('open'); }
function openEditModal() { const m = $('#editModal'); if (m) m.classList.add('open'); }
function closeEditModal() { const m = $('#editModal'); if (m) m.classList.remove('open'); }

async function sendMsg() {
  const inp = $('#chatInput'); const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  inp.placeholder = CHAT_PLACEHOLDER;
  state.act.messages.push({ role: 'user', content: text });
  renderChat();
  const box = $('#chat');
  // 思考中指示
  const typing = document.createElement('div');
  typing.className = 'msg agent';
  typing.innerHTML = '<div class="avatar agent"><svg viewBox="0 0 24 24"><path d="M4 12h11M12 6l6 6-6 6"/></svg></div><div class="bubble typing"><span></span><span></span><span></span></div>';
  box.appendChild(typing); box.scrollTop = box.scrollHeight;

  const finalize = (r) => {
    state.act.stage = r.stage; state.act.needs = r.needs || state.act.needs;
    state.act.messages.push({ role: 'assistant', content: r.reply });
    state.act.planCard = r.planCard || null;
    renderChat(); updateNeedsHud();
    // 方案卡进对话流（P0-1）：仅当本次返回且未推送过
    if (r.planCard && !state.planPushed) { state.planPushed = true; pushConfirm(r.planCard); }
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['x-local-token'] = state.token;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch(`/api/act/${state.act.id}/message/stream`, { method: 'POST', headers, body: JSON.stringify({ message: text }), signal: ctrl.signal });
    if (!res.ok) throw new Error('stream http ' + res.status);
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = ''; let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop();
      for (const p of parts) {
        const line = p.trim();
        if (!line.startsWith('data:')) continue;
        const data = JSON.parse(line.slice(5).trim());
        if (data.type === 'token') { full += data.value; typing.querySelector('.bubble').textContent = full; box.scrollTop = box.scrollHeight; }
        else if (data.type === 'done') { clearTimeout(to); finalize(data.result); typing.remove(); return; }
      }
    }
    clearTimeout(to);
    if (!full) throw new Error('空流');
    finalize({ reply: full, stage: state.act.stage, needs: state.act.needs, planCard: state.act.planCard });
    typing.remove();
  } catch (e) {
    // 降级：一次性 /message
    try {
      const r = await api(`/api/act/${state.act.id}/message`, { method: 'POST', body: JSON.stringify({ message: text }) });
      if (r.error) { toast(r.error); typing.remove(); return; }
      finalize(r);
    } catch (e2) { toast('发送失败：' + (e2.message || e2)); }
    typing.remove();
  }
}
async function setMode(m) {
  await api('/api/config', { method: 'POST', body: JSON.stringify({ mode: m }) });
  await loadState(); renderAll();
  toast(m === 'real' ? '已切换真实模式（仅显示真实归因）' : '已切换演示模式');
}
async function saveConfig() {
  const body = {
    aiKey: $('#aiKey').value.startsWith('•') ? '' : $('#aiKey').value,
    espKey: $('#espKey').value.startsWith('•') ? '' : $('#espKey').value,
    espFrom: $('#espFrom').value, aiModel: $('#aiModel').value
  };
  const r = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
  state.status = r.status;
  const cm = $('#configMsg');
  if (cm) cm.textContent = '已保存（密钥仅存于服务端，不回传前端）';
  toast('配置已保存');
  renderSet();
}
async function resetData() {
  if (!confirm('确定重置全部数据？假种子受众会重新生成。')) return;
  await api('/api/reset', { method: 'POST' });
  state.act = null; await loadState(); await ensureAct();
  state.planPushed = false; state.planShown = null; state.lastSent = null;
  renderAll();
  toast('数据已重置');
}
async function doImport() {
  const csv = $('#csvInput').value;
  const r = await api('/api/audience/import', { method: 'POST', body: JSON.stringify({ csv }) });
  const msg = $('#importMsg');
  if (r.error) { msg.textContent = r.error; msg.classList.add('err'); return; }
  msg.textContent = `已导入 ${r.imported} 条`; msg.classList.remove('err');
  state.audience = r.audience; renderAud();
  toast(`已导入 ${r.imported} 位高意向顾客`);
  setTimeout(() => closeImportModal(), 800);
}

/* ---------- 用户登录（session 优先；localToken 兼容不强制） ---------- */
let me = null;
let authMode = 'register';

async function refreshMe() {
  try {
    const r = await fetch('/api/auth/me', { method: 'GET', credentials: 'same-origin' });
    if (r.ok) { me = await r.json(); } else { me = null; }
  } catch (e) { me = null; }
  const btn = $('#userBtn');
  const av = $('#tAvatar');
  if (me && me.user) {
    const nm = me.user.name || me.user.email;
    if (btn) { btn.textContent = '登出'; btn.title = nm; }
    if (av) { av.style.display = 'flex'; av.textContent = nm.slice(0, 1).toUpperCase(); av.title = nm; }
  } else {
    if (btn) { btn.textContent = '登录'; btn.title = ''; }
    if (av) av.style.display = 'none';
  }
  if (me && me.user && me.authMode === 'session') { loadState().catch(() => {}); }
}
async function authSubmit() {
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const name = $('#authName').value.trim();
  const msg = $('#authMsg');
  msg.textContent = ''; msg.classList.remove('err');
  if (!email || !password) { msg.textContent = '邮箱和密码不能为空'; msg.classList.add('err'); return; }
  const path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
  const body = authMode === 'register' ? { email, password, name } : { email, password };
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { msg.textContent = j.error || '请求失败'; msg.classList.add('err'); return; }
  closeAuthModal();
  if (authMode === 'register') { $('#authEmail').value = ''; $('#authPassword').value = ''; $('#authName').value = ''; }
  refreshMe();
  toast(authMode === 'register' ? '注册成功，欢迎！' : '登录成功');
}
async function authLogout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  me = null;
  refreshMe();
  toast('已退出登录');
}
function openAuthModal() { const m = $('#authModal'); if (m) m.classList.add('open'); }
function closeAuthModal() { const m = $('#authModal'); if (m) m.classList.remove('open'); }

boot().catch(e => toast('初始化失败：' + e.message));
