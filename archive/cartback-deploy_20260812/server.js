'use strict';
/**
 * CartBack v3 — API Gateway / 服务端（零依赖 Node）
 * 职责（架构 §2 / §6）：静态托管（安全）+ AI/ESP 代理（密钥不落地）+ 护栏/critic
 *      + 数据持久化 + 归因回执接收 + 端点鉴权 + 真实发信护栏。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const cfg = require('./lib/config');
const { Store, uid } = require('./lib/store');
const igdeMod = require('./lib/igde');
const { IGDE, guardrailL2 } = igdeMod;
const { LLMClient } = require('./lib/llm');
const { buildConnectors } = require('./lib/storeConnector');
const authMod = require('./lib/auth');

let config = cfg.load();
const store = new Store();
store.init();
// 店后台连接器集合（架构 §2 B1）：从配置构建；null = 未接入任何店，退化本地种子/演示
const connectors = buildConnectors(config);

// IGDE 实例：callAI 每调用经 LLMClient.chatStructured（一次返回 reply+needs）；
// aiEnabled 由消息处理端点按「是否配了 key」动态置位（见 /api/act/:id/message）。
const igde = new IGDE({
  aiEnabled: false,
  callAI: async (messages) => llmCoach(messages),
  callCritic: async (text) => callCritic(text)
});

// —— 监控计数器（架构 §7 B6：护栏命中率 / 离线降级率 / 发送失败率 / 成本计量）——
function loadMetrics() { try { return JSON.parse(store.getMeta('metrics') || '{}'); } catch (e) { return {}; } }
function saveMetrics(m) { store.setMeta('metrics', JSON.stringify(m)); }
function metricsInc(key, n = 1) { const m = loadMetrics(); m[key] = (m[key] || 0) + n; saveMetrics(m); return m; }

// 结构化日志（send / attribution / guardrail hit，便于回测 V）
function logEvent(type, data) {
  console.log(JSON.stringify({ t: 'ey', ts: Date.now(), type, ...data }));
}

// —— 速率限制（架构 §6 P0-3：/send 速率限制防域名声誉滥用）——
const rateBucket = { start: Date.now(), count: 0 };
function rateLimitOk() {
  const now = Date.now();
  if (now - rateBucket.start > 60000) { rateBucket.start = now; rateBucket.count = 0; }
  const limit = config.sendRateLimitPerMin || 20;
  if (rateBucket.count >= limit) return false;
  rateBucket.count++;
  return true;
}

// —— 注册限流（整改 3：per-IP 滑动窗口，每小时 ≤10 次，防刷号）——
const regBuckets = {}; // ip -> { win, count }
function regRateOk(ip) {
  const now = Date.now();
  const b = regBuckets[ip] || { win: now, count: 0 };
  if (now - b.win > 3600000) { b.win = now; b.count = 0; }
  b.count++; regBuckets[ip] = b;
  return b.count <= 10;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}

// —— AI 适配器（lib/llm 的 LLMClient，服务端代理保密钥） ——
// 真实模型教练：用 buildCoachMessages（在 igde 内组装）+ LLMClient.chatStructured 一次出 reply+needs。
async function llmCoach(messages) {
  if (!config.aiKey) throw new Error('AI 未配置');
  const client = new LLMClient({ baseUrl: config.aiBaseUrl, model: config.aiModel, apiKey: config.aiKey });
  const r = await client.chatStructured({ messages });
  if (r.usage && r.usage.total_tokens) metricsInc('token_usage', r.usage.total_tokens);
  return { reply: r.reply, needs: r.needs };
}

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

async function callCritic(text) {
  if (!config.aiKey) return guardrailL2(text); // 本地启发式兜底（L2）
  // fail-closed（架构 P1-4）：真实 critic 调用失败 → 视为违规拦截，而非放行
  try {
    const client = new LLMClient({ baseUrl: config.aiBaseUrl, model: config.aiModel, apiKey: config.aiKey });
    const r = await client.chatStructured({
      messages: [
        { role: 'system', content: '你是严格的内容审查员。判断文本是否「说教 / 推销 / 列清单 / 替用户下结论」。只回 JSON {"bad":true} 或 {"bad":false}，不要其它内容。' },
        { role: 'user', content: text }
      ]
    });
    // chatStructured 只抽取 reply/needs，「bad」需从原始 content 解析
    const content = r.raw && r.raw.choices && r.raw.choices[0] && r.raw.choices[0].message.content;
    const parsed = safeJson(content);
    if (parsed && typeof parsed.bad === 'boolean') return !parsed.bad;
    return guardrailL2(text); // 解析失败 → 本地兜底
  } catch (e) {
    return false; // fail-closed
  }
}

// —— ESP 适配器（Resend 真发 + 仿真回退） ——
async function fetchResend(draft, recipients, c) {
  const resp = await fetch(c.espApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.espKey },
    body: JSON.stringify({
      from: c.espFrom,
      to: recipients.map(r => r.email),
      subject: draft.subject,
      text: draft.body
    })
  });
  if (!resp.ok) throw new Error('ESP HTTP ' + resp.status);
  return await resp.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 依据方案卡受众描述解析真实收件人（P0 真实源未接前用假种子/导入名单）
function matchAudienceByDesc(desc) {
  const all = store.getAudience();
  const d = (desc || '').toLowerCase();
  let list = all;
  if (/弃购|未付/.test(d)) list = all.filter(a => /弃购|未付|下单未付/.test(a.intent));
  else if (/加购/.test(d)) list = all.filter(a => /加购/.test(a.intent));
  else if (/浏览/.test(d)) list = all.filter(a => /浏览/.test(a.intent));
  else if (/老客|沉睡|流失/.test(d)) list = all.filter(a => /老客|沉睡|流失/.test(a.intent));
  if (list.length === 0) list = all;
  return list;
}
function resolveRecipients(draft) {
  return matchAudienceByDesc(draft.audience).slice(0, 200);
}

// 仿真归因事件（演示模式驱动看板；真实模式仅在有回执时写入）
function scheduleSimEvents(draft, recipients) {
  const now = Date.now();
  recipients.forEach((r, i) => {
    const base = now + i * 1200;
    if (Math.random() < 0.72) store.addEvent({ type: 'open', draft_id: draft.id, audience_id: r.id, ts: base });
    if (Math.random() < 0.34) store.addEvent({ type: 'click', draft_id: draft.id, audience_id: r.id, ts: base + 3000 });
    if (Math.random() < 0.14) {
      const value = +(r.abandoned_value * (0.1 + Math.random() * 0.2)).toFixed(2);
      store.addEvent({ type: 'convert', draft_id: draft.id, audience_id: r.id, value, ts: base + 9000 });
    }
  });
}

async function sendDraft(draft) {
  const recipients = resolveRecipients(draft);
  metricsInc('send_volume', recipients.length);
  const real = (config.mode === 'real' && config.espKey && config.espFrom);
  draft.status = 'sending'; store.upsertDraft(draft);
  if (!real) {
    draft.status = 'sent';
    draft.sent_at = Date.now();
    draft.esp_message_id = 'sim_' + uid();
    draft.cost = +(recipients.length * 0.02).toFixed(2); // 仿真混合成本
    store.upsertDraft(draft);
    scheduleSimEvents(draft, recipients);
    metricsInc('send_sim');
    logEvent('send', { real: false, recipients: recipients.length, cost: draft.cost });
    return { real: false, recipients: recipients.length, cost: draft.cost, estGmv: draft.estGmv };   // UI v4 整改 4：补 cost/estGmv
  }
  let attempt = 0, lastErr;
  while (attempt < 3) {
    attempt++;
    try {
      const r = await fetchResend(draft, recipients, config);
      draft.status = 'sent';
      draft.sent_at = Date.now();
      draft.esp_message_id = r.id || ('real_' + uid());
      draft.cost = +(recipients.length * 0.0004).toFixed(4);
      store.upsertDraft(draft);
      metricsInc('send_real');
      logEvent('send', { real: true, recipients: recipients.length, attempt, cost: draft.cost });
      return { real: true, id: draft.esp_message_id, recipients: recipients.length, cost: draft.cost, estGmv: draft.estGmv };   // UI v4 整改 4
    } catch (e) { lastErr = e; await sleep(1000 * attempt); }
  }
  draft.status = 'failed'; store.upsertDraft(draft);
  metricsInc('send_fail');
  logEvent('send_fail', { recipients: recipients.length, error: String(lastErr && lastErr.message || lastErr) });
  return { real: true, error: String(lastErr && lastErr.message || lastErr), recipients: recipients.length, cost: draft.cost || 0, estGmv: draft.estGmv };   // UI v4 整改 4
}

// —— CSV 导入解析 ——
function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const hasHeader = header.includes('email');
  const start = hasHeader ? 1 : 0;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const row = {};
    header.forEach((h, idx) => { row[h] = (cols[idx] || '').trim(); });
    if (!hasHeader) { row.name = (cols[0] || '').trim(); row.email = (cols[1] || '').trim(); }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email || '')) continue;
    out.push({
      name: row.name || row.email.split('@')[0],
      email: row.email,
      intent: row.intent || '导入',
      risk: row.risk || '中',
      price: row.price || '中',
      abandoned_value: parseFloat(row.abandoned_value) || 0,
      source: 'import'
    });
  }
  return out;
}

// —— HTTP 工具 ——
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// 静态托管（安全：dotfile 拦截 + 路径穿越拦截 + 仅 web 根）
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/flow.html';
  const filePath = path.normalize(path.join(cfg.PUBLIC_DIR, rel));
  // 越界 / 隐藏文件 / 非 web 根 → 403
  if (!filePath.startsWith(cfg.PUBLIC_DIR) || rel.split('/').some(s => s.startsWith('.')) || filePath.includes('..')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

// —— 路由 ——
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  // CORS（收紧：仅同源 localhost；§6.3）
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-local-token');
  }
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 静态资源（flow.html 五模块外壳）
  if (method === 'GET' && !pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }

  if (!pathname.startsWith('/api/')) { res.writeHead(404); res.end('Not Found'); return; }

  // 鉴权：bootstrap 与 /api/auth/* 豁免；业务端点解析会话 cookie，回退 x-local-token（老前端零破坏，整改 1a）
  // /api/attribution 为真实 ESP webhook 回执，豁免全局鉴权、端点内用 webhook secret 校验（整改 2）
  if (pathname !== '/api/bootstrap' && !pathname.startsWith('/api/auth/') && pathname !== '/api/attribution') {
    const who = authMod.resolveUser(req, store, config);
    if (!who) return sendJson(res, 403, { error: 'unauthorized' });
    req.userId = who.userId;
    req.authMode = who.authMode;
  }

  try {
    // —— bootstrap：下发本地令牌 + 配置状态 ——
    if (pathname === '/api/bootstrap' && method === 'GET') {
      return sendJson(res, 200, { token: config.localToken, status: cfg.status(config) });
    }

    // —— 用户认证（架构方案 v4 D7；会话 cookie 优先，x-local-token 兼容过渡）——
    function publicUser(u) { return { id: u.id, email: u.email, name: u.name, status: u.status, created_at: u.created_at }; }
    function issueSession(userId) {
      const token = authMod.newToken();
      store.createSession({ token_hash: authMod.hashToken(token), user_id: userId });
      authMod.setSessionCookie(res, token); // 云存档：Max-Age 10 年
      return token;
    }
    if (pathname === '/api/auth/register' && method === 'POST') {
      if (!regRateOk(clientIp(req))) return sendJson(res, 429, { error: '注册过于频繁，请稍后再试' });   // 整改 3
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: '邮箱格式不正确' });
      if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) return sendJson(res, 400, { error: '密码至少 8 位，且同时包含字母和数字' });
      if (!name || name.length > 40) return sendJson(res, 400, { error: '昵称不能为空且不超过 40 字' });
      if (store.getUserByEmail(email)) return sendJson(res, 409, { error: '该邮箱已注册' });
      const user = store.createUser({ email, name, password_hash: authMod.hashPassword(password), status: 'active' });
      issueSession(user.id);
      logEvent('auth_register', { userId: user.id, email: user.email });
      return sendJson(res, 200, { user: publicUser(user) });
    }
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (authMod.isLoginLocked(email)) return sendJson(res, 429, { error: '尝试次数过多，请 15 分钟后再试' });
      const user = store.getUserByEmail(email);
      if (!user || !authMod.verifyPassword(password, user.password_hash)) {
        authMod.noteLoginFail(email);
        return sendJson(res, 401, { error: '邮箱或密码错误' });
      }
      if (user.status === 'disabled') return sendJson(res, 403, { error: '账号已被禁用，请联系支持' });
      authMod.noteLoginOk(email);
      issueSession(user.id);
      logEvent('auth_login', { userId: user.id });
      return sendJson(res, 200, { user: publicUser(user) });
    }
    if (pathname === '/api/auth/logout' && method === 'POST') {
      const token = authMod.parseCookies(req)[authMod.SESSION_COOKIE];
      if (token) {
        const s = store.findSessionByTokenHash(authMod.hashToken(token));
        if (s) store.deleteSession(s.id);
      }
      authMod.clearSessionCookie(res);
      logEvent('auth_logout', {});
      return sendJson(res, 200, { ok: true });
    }
    // —— 退出所有设备（整改 5：会话云存档永久，cookie 丢失时靠它回收全部旧会话）——
    if (pathname === '/api/auth/logout-all' && method === 'POST') {
      const who = authMod.resolveUser(req, store, config);
      if (!who) return sendJson(res, 401, { error: '未登录' });
      store.deleteSessionsByUser(who.userId);
      authMod.clearSessionCookie(res);
      logEvent('auth_logout_all', { userId: who.userId });
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/me' && method === 'GET') {
      const who = authMod.resolveUser(req, store, config);
      if (!who) return sendJson(res, 401, { error: '未登录' });
      const u = store.getUserById(who.userId);
      return sendJson(res, 200, { user: u ? publicUser(u) : null, authMode: who.authMode });
    }
    if (pathname.startsWith('/api/auth/')) return sendJson(res, 404, { error: 'auth route not found' });

    // —— state：首屏数据（整改 1c：acts/drafts/KPI/趋势按当前用户过滤；audience 店铺级共享）——
    if (pathname === '/api/state' && method === 'GET') {
      return sendJson(res, 200, {
        status: cfg.status(config),
        acts: store.getActsByUser(req.userId),
        drafts: store.getDraftsByUser(req.userId),
        audience: store.getAudience(),
        kpis: store.getKpis(config.mode, req.userId),
        week: store.getKpisWeek(config.mode, req.userId),   // UI v4 整改 2：叙事条本周口径
        trend: store.getTrend(req.userId),
        metrics: loadMetrics(),
        demoAnchorRoi: 24.9
      });
    }

    // —— 创建引导会话（支持 preset 预选受众：受众模块「点开画像跳配置」）——
    if (pathname === '/api/act' && method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      const act = {
        id: uid('act_'), stage: 'S0', needs: {}, messages: [],
        status: 'active', created_at: Date.now(), updated_at: Date.now(),
        user_id: req.userId || null   // 整改 1c：打归属
      };
      const op = igde.opening();
      act.messages.push({ role: 'assistant', content: op.reply, ts: Date.now() });
      if (body.preset && body.preset.audience) {
        igde.applyNeeds(act, { audience: body.preset.audience });
        act.stage = 'S1';
        act.messages.push({ role: 'assistant', content: `收到，这次针对【${act.needs.audience}】。还想知道：他们为啥快丢、你希望他们回来干啥、想给什么钩子？`, ts: Date.now() });
      }
      store.upsertAct(act);
      return sendJson(res, 200, { act });
    }

    // —— 新流失主动提醒（环节⑥：监控新弃购/高意向，主动冒给 agent；整改 1c：按当前用户 drafts 判定已覆盖）——
    if (pathname === '/api/opportunities' && method === 'GET') {
      const aud = store.getAudience();
      const high = aud.filter(a => (a.score || 0) >= 0.7);
      const sent = store.getDraftsByUser(req.userId).filter(d => ['sent', 'recovering'].includes(d.status));
      const targeted = new Set(sent.map(d => (d.audience || '').toLowerCase()));
      const untargeted = high.filter(a => !targeted.has((a.intent || '').toLowerCase()));
      const lastSeen = parseInt(store.getMeta('opp_last_seen') || '0', 10);
      const newCount = Math.max(0, aud.length - lastSeen);
      const opportunities = untargeted.slice(0, 5).map(a => ({
        id: a.id, name: a.name, intent: a.intent, estGmv: a.estGmv, urgencyDays: a.urgencyDays
      }));
      store.setMeta('opp_last_seen', String(aud.length));
      const message = newCount > 0
        ? `又有 ${newCount} 个高意向快丢了，捞吗？`
        : (untargeted.length ? `还有 ${untargeted.length} 拨高意向人群没发过挽回，捞吗？` : '当前高意向人群都已覆盖，稳。');
      return sendJson(res, 200, { total: high.length, untargeted: untargeted.length, newCount, message, opportunities });
    }

    // —— 对话消息：IGDE 驱动 ——
    const m = pathname.match(/^\/api\/act\/([\w-]+)\/message$/);
    if (m && method === 'POST') {
      const act = store.getAct(m[1]);
      if (!act) return sendJson(res, 404, { error: 'act not found' });
      const body = await readBody(req);
      igde.aiEnabled = !!config.aiKey; // 动态：配了 key 走真模型，否则桩
      // 邮件语种 = 店铺默认语种（收件人逐人本地化在发送环节 renderForRecipient 做）
      const r = await igde.handle(act, (body.message || '').toString().slice(0, 2000), { locale: config.shopDefaultLocale || 'en' });
      store.upsertAct(act);
      if (r.guardrailHits && r.guardrailHits.length) {
        r.guardrailHits.forEach(h => metricsInc('guardrail_' + h));
        logEvent('guardrail', { hits: r.guardrailHits });
      }
      return sendJson(res, 200, r);
    }

    // —— 对话消息（流式 / SSE）：边算边推 token，结束回传结构化结果；失败由前端降级一次性 /message ——
    const sm2 = pathname.match(/^\/api\/act\/([\w-]+)\/message\/stream$/);
    if (sm2 && method === 'POST') {
      const act = store.getAct(sm2[1]);
      if (!act) return sendJson(res, 404, { error: 'act not found' });
      const body = await readBody(req);
      igde.aiEnabled = !!config.aiKey;
      let result;
      try {
        result = await igde.handle(act, (body.message || '').toString().slice(0, 2000), { locale: config.shopDefaultLocale || 'en' });
      } catch (e) {
        return sendJson(res, 500, { error: String(e && e.message || e) });
      }
      store.upsertAct(act);
      if (result.guardrailHits && result.guardrailHits.length) {
        result.guardrailHits.forEach(h => metricsInc('guardrail_' + h));
        logEvent('guardrail', { hits: result.guardrailHits });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      const reply = result.reply || '';
      const step = 3; // 每帧推 3 字，营造打字机节奏
      for (let i = 0; i < reply.length; i += step) {
        res.write(`data: ${JSON.stringify({ type: 'token', value: reply.slice(i, i + step) })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'done', result })}\n\n`);
      res.end();
      return;
    }

    // —— 生成草稿（从方案卡） ——
    if (pathname === '/api/draft' && method === 'POST') {
      const body = await readBody(req);
      const card = body.planCard;
      if (!card) return sendJson(res, 400, { error: 'missing planCard' });
      // 预估可挽回 GMV（PRD §5① / 算法 v1 环节①：匹配受众 × 类目挽回率基准，标注预估）
      const matched = matchAudienceByDesc(card.audience);
      const estGmv = +matched.reduce((s, a) => s + (a.estGmv || 0), 0).toFixed(2);
      const draft = {
        id: uid('dr_'), act_id: body.actId || null,
        subject: card.subject, body: card.body, audience: card.audience,
        discount: card.discount, coupon: card.coupon, posters: card.posters,
        estGmv, matchedCount: matched.length, sendTiming: card.sendTiming || null,
        status: 'draft', created_at: Date.now(), sent_at: null, esp_message_id: null, cost: 0,
        user_id: req.userId || null,   // 整改 1c：打归属
        locale: card.locale || null    // UI v4 整改 1 备注：邮件语种跟收件人 locale
      };
      store.upsertDraft(draft);
      return sendJson(res, 200, { draft, estGmv, matchedCount: matched.length });
    }

    if (pathname === '/api/drafts' && method === 'GET') {
      // UI v4 整改 1：汇总 stats + 每封生命周期进度段（草稿→发送→触达→回流）
      const drafts = store.getDraftsByUser(req.userId);
      const segMap = { draft: [1,0,0], sending: [1,0,0], sent: [1,1,0], recovering: [1,1,1], timeout: [1,1,0], failed: [1,0,0] };
      const stats = {
        count: drafts.length,
        reached: drafts.reduce((s, d) => s + (d.matchedCount || 0), 0),      // 累计触达（仿真=匹配数）
        gmv: +drafts.reduce((s, d) => s + (+d.estGmv || 0), 0).toFixed(2),   // 已捞回·预估
        cost: +drafts.reduce((s, d) => s + (+d.cost || 0), 0).toFixed(2)
      };
      const items = drafts.map(d => ({ ...d, progressSeg: segMap[d.status] || [1,0,0], locale: d.locale || config.shopDefaultLocale || 'en' }));
      return sendJson(res, 200, { drafts: items, stats });
    }

    // —— 发送（真实 / 仿真，含重试与 FSM） ——
    const sm = pathname.match(/^\/api\/draft\/([\w-]+)\/send$/);
    if (sm && method === 'POST') {
      const draft = store.getDraft(sm[1]);
      if (!draft) return sendJson(res, 404, { error: 'draft not found' });
      // 前端邮件页编辑：发送前把最新主题/正文落库（P0-1：避免「界面显示新内容、实际发出旧内容」）
      try {
        const body = await readBody(req);
        if (body && typeof body.subject === 'string' && body.subject.trim()) draft.subject = body.subject.trim();
        if (body && typeof body.body === 'string' && body.body.trim()) draft.body = body.body.trim();
      } catch (e) { /* 无 body 或非 JSON：维持存储原稿 */ }
      if (config.mode === 'real' && !config.espKey) {
        return sendJson(res, 400, { error: '真实模式未配置 ESP 密钥，已禁用真实发送' });
      }
      if (!rateLimitOk()) {
        return sendJson(res, 429, { error: '发送频率超限（每分钟上限 ' + (config.sendRateLimitPerMin || 20) + '），请稍后再试' });
      }
      const r = await sendDraft(draft);
      return sendJson(res, 200, { result: r, draft });
    }

    // —— 受众 ——
    if (pathname === '/api/audience' && method === 'GET') {
      return sendJson(res, 200, { audience: store.getAudience() });
    }
    if (pathname === '/api/audience/import' && method === 'POST') {
      const body = await readBody(req);
      const list = parseCsv(body.csv || '');
      if (!list.length) return sendJson(res, 400, { error: '未解析到有效邮箱' });
      store.addAudience(list);
      return sendJson(res, 200, { imported: list.length, audience: store.getAudience() });
    }

    // —— Store Connector：店铺事件 webhook 同步（架构 §2 B1：店铺 API / webhook / CSV 导入）——
    if (pathname === '/api/store/sync' && method === 'POST') {
      const body = await readBody(req);
      const events = Array.isArray(body.events) ? body.events : (body.event ? [body.event] : []);
      if (!events.length) return sendJson(res, 400, { error: '缺少 events' });
      const list = events
        .map(e => ({
          name: e.name || (e.email || '').split('@')[0], email: e.email,
          intent: e.intent || '导入', risk: e.risk || '中', price: e.price || '中',
          abandoned_value: parseFloat(e.abandoned_value) || 0, source: 'store', at_risk_at: Date.now()
        }))
        .filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.email || ''));
      if (!list.length) return sendJson(res, 400, { error: '未解析到有效邮箱' });
      store.addAudience(list);
      logEvent('store_sync', { imported: list.length });
      return sendJson(res, 200, { imported: list.length, audience: store.getAudience().length });
    }

    // —— 店后台连接器：把【收件人 + 行为】映射进现有受众 schema ——
    //   业务映射（工程师可据真实 CRM 字段细化）：行为决定受众分类与可挽回金额
    function recipientToAudience(r, events) {
      const carts = (events || []).filter(e => e.email === r.email && e.type === 'cart_abandoned');
      const bought = (events || []).filter(e => e.email === r.email && e.type === 'purchased');
      const intent = carts.length ? '加购未付' : (bought.length ? '老客' : '浏览未买');
      const abandonedValue = carts.reduce((s, e) => s + (e.value || 0), 0);
      const score = Math.min(0.99, 0.4 + (r.ordersCount || 0) * 0.05 + (carts.length ? 0.3 : 0) + ((r.totalSpent || 0) > 500 ? 0.15 : 0));
      const risk = score > 0.8 ? '高' : score > 0.6 ? '中' : '低';
      const price = (r.totalSpent || 0) > 1000 ? '高' : (r.totalSpent || 0) > 200 ? '中' : '低';
      return {
        id: 'aud_' + (r.id || r.email),
        name: r.name || (r.email || '').split('@')[0],
        email: r.email,
        intent, risk, price,
        score: +score.toFixed(2),
        abandoned_value: +abandonedValue.toFixed(2),
        source: 'store',
        locale: r.locale || null,   // 收件人语种（邮件本地化依据）
        country: r.country || null,
        created_at: Date.now(),
        at_risk_at: Date.now()
      };
    }

    // —— 店后台连接器状态（绝不含密钥/域名）——
    if (pathname === '/api/store/connectors' && method === 'GET') {
      if (!connectors) return sendJson(res, 200, { configured: false, types: [] });
      const health = await connectors.health().catch(e => ({ ok: false, detail: e.message }));
      const meta = await connectors.getShopMeta().catch(() => null);
      return sendJson(res, 200, { configured: true, types: connectors.type === 'multi' ? connectors.connectors.map(c => c.type) : [connectors.type], health, shop: meta });
    }

    // —— 拉取：从已配置店后台读取【用户信息 + 行为】并写入受众（替换种子）——
    if (pathname === '/api/store/pull' && method === 'POST') {
      if (!connectors) return sendJson(res, 400, { configured: false, error: '未接入任何店后台；请在 config.json 配置 shopify 或 stores' });
      const recipients = await connectors.listCustomers({}).catch(e => { throw new Error('拉取用户失败: ' + e.message); });
      const events = await connectors.listBehaviorEvents({}).catch(() => []);
      const audience = recipients.map(r => recipientToAudience(r, events));
      store.replaceAudience(audience);
      // 行为事件落库（供后续归因/KPI）
      for (const e of events) store.addEvent({ type: e.type, audience_id: (audience.find(a => a.email === e.email) || {}).id || null, value: e.value, ts: e.ts });
      logEvent('store_pull', { recipients: audience.length, events: events.length });
      return sendJson(res, 200, { pulled: audience.length, events: events.length, recipients: audience.slice(0, 20), configured: true });
    }

    // —— 配置（密钥只存服务端 .server，绝不回传） ——
    if (pathname === '/api/config' && method === 'POST') {
      const body = await readBody(req);
      if (typeof body.mode === 'string') config.mode = body.mode === 'real' ? 'real' : 'demo';
      if (typeof body.aiKey === 'string') config.aiKey = body.aiKey.trim();
      if (typeof body.espKey === 'string') config.espKey = body.espKey.trim();
      if (typeof body.espFrom === 'string') config.espFrom = body.espFrom.trim();
      if (typeof body.aiModel === 'string') config.aiModel = body.aiModel.trim();
      if (Number.isFinite(body.sendRateLimitPerMin)) config.sendRateLimitPerMin = Math.max(0, Math.min(1000, body.sendRateLimitPerMin | 0));
      if (Number.isFinite(body.attributionWindowDays)) config.attributionWindowDays = Math.max(1, Math.min(60, body.attributionWindowDays | 0));
      if (Number.isFinite(body.emailTimeoutDays)) config.emailTimeoutDays = Math.max(1, Math.min(30, body.emailTimeoutDays | 0));
      cfg.save(config);
      return sendJson(res, 200, { status: cfg.status(config) });
    }

    // —— 归因回执（webhook，真实模式 ESP 回调；支持 open/click + 优惠码核销订单 convert；整改 2：webhook secret 校验）——
    if (pathname === '/api/attribution' && method === 'POST') {
      const whSecret = req.headers['x-webhook-secret'];
      if (!config.webhookSecret || whSecret !== config.webhookSecret) {
        return sendJson(res, 401, { error: 'bad webhook secret' });
      }
      const body = await readBody(req);
      let draftId = body.draft_id || (body.data && body.data.draft_id);
      const type = body.type || (body.event === 'open' ? 'open' : body.event === 'click' ? 'click' : body.event === 'convert' ? 'convert' : 'open');
      // 优惠码核销归因：按 coupon 反查 draft（订单回传）
      if (!draftId && body.coupon) {
        const d = store.getDrafts().find(x => x.coupon === body.coupon);
        if (d) draftId = d.id;
      }
      store.addEvent({ type, draft_id: draftId, audience_id: body.audience_id || null, value: body.value || 0 });
      metricsInc(type === 'convert' ? 'attr_convert' : 'attr_' + type);
      logEvent('attribution', { type, draft_id: draftId, value: body.value || 0 });
      return sendJson(res, 200, { ok: true });
    }

    // —— 监控指标（架构 §7 B6）——
    if (pathname === '/api/metrics' && method === 'GET') {
      const m = loadMetrics();
      const total = m.send_real + m.send_sim || 0;
      return sendJson(res, 200, {
        ...m,
        failRate: total ? +((m.send_fail || 0) / total).toFixed(3) : 0,
        guardrailHitRate: (m.guardrail_L0 + m.guardrail_L2 + m.guardrail_L4 + m.guardrail_L3) || 0
      });
    }

    // —— 重置（整改 1c 安全：本地模式保持原行为清全部+重建种子；登录用户只清自己的 acts/drafts，店铺级 audience/events 无权清）——
    if (pathname === '/api/reset' && method === 'POST') {
      if (req.authMode === 'local') {
        store.reset();
      } else {
        store._write('acts', store._read('acts').filter(a => !a.user_id || a.user_id !== req.userId));
        store._write('drafts', store._read('drafts').filter(d => !d.user_id || d.user_id !== req.userId));
      }
      logEvent('reset', { authMode: req.authMode, userId: req.userId });
      return sendJson(res, 200, { ok: true });
    }

    // —— 导出（整改 1c：只导当前用户 acts/drafts，防泄露他人；audience/events 店铺级共享含店铺数据）——
    if (pathname === '/api/export' && method === 'GET') {
      return sendJson(res, 200, {
        acts: store.getActsByUser(req.userId), drafts: store.getDraftsByUser(req.userId),
        audience: store.getAudience(), events: store.getEvents(), kpis: store.getKpis(config.mode, req.userId)
      });
    }

    return sendJson(res, 404, { error: 'route not found' });
  } catch (e) {
    return sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

const PORT = process.env.PORT || 4173;
server.listen(PORT, () => {
  console.log(`CartBack v3 本地服务已启动: http://localhost:${PORT}`);
  console.log(`模式: ${config.mode} | AI: ${config.aiKey ? '已配置' : '未配置(桩模型)'} | ESP: ${config.espKey ? '已配置' : '仿真'}`);
  console.log(`本地令牌: ${config.localToken}`);
});
