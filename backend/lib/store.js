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
const { migrateAct, mergeMonotonicAct } = require('./needs');

const SCHEMA = {
  acts: {
    id: 'TEXT', stage: 'TEXT', needs: 'JSON', messages: 'JSON',
    status: 'TEXT', created_at: 'INTEGER', updated_at: 'INTEGER',
    user_id: 'TEXT',   // 归属用户（整改 1b）；null/缺失 = 本地模式历史数据
    memory: 'JSON', context_summary: 'JSON',
    summary_cursor: 'INTEGER', context_version: 'INTEGER',
    plan_card: 'JSON',            // Wave 2 D3：confirm 产出的服务端权威 planCard（S3 可回读；S2 改参后作废）
    execution_snapshot: 'JSON',   // Wave 2 D3：confirm 冻结的四字段快照（audience/reach_count/discount/estGmv），闸门⑤ diff 依据
    pending_ops: 'JSON'           // Wave 3 I1/I3：待确认的批次计划 {batches:[...]} / 重发确认 {resend:{...}}（batch_plan 阶段不建 campaigns 行，确认才建）
  },
  drafts: {
    id: 'TEXT', act_id: 'TEXT', subject: 'TEXT', body: 'TEXT', audience: 'JSON',
    discount: 'TEXT', coupon: 'TEXT', posters: 'JSON', status: 'TEXT',
    estGmv: 'REAL', matchedCount: 'INTEGER', sendTiming: 'TEXT',
    created_at: 'INTEGER', sent_at: 'INTEGER', esp_message_id: 'TEXT', cost: 'REAL',
    user_id: 'TEXT', locale: 'TEXT', html: 'TEXT', image_path: 'TEXT',
    image_prompt: 'TEXT',      // 万相出图提示词快照（EditModal 编辑态展示 / 生成图片复用）
    brand: 'TEXT',             // M4 白标：邮件品牌快照（设置页品牌 > 方案卡品牌，创建时固化）
    product: 'TEXT',           // M6 个性化：商品位快照（方案卡 product > 标签画像品类兜底）
    tag_distribution: 'JSON'   // 创建时圈中受众的标签分布快照（卡片展示产品分类/年龄段/机型等代表值）
  },
  audience: {
    id: 'TEXT', name: 'TEXT', email: 'TEXT', intent: 'TEXT', risk: 'TEXT',
    price: 'TEXT', score: 'REAL', abandoned_value: 'REAL', source: 'TEXT', created_at: 'INTEGER',
    locale: 'TEXT', country: 'TEXT',   // UI v4 整改 3：收件人语种/国家（邮件本地化依据，真实源 storeConnector 已带）
    email_status: 'TEXT',              // ⑤ bounced → 'email_invalid' 自动剔除后续名单（保护域名信誉）
    at_risk_at: 'INTEGER',             // ① 进入流失风险的时间（intent 时效分档 / 紧迫度倒计时依据）
    style: 'TEXT',                     // 风格品类 tech/fashion/business/outdoor（style_preference 标签来源）
    gender: 'TEXT',                    // 性别 female/male/other（gender 标签来源）
    age_range: 'TEXT',                 // 年龄段原样 18-24/25-34/35-44/45-54（age_range 标签来源）
    device: 'TEXT',                    // 设备原样如 iPhone 15（device 标签来源）
    customer_segment: 'TEXT'           // 客户分层 new/returning/vip（customer_segment 标签来源）
    // 店铺级共享数据，不做 per-user 隔离（整改 1c 决策）
  },
  events: {
    id: 'TEXT', type: 'TEXT', draft_id: 'TEXT', audience_id: 'TEXT', value: 'REAL', ts: 'INTEGER',
    order_id: 'TEXT',        // ⑤ 订单归因幂等键（Shopify order id；同单只归因一次）
    refunded: 'INTEGER',     // ⑤ orders/update 退款标记：1 = 已扣减，防重复扣
    esp_id: 'TEXT'           // ⑤ Resend message_id → 收件人映射（回执定位 / bounced 剔除）
    // 店铺级共享数据，不做 per-user 隔离（整改 1c 决策）
  },
  // —— PRD v5 新增 4 表（§0.5）——
  audience_tags: {
    // 消费者标签（飞轮资产）；写入来源只有 scoring / attribution / manual，铁律 1：对话绝不写
    id: 'TEXT', audience_id: 'TEXT', tag_type: 'TEXT', tag_value: 'TEXT',
    weight: 'REAL', source: 'TEXT', updated_at: 'INTEGER'
  },
  strategy_cards: {
    // ⑥ 竞品策略卡：学结构不抄文案；raw_email 原文仅存 30 天（G6 purge job 清除，保留卡片）
    id: 'TEXT', user_id: 'TEXT', competitor_name: 'TEXT',
    theme_formula: 'TEXT', angle: 'TEXT', discount_range: 'TEXT',
    timing: 'TEXT', frequency: 'TEXT', visual_style: 'JSON',
    embedding_id: 'TEXT', keywords: 'JSON',
    raw_email: 'TEXT', collected_at: 'INTEGER', created_at: 'INTEGER'
  },
  competitor_sources: {
    // ⑥ 竞品源管理：转发制收集地址 / 手动粘贴来源
    id: 'TEXT', user_id: 'TEXT', name: 'TEXT', mailbox: 'TEXT',
    status: 'TEXT', last_collected_at: 'INTEGER', created_at: 'INTEGER'
  },
  jobs: {
    // 异步任务持久化（队列兜底可见性；执行态在内存驱动，重启后 pending 任务可续跑/标记失败）
    id: 'TEXT', type: 'TEXT', payload: 'JSON', status: 'TEXT',
    dedupe_key: 'TEXT', retry_count: 'INTEGER', max_retries: 'INTEGER',
    result: 'JSON', error: 'TEXT', created_at: 'INTEGER', updated_at: 'INTEGER',
    run_after: 'INTEGER'      // Wave 2 D4①：时段闸缓发的最早执行时间（epoch ms；0/空 = 立即）
  },
  agent_profiles: {
    user_id: 'TEXT', profile: 'JSON', updated_at: 'INTEGER'
  },
  meta: { key: 'TEXT', value: 'TEXT' },
  // —— Wave 2：sends 实发流水（逐收件人逐封，最终态一行，重试幂等更新）——
  sends: {
    id: 'TEXT', act_id: 'TEXT', campaign_id: 'TEXT',
    // campaign_id 语义（Wave 3 I1 起）：批次发送 = campaign.id；单方案草稿 = draft id（无草稿为 NULL）。
    recipient: 'TEXT', template: 'TEXT', tag: 'TEXT', code: 'TEXT',
    tz: 'TEXT', gate_snapshot: 'JSON', at: 'INTEGER', status: 'TEXT'
    // 幂等键 = (campaign_id, recipient)：重试不追加新行，只更新 status/at（PRD Wave 2 契约⑤）
  },
  // —— Wave 2：holdout 对照组（冻结名单绝不写入 sends、不收信、不计挽回）——
  holdouts: {
    id: 'TEXT', act_id: 'TEXT', campaign_id: 'TEXT',
    recipient: 'TEXT', frozen_at: 'INTEGER', ratio: 'REAL', source: 'TEXT'
    // source：单方案发送恒 "single_plan"；批次发送 = "campaign"。
    // campaign_id 语义（Wave 3 I1）：批次发送 = campaign.id；单方案草稿维持 draft id。
    // 幂等键 = (campaign_id, recipient)
  },
  // —— Wave 3 I1 并列批次：campaign = 批次（生命周期长于对话，act closed 后批次照跑）——
  campaigns: {
    id: 'TEXT', act_id: 'TEXT', user_id: 'TEXT',
    name: 'TEXT',            // 人话名（「A 加购未付」），agent 引用它定位批次
    audience_desc: 'TEXT',   // 受众描述（圈人依据，同 matchAudienceByDesc 口径）
    status: 'TEXT',          // draft | scheduled | running | paused | frozen | done
    offer_text: 'TEXT',      // 钩子文案（快照自建批时的 offer）
    percent_off: 'REAL',     // 折扣数值（% off；0 = 无码方案）
    discount: 'JSON',        // { text, code|null, code_status }（契约①形状；改折扣 → 新码覆盖，旧码仅对已发邮件继续有效）
    recipients: 'JSON',      // 净值名单 JSON 列（I4 排除 + 重叠排除之后；sent/pending 一律从 sends/holdouts 派生，不做双记账）
    excluded: 'JSON',        // 排除明细 [{reason, count, at?, emails?}]（核对单逐条展示 + 操作留痕）
    scheduled_at: 'INTEGER', // 排程发送时间（epoch ms；0/空 = 未排程）
    prev_status: 'TEXT',     // 冻结/暂停前的状态（恢复时回滚目标）
    resume_note: 'TEXT',     // 恢复/顺延提示（「黑五过了，B 批次恢复排程…」）
    pause_scope: 'TEXT',     // paused 来源：user（用户手动）| global（紧急全停）| system
    freeze_scope: 'TEXT',    // frozen 来源：calendar（停发日历）| global（紧急全停）
    frozen_reason: 'TEXT',   // 冻结原因（人话）
    brand: 'TEXT',           // 白标品牌快照（闸门③）
    subject: 'TEXT',         // 主题行（重发新批次可换）
    exclusion_override: 'INTEGER', // I4 用户覆盖：1 = 「别排除，就要发」（照发 + 审计留痕）
    gate_note: 'TEXT',       // 最近一次闸门/发送异常备注
    created_at: 'INTEGER', updated_at: 'INTEGER'
  },
  // —— Wave 3 I2 全局停发日历（日期区间；命中停发日的排程发送冻结不删，结束后自动顺延）——
  blackouts: {
    id: 'TEXT', user_id: 'TEXT',
    from: 'INTEGER',         // 起始日 00:00 UTC（epoch ms，含）
    to: 'INTEGER',           // 结束日次日 00:00 UTC（epoch ms，不含）—— 闭开区间，重叠日历取并集
    label: 'TEXT', created_at: 'INTEGER'
  },
  // —— Wave 4 F3 主动回执：notifications（通知中心持久化；前端从通知拉取渲染，不写 act.messages）——
  notifications: {
    id: 'TEXT', user_id: 'TEXT',      // 归属商家（本地模式 null = 共享历史数据）
    type: 'TEXT',                     // 't0'（发送结果）| 't24'（24h 回执汇总）| 'recover'（回流报喜）| 'system'
    title: 'TEXT', body: 'TEXT',
    campaign_id: 'TEXT',              // 批次域：批次发送相关通知指向 campaign.id
    draft_id: 'TEXT',                 // 单方案域：草稿发送相关通知指向 draft id
    act_id: 'TEXT',                   // 关联会话（前端跳转用，可空）
    chips: 'JSON',                    // 建议动作快捷项（如 ['再打一轮','换主题行','先不动']）
    created_at: 'INTEGER', read: 'INTEGER'   // read: 0|1（缺省 0 未读）
  },
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
  /** 关闭底层句柄（测试/优雅退出用；JSON 后端 = flush 落盘） */
  close() { if (this.b && typeof this.b.close === 'function') this.b.close(); }

  // —— acts ——
  // 读取即惰性迁移（PRD v2 契约）：旧 act（needs 纯字符串 / pain 槽名 / memory 缺 extras）
  // 在读出时统一为 {value, source, at} 三态 + pain→reason + 新 memory 字段 + code_status/filled_count 兜底。
  getActs() { return this._read('acts').map(a => migrateAct(a)).sort((a, b) => b.updated_at - a.updated_at); }
  getActsByUser(userId) {   // 整改 1c：按归属过滤；兼容历史 null（本地模式旧数据所有账号可见，认领语义）
    return this._read('acts')
      .filter(a => !a.user_id || a.user_id === userId)
      .map(a => migrateAct(a))
      .sort((a, b) => b.updated_at - a.updated_at);
  }
  getAct(id) {
    const act = this._read('acts').find(a => a.id === id) || null;
    return act ? migrateAct(act) : null;
  }
  upsertAct(act) {
    const rows = this._read('acts');
    const old = rows.find(a => a.id === act.id) || null;
    // PRD v2：写入前迁移新契约 + filled_count 单调不减（旧值已填而新值缺失的槽回填旧值）
    mergeMonotonicAct(act, old);
    const next = rows.filter(a => a.id !== act.id);
    next.push(act); this._write('acts', next); return act;
  }
  deleteAct(id) {
    this._write('acts', this._read('acts').filter(a => a.id !== id));
  }

  // —— Wave 2 closed 触发点：新建会话时把该用户旧的无 closed act 置 stage=closed（只读归档）——
  // 可见性同 getActsByUser 口径：本用户的 act + 无归属的历史 act（本地模式共享语义）。
  closeOpenActs(userId, exceptId) {
    const rows = this._read('acts');
    let n = 0;
    for (const a of rows) {
      if (a.id === exceptId || a.stage === 'closed') continue;
      if (a.user_id && a.user_id !== userId) continue;
      a.stage = 'closed';
      a.updated_at = Date.now();
      n++;
    }
    if (n) this._write('acts', rows);
    return n;
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
  deleteDraft(id) {
    const rows = this._read('drafts');
    const next = rows.filter(x => x.id !== id);
    if (next.length === rows.length) return false;
    this._write('drafts', next); return true;
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

  /** 全量替换受众（拉到真实店后台数据后调用，清掉种子/旧导入）；同步清理孤儿标签 */
  replaceAudience(list) {
    const kept = Array.isArray(list) ? list : [];
    const ids = new Set(kept.map(a => a.id).filter(Boolean));
    this._write('audience', kept);
    // 被替换掉的用户不再有归属，其标签若留在表里会灌水 tagEffect/benchmark 样本
    const tags = this._read('audience_tags');
    const keptTags = tags.filter(t => ids.has(t.audience_id));
    if (keptTags.length !== tags.length) this._write('audience_tags', keptTags);
    return kept;
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
  findEventByOrderId(orderId) {
    if (!orderId) return null;
    return this._read('events').find(e => e.order_id === orderId) || null;
  }
  updateEvent(id, patch) {
    const rows = this._read('events');
    const ev = rows.find(e => e.id === id);
    if (!ev) return null;
    Object.assign(ev, patch, { id: ev.id });
    this._write('events', rows); return ev;
  }

  // —— audience_tags（PRD §0.5；铁律 1：source 只有 scoring/attribution/manual，对话不写）——
  /** 同一 (audience_id, tag_type, tag_value) 唯一；manual 来源不被 scoring/attribution 覆盖 */
  upsertAudienceTag({ audience_id, tag_type, tag_value, weight, source }) {
    if (!audience_id || !tag_type) return null;
    const rows = this._read('audience_tags');
    const w = Math.max(0, Math.min(10, Number(weight) || 0));
    // 铁律 1：manual 是该 tag_type 的权威值——机器来源（scoring/attribution）不得另起新值行覆盖
    if (source !== 'manual') {
      const manualSameType = rows.find(t =>
        t.audience_id === audience_id && t.tag_type === tag_type && t.source === 'manual');
      if (manualSameType) return manualSameType;
    }
    // manual 写入 = 商家手动改值：同 tag_type 的机器行让位（manual 改后不再被覆盖，机器行也无意义）
    if (source === 'manual') {
      const kept = rows.filter(t => !(t.audience_id === audience_id && t.tag_type === tag_type && t.source !== 'manual'));
      rows.length = 0;
      rows.push(...kept);
    }
    const existing = rows.find(t =>
      t.audience_id === audience_id && t.tag_type === tag_type && t.tag_value === (tag_value || ''));
    if (existing) {
      if (existing.source === 'manual' && source !== 'manual') return existing; // manual 不被覆盖
      existing.weight = source === existing.source
        ? Math.max(0, Math.min(10, Math.max(existing.weight, w)))   // 同源取高
        : w;
      existing.source = source;
      existing.updated_at = Date.now();
      this._write('audience_tags', rows);
      return existing;
    }
    const row = {
      id: uid('tag_'), audience_id, tag_type, tag_value: tag_value || '',
      weight: w, source: ['scoring', 'attribution', 'manual'].includes(source) ? source : 'scoring',
      updated_at: Date.now()
    };
    rows.push(row); this._write('audience_tags', rows); return row;
  }
  getAudienceTags(audienceId) {
    return this._read('audience_tags').filter(t => t.audience_id === audienceId);
  }
  getAllAudienceTags() { return this._read('audience_tags'); }
  /** 标签加权（⑤：convert → 全部标签 w += 2；窗口期满未转化 → w −= 0.5；截断 [0,10]；manual 不动） */
  weightAudienceTags(audienceId, delta) {
    const rows = this._read('audience_tags');
    let touched = 0;
    for (const t of rows) {
      if (t.audience_id !== audienceId || t.source === 'manual') continue;
      t.weight = Math.max(0, Math.min(10, +(t.weight + delta).toFixed(2)));
      t.source = 'attribution';
      t.updated_at = Date.now();
      touched++;
    }
    if (touched) this._write('audience_tags', rows);
    return touched;
  }
  deleteAudienceTags(audienceId) {
    this._write('audience_tags', this._read('audience_tags').filter(t => t.audience_id !== audienceId));
  }

  // —— ⑤ bounced 剔除（保护域名信誉）——
  suppressAudienceEmail(audienceId) {
    const rows = this._read('audience');
    const a = rows.find(x => x.id === audienceId);
    if (!a) return null;
    a.email_status = 'email_invalid';
    this._write('audience', rows); return a;
  }

  // —— 页脚退订热区落地：标记后剔除后续发送（与 bounced 剔除同口径）——
  unsubscribeAudienceEmail(audienceId) {
    const rows = this._read('audience');
    const a = rows.find(x => x.id === audienceId);
    if (!a) return null;
    a.email_status = 'unsubscribed';
    this._write('audience', rows); return a;
  }

  // —— strategy_cards（⑥；user_id 隔离）——
  listStrategyCards(userId) {
    return this._read('strategy_cards')
      .filter(c => c.user_id === userId)
      .sort((a, b) => b.created_at - a.created_at);
  }
  upsertStrategyCard(c) {
    c.id = c.id || uid('sc_');
    c.created_at = c.created_at || Date.now();
    const rows = this._read('strategy_cards').filter(x => x.id !== c.id);
    rows.push(c); this._write('strategy_cards', rows); return c;
  }
  getStrategyCard(id) { return this._read('strategy_cards').find(c => c.id === id) || null; }
  deleteStrategyCard(id, userId) {
    this._write('strategy_cards', this._read('strategy_cards').filter(c => !(c.id === id && c.user_id === userId)));
  }
  /** G6：原文仅存 30 天——到期的 raw_email 清空（保留卡片本体），返回清除数量 */
  purgeExpiredRawEmails(maxAgeMs = 30 * 86400000) {
    const rows = this._read('strategy_cards');
    const cutoff = Date.now() - maxAgeMs;
    let n = 0;
    for (const c of rows) {
      if (c.raw_email && (c.collected_at || c.created_at) < cutoff) { c.raw_email = null; n++; }
    }
    if (n) this._write('strategy_cards', rows);
    return n;
  }

  // —— competitor_sources（⑥；user_id 隔离）——
  listCompetitorSources(userId) {
    return this._read('competitor_sources')
      .filter(s => s.user_id === userId)
      .sort((a, b) => b.created_at - a.created_at);
  }
  upsertCompetitorSource(s) {
    s.id = s.id || uid('cs_');
    s.created_at = s.created_at || Date.now();
    const rows = this._read('competitor_sources').filter(x => x.id !== s.id);
    rows.push(s); this._write('competitor_sources', rows); return s;
  }
  getCompetitorSource(id) { return this._read('competitor_sources').find(s => s.id === id) || null; }
  deleteCompetitorSource(id, userId) {
    this._write('competitor_sources', this._read('competitor_sources').filter(s => !(s.id === id && s.user_id === userId)));
  }

  // —— jobs（异步任务持久化；执行由 lib/queue 驱动）——
  /** dedupe_key 命中 pending/running 的同型任务时直接复用（幂等入队） */
  createJob(j) {
    j.id = j.id || uid('job_');
    j.status = j.status || 'pending';
    j.retry_count = j.retry_count || 0;
    j.created_at = j.created_at || Date.now();
    j.updated_at = Date.now();
    if (j.dedupe_key) {
      const dup = this._read('jobs').find(x =>
        x.dedupe_key === j.dedupe_key && ['pending', 'running'].includes(x.status));
      if (dup) return { job: dup, deduped: true };
    }
    const rows = this._read('jobs');
    rows.push(j);
    // 只保留最近 500 条已完成任务，防表无限膨胀
    const done = rows.filter(x => ['done', 'failed'].includes(x.status)).sort((a, b) => b.created_at - a.created_at);
    const keep = new Set(done.slice(0, 500).map(x => x.id));
    this._write('jobs', rows.filter(x => !['done', 'failed'].includes(x.status) || keep.has(x.id)));
    return { job: j, deduped: false };
  }
  getJob(id) { return this._read('jobs').find(j => j.id === id) || null; }
  updateJob(id, patch) {
    const rows = this._read('jobs');
    const j = rows.find(x => x.id === id);
    if (!j) return null;
    Object.assign(j, patch, { id: j.id, updated_at: Date.now() });
    this._write('jobs', rows); return j;
  }
  listPendingJobs() { return this._read('jobs').filter(j => j.status === 'pending'); }

  // —— Wave 2：sends 实发流水（逐收件人逐封；幂等键 campaign_id+recipient，重试不追加新行）——
  /**
   * 记录/更新一行最终态。status ∈ 'sent' | 'failed'（'sending' 为中间态，重试覆盖）。
   * 同 (campaign_id, recipient) 已存在 → 原行更新（gate_snapshot/模板/时区/状态刷新），绝不追加。
   */
  recordSendRow({ act_id, campaign_id, recipient, template, tag, code, tz, gate_snapshot, at, status }) {
    if (!campaign_id || !recipient) return null;
    const rows = this._read('sends');
    const key = String(recipient).toLowerCase();
    const existing = rows.find(r => r.campaign_id === campaign_id && String(r.recipient).toLowerCase() === key);
    const row = existing || { id: uid('snd_'), campaign_id, recipient: key, act_id: act_id || null };
    Object.assign(row, {
      act_id: act_id || row.act_id || null,
      template: template != null ? template : row.template,
      tag: tag != null ? tag : row.tag,
      code: code != null ? code : row.code,
      tz: tz != null ? tz : row.tz,
      gate_snapshot: gate_snapshot != null ? gate_snapshot : row.gate_snapshot,
      at: at || Date.now(),
      status: status || row.status || 'sending'
    });
    if (!existing) rows.push(row);
    this._write('sends', rows);
    return row;
  }
  getSends(filter = {}) {
    let rows = this._read('sends');
    if (filter.campaign_id) rows = rows.filter(r => r.campaign_id === filter.campaign_id);
    if (filter.act_id) rows = rows.filter(r => r.act_id === filter.act_id);
    if (filter.status) rows = rows.filter(r => r.status === filter.status);
    return rows;
  }

  // —— Wave 2：holdout 对照组（冻结一次幂等；成员绝不写入 sends）——
  /** (campaign_id, recipient) 已冻结 → 原行保留（不覆盖 frozen_at），返回是否新冻结 */
  freezeHoldouts({ act_id, campaign_id, recipients, ratio, source, frozen_at }) {
    const list = (Array.isArray(recipients) ? recipients : []).map(r => String(r || '').toLowerCase()).filter(Boolean);
    if (!list.length) return { inserted: 0, members: [] };
    const rows = this._read('holdouts');
    const have = new Set(rows.filter(r => r.campaign_id === campaign_id).map(r => String(r.recipient).toLowerCase()));
    const members = [];
    for (const email of list) {
      if (have.has(email)) continue;
      have.add(email);
      const row = {
        id: uid('hold_'), act_id: act_id || null, campaign_id: campaign_id || null,
        recipient: email, frozen_at: frozen_at || Date.now(),
        ratio: Number(ratio) || 0.1, source: source || 'single_plan'
      };
      rows.push(row); members.push(email);
    }
    if (members.length) this._write('holdouts', rows);
    return { inserted: members.length, members };
  }
  getHoldouts(filter = {}) {
    let rows = this._read('holdouts');
    if (filter.campaign_id) rows = rows.filter(r => r.campaign_id === filter.campaign_id);
    if (filter.act_id) rows = rows.filter(r => r.act_id === filter.act_id);
    return rows;
  }

  // —— Wave 3 I1：campaigns（批次；生命周期长于对话 —— act closed 后批次照跑）——
  getCampaign(id) { return this._read('campaigns').find(c => c.id === id) || null; }
  getCampaignsByUser(userId) {
    // 归属口径与 getDraftsByUser 一致：本用户的批次 + 无归属的历史批次（本地模式共享语义）
    return this._read('campaigns')
      .filter(c => !c.user_id || c.user_id === userId)
      .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));   // 建批顺序（A/B/C 序与重叠归属依据）
  }
  /** 按 act 取批次（Wave 4 F3：actActual 翻转数据聚合用） */
  getCampaignsByAct(actId) {
    return this._read('campaigns').filter(c => c.act_id === actId);
  }
  /** 按折扣码反查批次（Wave 4 F3③：Shopify 订单核销归因到批次 scope；码为店铺级全局，不按用户过滤） */
  findCampaignByCoupon(code) {
    const want = String(code || '').toLowerCase();
    if (!want) return null;
    return this._read('campaigns').find(c => c.discount && c.discount.code && String(c.discount.code).toLowerCase() === want) || null;
  }
  upsertCampaign(c) {
    const rows = this._read('campaigns').filter(x => x.id !== c.id);
    rows.push(c); this._write('campaigns', rows); return c;
  }

  // —— Wave 3 I2：blackouts（停发日历；重叠区间由 campaigns 层取并集判定）——
  getBlackouts() { return this._read('blackouts').sort((a, b) => (a.from || 0) - (b.from || 0)); }
  addBlackout(b) {
    b.id = b.id || uid('blk_');
    b.created_at = b.created_at || Date.now();
    const rows = this._read('blackouts').filter(x => x.id !== b.id);
    rows.push(b); this._write('blackouts', rows); return b;
  }
  deleteBlackout(id) {
    const rows = this._read('blackouts');
    const next = rows.filter(x => x.id !== id);
    if (next.length === rows.length) return false;
    this._write('blackouts', next); return true;
  }

  // —— Wave 4 F3：notifications（主动回执通知中心；created_at 倒序，表上限 200 防膨胀）——
  addNotification(n) {
    n.id = n.id || uid('ntf_');
    n.created_at = n.created_at || Date.now();
    n.read = n.read ? 1 : 0;
    const rows = this._read('notifications');
    rows.push(n);
    // 只保留最近 200 条（按 created_at 降序），过期通知静默丢弃
    if (rows.length > 200) {
      const keep = rows.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 200);
      this._write('notifications', keep);
    } else {
      this._write('notifications', rows);
    }
    return n;
  }
  /** 某商家的通知列表（created_at 倒序；limit 缺省 50，与 GET /api/notifications 契约一致） */
  getNotifications(userId, limit = 50) {
    return this._read('notifications')
      .filter(n => !n.user_id || n.user_id === userId)   // 归属口径与 getActsByUser 一致（历史 null 共享）
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .slice(0, Math.max(1, limit));
  }
  unreadNotificationCount(userId) {
    return this.getNotifications(userId, Infinity).filter(n => !n.read).length;
  }
  /** 标记已读：ids 缺省 = 全部标已读；返回本次标记数 */
  markNotificationsRead(userId, ids) {
    const rows = this._read('notifications');
    const want = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
    let n = 0;
    for (const r of rows) {
      if (r.user_id && userId && r.user_id !== userId) continue;
      if (want && !want.has(String(r.id))) continue;
      if (!r.read) { r.read = 1; n++; }
    }
    if (n) this._write('notifications', rows);
    return n;
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
    const STYLES = ['tech', 'fashion', 'business', 'outdoor'];
    const GENDERS = ['female', 'male', 'female', 'male', 'female', 'male', 'male', 'female', 'male', 'female', 'female', 'male'];
    const AGES = ['18-24', '25-34', '35-44', '45-54', '25-34', '35-44', '18-24', '45-54', '25-34', '35-44', '18-24', '25-34'];
    const DEVICES = ['iPhone 15', 'iPhone 14', 'iPhone 15 Pro Max', 'iPhone 13', 'iPhone 15 Pro', 'iPhone 14', 'iPhone 15', 'iPhone 13', 'iPhone 15 Pro Max', 'iPhone 14', 'iPhone 15', 'iPhone 13'];
    const SEGS = ['new', 'returning', 'vip', 'returning', 'new', 'vip', 'new', 'returning', 'new', 'vip', 'returning', 'new'];
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
        locale: 'en',                       // UI v4 整改 3：种子补 locale（前端邮件卡片「EN · 跟随收件人」）
        style: STYLES[i % 4],                // 风格品类轮转分布（style_preference 标签来源）
        gender: GENDERS[i],                  // 性别轮转（gender 标签来源）
        age_range: AGES[i],                  // 年龄段轮转（age_range 标签来源）
        device: DEVICES[i],                  // 设备轮转（device 标签来源）
        customer_segment: SEGS[i]            // 客户分层轮转（customer_segment 标签来源）
      };
    });
    this._write('audience', seed);
  }

  // —— 老库种子维度回填：schema 升级加了 gender/age_range/device/customer_segment/style 列后，
  //    存量种子行（source=seed）这几列是 NULL（seedAudience 只在表空时跑）。按姓名回填规范值，保 ID 不变。
  backfillSeedDimensions() {
    const DIMS = {
      '林晚': { gender: 'female', age_range: '18-24', device: 'iPhone 15', customer_segment: 'new', style: 'tech' },
      '陈默': { gender: 'male', age_range: '25-34', device: 'iPhone 14', customer_segment: 'returning', style: 'fashion' },
      '苏小': { gender: 'female', age_range: '35-44', device: 'iPhone 15 Pro Max', customer_segment: 'vip', style: 'business' },
      '周野': { gender: 'male', age_range: '45-54', device: 'iPhone 13', customer_segment: 'returning', style: 'outdoor' },
      '何夕': { gender: 'female', age_range: '25-34', device: 'iPhone 15 Pro', customer_segment: 'new', style: 'tech' },
      '顾言': { gender: 'male', age_range: '35-44', device: 'iPhone 14', customer_segment: 'vip', style: 'fashion' },
      '白桥': { gender: 'male', age_range: '18-24', device: 'iPhone 15', customer_segment: 'new', style: 'business' },
      '夏一': { gender: 'female', age_range: '45-54', device: 'iPhone 13', customer_segment: 'returning', style: 'outdoor' },
      '江临': { gender: 'male', age_range: '25-34', device: 'iPhone 15 Pro Max', customer_segment: 'new', style: 'tech' },
      '温言': { gender: 'female', age_range: '35-44', device: 'iPhone 14', customer_segment: 'vip', style: 'fashion' },
      '宋词': { gender: 'female', age_range: '18-24', device: 'iPhone 15', customer_segment: 'returning', style: 'business' },
      '楚河': { gender: 'male', age_range: '25-34', device: 'iPhone 13', customer_segment: 'new', style: 'outdoor' },
    };
    const rows = this._read('audience');
    let changed = false;
    for (const a of rows) {
      if (a.source !== 'seed') continue;
      const d = DIMS[a.name];
      if (d && (a.gender == null || a.style == null)) { Object.assign(a, d); changed = true; }
    }
    if (changed) this._write('audience', rows);
    return changed;
  }

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
    // 分子按草稿去重（一封邮件开/点 N 次仍算 1），与分母「已发送草稿数」同口径 —— 否则打开率能超 100%（走查 P1-2）
    const open = new Set(ev.filter(e => e.type === 'open').map(e => e.draft_id)).size;
    const click = new Set(ev.filter(e => e.type === 'click').map(e => e.draft_id)).size;
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
