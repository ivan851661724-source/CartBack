'use strict';
/**
 * 数据持久化层（架构 §4 B3）
 * 主存 = 服务端嵌入式 SQLite；若运行环境不支持 node:sqlite，则回退到 JSON 文件。
 * 二者对外暴露同一组「表级」原语（readTable / writeTable），上层逻辑用 JS 数组操作，
 * 因此无论用哪个后端，业务代码一致；清空浏览器缓存也不会丢数据（数据在服务端）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const SCHEMA = {
  acts: {
    id: 'TEXT', stage: 'TEXT', needs: 'JSON', messages: 'JSON',
    status: 'TEXT', created_at: 'INTEGER', updated_at: 'INTEGER',
    user_id: 'TEXT',   // 归属用户（整改 1b）；null/缺失 = 本地模式历史数据
    memory: 'JSON', context_summary: 'JSON',
    summary_cursor: 'INTEGER', context_version: 'INTEGER'
  },
  drafts: {
    id: 'TEXT', act_id: 'TEXT', subject: 'TEXT', body: 'TEXT', audience: 'JSON',
    discount: 'TEXT', coupon: 'TEXT', posters: 'JSON', status: 'TEXT',
    estGmv: 'REAL', matchedCount: 'INTEGER', sendTiming: 'TEXT',
    created_at: 'INTEGER', sent_at: 'INTEGER', esp_message_id: 'TEXT', cost: 'REAL',
    user_id: 'TEXT', locale: 'TEXT', html: 'TEXT', image_path: 'TEXT'
  },
  audience: {
    id: 'TEXT', name: 'TEXT', email: 'TEXT', intent: 'TEXT', risk: 'TEXT',
    price: 'TEXT', score: 'REAL', abandoned_value: 'REAL', source: 'TEXT', created_at: 'INTEGER',
    locale: 'TEXT', country: 'TEXT'   // UI v4 整改 3：收件人语种/国家（邮件本地化依据，真实源 storeConnector 已带）
    // 店铺级共享数据，不做 per-user 隔离（整改 1c 决策：audience/events 保持全局）
  },
  events: {
    id: 'TEXT', type: 'TEXT', draft_id: 'TEXT', audience_id: 'TEXT', value: 'REAL', ts: 'INTEGER'
    // 店铺级共享数据，不做 per-user 隔离（整改 1c 决策）
  },
  agent_profiles: {
    user_id: 'TEXT', profile: 'JSON', updated_at: 'INTEGER'
  },
  meta: { key: 'TEXT', value: 'TEXT' },
  // —— 用户账号体系（架构方案 v4 D7/D8）——
  // users/sessions 为全局表，行级语义；当前单进程下「读全表→过滤→写回」安全（读写间无 await），
  // 多实例部署必须改行级 SQL（insertRow/updateRow/deleteRow），否则并发互相覆盖丢数据（整改 6）。
  users: {
    id: 'TEXT', email: 'TEXT', name: 'TEXT', password_hash: 'TEXT',
    status: 'TEXT', created_at: 'INTEGER'
  },
  sessions: {
    id: 'TEXT', token_hash: 'TEXT', user_id: 'TEXT', created_at: 'INTEGER'
  }
};

const TABLES = Object.keys(SCHEMA);
const JSON_COLS = {};
for (const t of TABLES) JSON_COLS[t] = Object.keys(SCHEMA[t]).filter(c => SCHEMA[t][c] === 'JSON');

function uid(p) { return (p || '') + crypto.randomBytes(6).toString('hex'); }

// 类目挽回率基准（PRD §5① / 算法 v1 环节①：预估可挽回 GMV = 弃购金额 × 类目挽回率基准；
// 具体权重与基准待细化，此处取合理默认并全程标注「预估/示意」）
const RECOVERY_WINDOW_DAYS = 30; // 挽回窗口（算法 v1 环节①）
const RECOVERY_RATE = {
  '加购未付': 0.42, '弃购': 0.35, '下单未付': 0.30,
  '浏览未买': 0.18, '沉睡': 0.25, '流失': 0.25
};
function recoveryRate(intent) {
  const t = (intent || '');
  if (/加购/.test(t)) return RECOVERY_RATE['加购未付'];
  if (/弃购/.test(t)) return RECOVERY_RATE['弃购'];
  if (/下单未付|未付/.test(t)) return RECOVERY_RATE['下单未付'];
  if (/浏览/.test(t)) return RECOVERY_RATE['浏览未买'];
  if (/沉睡/.test(t)) return RECOVERY_RATE['沉睡'];
  if (/流失/.test(t)) return RECOVERY_RATE['流失'];
  return 0.25;
}

// 缓存配置读取（取归因窗口 / 超时天数等）
let _cfg;
function appCfg() { if (!_cfg) _cfg = cfg.load(); return _cfg; }

/* ---------------- SQLite 后端 ---------------- */
function SqliteBackend(dbFile) {
  const sqlite = require('node:sqlite');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  for (const t of TABLES) {
    const cols = Object.keys(SCHEMA[t])
      .map(c => '`' + c + '` ' + (SCHEMA[t][c] === 'JSON' ? 'TEXT' : SCHEMA[t][c])).join(', ');
    db.exec(`CREATE TABLE IF NOT EXISTS \`${t}\` (${cols});`);
    // 迁移：补齐历史库缺失列（schema 演进不破坏既有数据）
    const existing = new Set(db.prepare(`PRAGMA table_info(\`${t}\`)`).all().map(r => r.name));
    for (const c of Object.keys(SCHEMA[t])) {
      if (!existing.has(c)) {
        const type = SCHEMA[t][c] === 'JSON' ? 'TEXT' : SCHEMA[t][c];
        db.exec(`ALTER TABLE \`${t}\` ADD COLUMN \`${c}\` ${type}`);
      }
    }
  }
  return {
    kind: 'sqlite',
    readTable(name) {
      const rows = db.prepare(`SELECT * FROM \`${name}\``).all();
      for (const r of rows) for (const c of JSON_COLS[name]) {
        if (r[c] != null) try { r[c] = JSON.parse(r[c]); } catch (e) { r[c] = null; }
      }
      return rows;
    },
    writeTable(name, rows) {
      const cols = Object.keys(SCHEMA[name]);
      const ph = cols.map((c, i) => ':p' + i).join(',');
      const stmt = db.prepare(
        `INSERT INTO \`${name}\` (${cols.map(c => '`' + c + '`').join(',')}) VALUES (${ph})`
      );
      db.exec('BEGIN');
      try {
        db.prepare(`DELETE FROM \`${name}\``).run();
        for (const row of rows) {
          const params = {};
          cols.forEach((c, i) => {
            const v = row[c];
            params['p' + i] = JSON_COLS[name].includes(c) ? (v == null ? null : JSON.stringify(v)) : (v == null ? null : v);
          });
          stmt.run(params);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    close() { db.close(); }
  };
}

/* ---------------- JSON 文件后端（兜底） ---------------- */
function JsonBackend(file) {
  let data = {};
  for (const t of TABLES) data[t] = [];
  if (fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
    for (const t of TABLES) if (!Array.isArray(data[t])) data[t] = [];
  }
  const flush = () => fs.writeFileSync(file, JSON.stringify(data));
  return {
    kind: 'json',
    readTable(name) { return data[name] || []; },
    writeTable(name, rows) { data[name] = rows; flush(); },
    close() { flush(); }
  };
}

/* ---------------- Store（业务层） ---------------- */
class Store {
  constructor(opts = {}) {
    this.b = null;
    this.file = opts.dbFile || cfg.DB_FILE;
  }
  init() {
    if (this.b) return;
    try {
      this.b = SqliteBackend(this.file);
    } catch (e) {
      console.warn('[store] node:sqlite 不可用，回退 JSON 文件存储：', e.message);
      this.b = JsonBackend(this.file.replace(/\.sqlite$/, '.json'));
    }
    if (this.b.readTable('audience').length === 0) this.seedAudience();
  }
  // —— 通用表读写 ——
  _read(t) { return this.b.readTable(t); }
  _write(t, rows) { this.b.writeTable(t, rows); }

  // —— acts ——
  getActs() { return this._read('acts').sort((a, b) => b.updated_at - a.updated_at); }
  getActsByUser(userId) {   // 整改 1c：按归属过滤；兼容历史 null（本地模式旧数据所有账号可见，认领语义）
    return this._read('acts')
      .filter(a => !a.user_id || a.user_id === userId)
      .sort((a, b) => b.updated_at - a.updated_at);
  }
  getAct(id) { return this._read('acts').find(a => a.id === id) || null; }
  upsertAct(act) {
    const rows = this._read('acts').filter(a => a.id !== act.id);
    rows.push(act); this._write('acts', rows); return act;
  }
  deleteAct(id) {
    this._write('acts', this._read('acts').filter(a => a.id !== id));
  }

  // —— 每用户一份简单长期资料（MVP；多店铺作用域后续再扩展） ——
  getAgentProfile(userId) {
    if (!userId) return {};
    const row = this._read('agent_profiles').find(item => item.user_id === userId);
    return row && row.profile && typeof row.profile === 'object' ? row.profile : {};
  }
  upsertAgentProfile(userId, profile) {
    if (!userId) return null;
    const rows = this._read('agent_profiles').filter(item => item.user_id !== userId);
    const row = { user_id: userId, profile: profile || {}, updated_at: Date.now() };
    rows.push(row); this._write('agent_profiles', rows); return row;
  }
  deleteAgentProfile(userId) {
    if (!userId) return;
    this._write('agent_profiles', this._read('agent_profiles').filter(item => item.user_id !== userId));
  }

  // —— drafts ——
  getDrafts() { return this._read('drafts').sort((a, b) => b.created_at - a.created_at); }
  getDraftsByUser(userId) {   // 整改 1c
    return this._read('drafts')
      .filter(d => !d.user_id || d.user_id === userId)
      .sort((a, b) => b.created_at - a.created_at);
  }
  getDraft(id) { return this._read('drafts').find(d => d.id === id) || null; }
  upsertDraft(d) {
    const rows = this._read('drafts').filter(x => x.id !== d.id);
    rows.push(d); this._write('drafts', rows); return d;
  }

  // —— audience ——
  getAudience() {
    const now = Date.now();
    return this._read('audience')
      .map(a => {
        const rate = recoveryRate(a.intent);
        const daysAtRisk = Math.max(0, Math.floor((now - (a.at_risk_at || a.created_at)) / 86400000));
        const urgencyDays = Math.max(0, RECOVERY_WINDOW_DAYS - daysAtRisk);
        const last = a.at_risk_at || a.created_at || now;
        const diffMin = Math.floor((now - last) / 60000);
        const age = diffMin < 60 ? diffMin + ' 分钟前' : diffMin < 1440 ? Math.floor(diffMin / 60) + ' 小时前' : Math.floor(diffMin / 1440) + ' 天前';   // UI v4 整改 3：最近动作
        return {
          ...a,
          estGmv: +(a.abandoned_value * rate).toFixed(2), // 预估可挽回 GMV（标注预估）
          urgencyDays, // 紧迫度倒计时（挽回窗口内剩余天数）
          age          // UI v4 整改 3：最近动作（前端机会行展示）
        };
      })
      .sort((a, b) => b.estGmv - a.estGmv);   // UI v4 整改 3：按预估回流价值降序（「谁最值得捞一眼可见」）
  }
  addAudience(list) {
    const rows = this._read('audience');
    for (const a of list) {
      a.id = a.id || uid('aud_');
      a.created_at = a.created_at || Date.now();
      a.at_risk_at = a.at_risk_at || a.created_at;
      a.source = a.source || 'import';
      rows.push(a);
    }
    this._write('audience', rows);
    return list;
  }
  clearImportedAudience() {
    this._write('audience', this._read('audience').filter(a => a.source === 'seed'));
  }

  /** 全量替换受众（拉到真实店后台数据后调用，清掉种子/旧导入） */
  replaceAudience(list) {
    this._write('audience', Array.isArray(list) ? list : []);
    return list;
  }

  // —— events ——
  addEvent(e) {
    e.id = e.id || uid('ev_');
    e.ts = e.ts || Date.now();
    const rows = this._read('events'); rows.push(e); this._write('events', rows);
    return e;
  }
  getEvents(filter) {
    let rows = this._read('events');
    if (filter && filter.draft_id) rows = rows.filter(r => r.draft_id === filter.draft_id);
    return rows;
  }

  // —— meta ——
  getMeta(key) { const r = this._read('meta').find(m => m.key === key); return r ? r.value : null; }
  setMeta(key, value) {
    const rows = this._read('meta').filter(m => m.key !== key);
    rows.push({ key, value: String(value) }); this._write('meta', rows);
  }

  // —— users（行级操作；禁止全表 writeTable，防止跨用户清空） ——
  getUserByEmail(email) { return this._read('users').find(u => u.email === String(email || '').toLowerCase()) || null; }
  getUserById(id) { return this._read('users').find(u => u.id === id) || null; }
  listUsers() { return this._read('users'); }
  createUser(u) {
    u.id = u.id || uid('usr_');
    u.email = String(u.email || '').toLowerCase();
    u.status = u.status || 'active';
    u.created_at = u.created_at || Date.now();
    const rows = this._read('users').filter(x => x.id !== u.id && x.email !== u.email);
    rows.push(u); this._write('users', rows); return u;
  }
  updateUser(id, patch) {
    const rows = this._read('users');
    const u = rows.find(x => x.id === id);
    if (!u) return null;
    Object.assign(u, patch, { id: u.id, email: u.email, created_at: u.created_at });
    this._write('users', rows); return u;
  }

  // —— sessions（行级操作；云存档永久，无过期字段，登出删行即失效） ——
  findSessionByTokenHash(hash) { return this._read('sessions').find(s => s.token_hash === hash) || null; }
  createSession(s) {
    s.id = s.id || uid('ses_');
    s.created_at = s.created_at || Date.now();
    const rows = this._read('sessions'); rows.push(s); this._write('sessions', rows); return s;
  }
  deleteSession(id) { this._write('sessions', this._read('sessions').filter(s => s.id !== id)); }
  deleteSessionsByUser(userId) { this._write('sessions', this._read('sessions').filter(s => s.user_id !== userId)); }

  // —— 假种子受众（P0 真实源未接前的占位，§5①） ——
  seedAudience() {
    const seed = [
      ['林晚','wan.lin@example.com','加购未付','高','高',0.92,1280],
      ['陈默','mo.chen@example.com','弃购','高','中',0.88,860],
      ['苏小','xiao.su@example.com','浏览未买','中','高',0.71,540],
      ['周野','ye.zhou@example.com','下单未付','高','低',0.85,1990],
      ['何夕','xi.he@example.com','加购未付','中','中',0.69,720],
      ['顾言','yan.gu@example.com','弃购','中','高',0.74,430],
      ['白桥','qiao.bai@example.com','浏览未买','低','中',0.55,310],
      ['夏一','yi.xia@example.com','加购未付','高','高',0.90,1120],
      ['江临','lin.jiang@example.com','弃购','中','低',0.66,650],
      ['温言','yan.wen@example.com','下单未付','高','中',0.83,1560],
      ['宋词','ci.song@example.com','浏览未买','低','高',0.52,280],
      ['楚河','he.chu@example.com','加购未付','中','中',0.70,940]
    ].map(([name, email, intent, risk, price, score, abandoned_value], i) => {
      const atRiskDaysAgo = (i * 2) % 25; // 0~24 天前进入流失风险，制造紧迫度梯度
      return {
        id: uid('aud_'), name, email, intent, risk, price, score, abandoned_value,
        source: 'seed', created_at: Date.now(),
        at_risk_at: Date.now() - atRiskDaysAgo * 86400000,
        locale: 'en'   // UI v4 整改 3：种子补 locale（前端邮件卡片「EN · 跟随收件人」）
      };
    });
    this._write('audience', seed);
  }

  // —— KPI 汇总（数据模块，真实/演示分离由调用方控制标注；整改 1c：userId 过滤只统计本人 drafts） ——
  getKpis(mode, userId) {
    this.refreshDraftStates(userId); // FSM 超时态写回（sent → recovering/timeout）
    const drafts = userId ? this.getDraftsByUser(userId) : this.getDrafts();
    const events = this.getEvents();
    const audience = this.getAudience();
    const windowDays = (appCfg().attributionWindowDays) || 7;
    const windowMs = windowDays * 86400000;
    const sent = drafts.filter(d => ['sent', 'recovering'].includes(d.status));
    const sentIds = new Set(sent.map(d => d.id));
    const sentAt = {}; sent.forEach(d => { sentAt[d.id] = d.sent_at || d.created_at; });
    const ev = events.filter(e => sentIds.has(e.draft_id));
    const open = ev.filter(e => e.type === 'open').length;
    const click = ev.filter(e => e.type === 'click').length;
    // 归因窗口：仅计「点击/发送后 N 天内」的转化（PRD §5⑤ / 算法 v1 环节⑤）
    const convert = ev.filter(e => e.type === 'convert' && (e.ts - (sentAt[e.draft_id] || e.ts)) <= windowMs);
    const gmv = convert.reduce((s, e) => s + (e.value || 0), 0);
    const cost = sent.reduce((s, d) => s + (d.cost || 0), 0);
    const roi = cost > 0 ? gmv / cost : 0;
    const failed = drafts.filter(d => d.status === 'failed').length;
    const timeout = drafts.filter(d => d.status === 'timeout').length;
    const recovering = drafts.filter(d => d.status === 'recovering').length;
    const estTotal = audience.reduce((s, a) => s + (a.estGmv || 0), 0); // 全量预估可挽回 GMV
    return {
      audienceSize: audience.length,
      sent: sent.length, recovering, open, click, convert: convert.length,
      openRate: sent.length ? +(open / sent.length).toFixed(3) : 0,
      clickRate: sent.length ? +(click / sent.length).toFixed(3) : 0,
      convertRate: sent.length ? +(convert.length / sent.length).toFixed(3) : 0,
      gmv: +gmv.toFixed(2),
      cost: +cost.toFixed(2),
      roi: +roi.toFixed(2),
      estTotal: +estTotal.toFixed(2),
      failed, timeout,
      mode
    };
  }

  /** 本周聚合（UI v4 整改 2：叙事条「本周回流营收/ROI/花费/净赚」）；口径=近 windowMs 内发送的草稿 */
  getKpisWeek(mode, userId, windowMs = 7 * 86400000) {
    const now = Date.now();
    const drafts = (userId ? this.getDraftsByUser(userId) : this.getDrafts())
      .filter(d => d.sent_at && now - d.sent_at <= windowMs);
    const sent = drafts.length;
    const cost = +drafts.reduce((s, d) => s + (+d.cost || 0), 0).toFixed(2);
    const gmv = +drafts.reduce((s, d) => s + (+d.estGmv || 0), 0).toFixed(2);
    return { sent, cost, gmv, roi: cost ? +(gmv / cost).toFixed(2) : 0 };
  }

  /** 邮件生命周期 FSM 超时态写回：sent → recovering（有转化）/ timeout（超窗口未打开）；整改 1c：按用户范围 */
  refreshDraftStates(userId) {
    const now = Date.now();
    const timeoutMs = ((appCfg().emailTimeoutDays) || 3) * 86400000;
    const list = userId ? this.getDraftsByUser(userId) : this.getDrafts();
    for (const d of list) {
      if (d.status !== 'sent') continue;
      const evs = this.getEvents({ draft_id: d.id });
      const hasConvert = evs.some(e => e.type === 'convert');
      const hasOpen = evs.some(e => e.type === 'open');
      const ageMs = now - (d.sent_at || d.created_at);
      let ns = null;
      if (hasConvert) ns = 'recovering';
      else if (!hasOpen && ageMs > timeoutMs) ns = 'timeout';
      if (ns && ns !== d.status) { d.status = ns; this.upsertDraft(d); }
    }
  }

  /** 7 日趋势：按发送日聚合 gmv / sent；整改 1c：按用户范围 */
  getTrend(userId) {
    const drafts = (userId ? this.getDraftsByUser(userId) : this.getDrafts()).filter(d => d.sent_at);
    const days = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days[key] = { date: key, sent: 0, gmv: 0 };
    }
    for (const dr of drafts) {
      const key = new Date(dr.sent_at).toISOString().slice(0, 10);
      if (days[key]) days[key].sent++;
    }
    const events = this.getEvents().filter(e => e.type === 'convert');
    for (const e of events) {
      const key = new Date(e.ts).toISOString().slice(0, 10);
      if (days[key]) days[key].gmv += (e.value || 0);
    }
    return Object.values(days);
  }

  reset() {
    for (const t of TABLES) this._write(t, []);
    this.seedAudience();
  }
}

module.exports = { Store, uid };
