'use strict';
/**
 * 店后台连接器层（Store Connector，架构 §2 B1）
 * ============================================================
 * 职责：从「独立站后台」主动拉取【收件人信息】与【行为事件】，归一化为统一 schema。
 *
 *   收件人 Recipient  : { id, email, name, locale, country, tags, totalSpent, ordersCount }
 *   行为事件 BehaviorEvent: { email, type, value, ts }   type ∈ cart_abandoned|browse|purchased|added_to_cart
 *
 * ⚠️ 关键纠正：邮件语种 **不** 跟「商家配置语言（聊天文字）」走，
 *    而跟「收件人(进店客户)的 locale」走 —— 因为邮件是发给客户的，不是发给商家的。
 *    每个收件人的 locale 必须来自店后台数据（Shopify customer.locale / 国家 / Accept-Language 等），
 *    本层正是 locale 的唯一权威来源。发送时逐收件人本地化见 igde.renderForRecipient。
 *
 * 设计：统一接口 StoreConnector + 具体适配器（Shopify / 通用 REST / Mock）。
 *   多店 = stores 数组，MultiStoreConnector 逐店拉取后按 email 合并去重。
 *   业务细节（OAuth 授权流程、字段精映射、限流）由工程师在对应适配器内补全；
 *   本层给「正确端点结构 + 归一化 + 超时/容错骨架」，不伪造可用的真实调用。
 *
 * Node 22 全局 fetch 可用，无需第三方依赖。
 */

const COUNTRY_LOCALE = {
  US: 'en', GB: 'en', CA: 'en', AU: 'en', NZ: 'en', IE: 'en', ZA: 'en',
  DE: 'de', AT: 'de', CH: 'de', FR: 'fr', BE: 'fr', LU: 'fr',
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', IT: 'it',
  PT: 'pt', BR: 'pt', NL: 'nl', SE: 'sv', NO: 'no', DK: 'da', FI: 'fi',
  JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', HK: 'zh', SG: 'en', MY: 'en',
  RU: 'ru', PL: 'pl', CZ: 'cs', TR: 'tr'
};

/** 把任意 locale / 国家规整成 2 字母语种码；未知 → fallback */
function normalizeLocale(raw, country, fallback = 'en') {
  if (raw && /^[a-z]{2}([_-][A-Za-z]{2})?$/i.test(raw)) {
    return raw.toLowerCase().slice(0, 2);
  }
  if (country && COUNTRY_LOCALE[String(country).toUpperCase()]) {
    return COUNTRY_LOCALE[String(country).toUpperCase()];
  }
  return fallback;
}

/** 带超时的 fetch（Node 全局 fetch + AbortController） */
async function fetchJson(urlStr, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(urlStr, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = { _raw: text }; }
    if (!res.ok) {
      const msg = (json && (json.error_description || json.error || json.errors)) || res.statusText;
      const err = new Error('HTTP ' + res.status + ': ' + JSON.stringify(msg));
      err.status = res.status; err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

class StoreConnector {
  constructor(spec = {}) { this.spec = spec; this.type = spec.type || 'base'; }
  /** 店铺元信息：{ name, defaultLocale, currency, domain } */
  async getShopMeta() { throw new Error('getShopMeta not implemented'); }
  /** 拉收件人：返回 Recipient[] */
  async listCustomers(filter = {}) { throw new Error('listCustomers not implemented'); }
  /** 拉行为事件：返回 BehaviorEvent[] */
  async listBehaviorEvents(filter = {}) { throw new Error('listBehaviorEvents not implemented'); }
  /** 连通性自检：{ ok, type, detail } */
  async health() { throw new Error('health not implemented'); }
  /**
   * Wave 2 E2：真实建码（POST price_rules + discount_code，Admin REST）。
   * @returns { code, percent_off, price_rule_id?, raw? } —— code 必须来自店铺回执，禁止本地拼
   * @throws 创建失败（网络/权限/超时）——调用方捕获后走「不出卡三出口」
   */
  async createDiscountCode() { throw new Error('createDiscountCode not implemented'); }
  /** Wave 2 E2/D4⑤：校验折扣码存在且有效 → { code, percent_off } | null；异常向上抛（闸门⑤视为不过） */
  async verifyDiscountCode() { throw new Error('verifyDiscountCode not implemented'); }
  /** 连接器是否支持折扣码操作（E2 分支判定用） */
  supportsDiscountCodes() { return false; }
}

/* ----------------------------- Shopify 适配器 ----------------------------- */
/**
 * Shopify Admin API（自定义应用 Access Token）。
 * 业务前置（工程师补全）：在店铺后台创建 Custom App → 拿到 Admin API access token。
 * 端点结构已对齐官方 REST Admin API；locale 取自 customer.locale，国家取自 default_address.country_code。
 */
class ShopifyConnector extends StoreConnector {
  constructor(spec = {}) {
    super(spec);
    this.shopDomain = (spec.shopDomain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.apiVersion = spec.apiVersion || '2024-04';
    this.accessToken = spec.accessToken || '';
  }
  _headers() { return { 'X-Shopify-Access-Token': this.accessToken, 'Content-Type': 'application/json' }; }
  _base() { return `https://${this.shopDomain}/admin/api/${this.apiVersion}`; }

  async health() {
    if (!this.shopDomain || !this.accessToken) return { ok: false, type: 'shopify', detail: '缺少 shopDomain 或 accessToken' };
    try { await fetchJson(this._base() + '/shop.json', { headers: this._headers() }); return { ok: true, type: 'shopify', detail: this.shopDomain }; }
    catch (e) { return { ok: false, type: 'shopify', detail: e.message }; }
  }

  async getShopMeta() {
    const j = await fetchJson(this._base() + '/shop.json', { headers: this._headers() });
    const s = j.shop || {};
    return { name: s.name, defaultLocale: normalizeLocale(s.primary_locale, null, 'en'), currency: s.currency, domain: s.domain };
  }

  async listCustomers(filter = {}) {
    const limit = filter.limit || 250;
    const fields = 'id,email,first_name,last_name,locale,default_address,currency,orders_count,total_spent,tags';
    const url = `${this._base()}/customers.json?limit=${limit}&fields=${encodeURIComponent(fields)}`;
    const j = await fetchJson(url, { headers: this._headers() });
    return (j.customers || []).map(c => ({
      id: 'sf_' + c.id,
      email: (c.email || '').toLowerCase(),
      name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim(),
      locale: c.locale || null,
      country: (c.default_address && c.default_address.country_code) || null,
      tags: (c.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      totalSpent: parseFloat(c.total_spent) || 0,
      ordersCount: parseInt(c.orders_count) || 0
    })).filter(r => r.email);
  }

  async listBehaviorEvents(filter = {}) {
    const out = [];
    // 弃购（购物车放弃）→ cart_abandoned，value = 购物车金额
    const chk = await fetchJson(`${this._base()}/checkouts.json?status=open`, { headers: this._headers() }).catch(() => ({ checkouts: [] }));
    for (const c of (chk.checkouts || [])) {
      if (!c.email) continue;
      out.push({ email: c.email.toLowerCase(), type: 'cart_abandoned', value: parseFloat(c.total_price) || 0, ts: Date.parse(c.updated_at) || Date.now() });
    }
    // 已支付订单 → purchased
    const ord = await fetchJson(`${this._base()}/orders.json?status=any&financial_status=paid&limit=250`, { headers: this._headers() }).catch(() => ({ orders: [] }));
    for (const o of (ord.orders || [])) {
      const em = o.email || (o.customer && o.customer.email);
      if (!em) continue;
      out.push({ email: em.toLowerCase(), type: 'purchased', value: parseFloat(o.total_price) || 0, ts: Date.parse(o.processed_at) || Date.now() });
    }
    return out;
  }

  supportsDiscountCodes() { return true; }

  /**
   * E2 真实建码：POST /price_rules.json（percentage 规则）→ POST /price_rules/:id/discount_codes.json。
   * 返回的 code 一律取自店铺回执（ discount_code.code 原样），失败抛错（调用方走三出口）。
   */
  async createDiscountCode({ code, percent_off } = {}) {
    const name = String(code || '').trim().toUpperCase();
    const pct = Number(percent_off);
    if (!name || !Number.isFinite(pct) || pct <= 0 || pct > 90) {
      throw new Error('createDiscountCode: code/percent_off 参数非法');
    }
    const pr = await fetchJson(this._base() + '/price_rules.json', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        price_rule: {
          title: 'CartBack comeback ' + name,
          target_type: 'line_item',
          target_selection: 'all',
          allocation_method: 'across',
          value_type: 'percentage',
          value: -pct,                 // Shopify 口径：折扣为负数
          once_per_customer: true
        }
      })
    });
    const rule = pr && pr.price_rule;
    if (!rule || !rule.id) throw new Error('price_rule 创建失败：' + JSON.stringify(pr).slice(0, 200));
    const dc = await fetchJson(`${this._base()}/price_rules/${rule.id}/discount_codes.json`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ discount_code: { code: name } })
    });
    const created = dc && dc.discount_code;
    if (!created || !created.code) throw new Error('discount_code 创建失败：' + JSON.stringify(dc).slice(0, 200));
    // 真实回执优先：店铺返回的 code（可能被规范化）作为唯一权威
    return { code: String(created.code).toUpperCase(), percent_off: pct, price_rule_id: rule.id, raw: created };
  }

  /** D4⑤ 校验码存在且有效：扫 price_rules + discount_codes（cap 50 条规则，防慢查询），命中返回回执 */
  async verifyDiscountCode(code) {
    const target = String(code || '').trim().toUpperCase();
    if (!target) return null;
    const prs = await fetchJson(this._base() + '/price_rules.json?limit=50', { headers: this._headers() });
    for (const rule of (prs && prs.price_rules) || []) {
      const dc = await fetchJson(`${this._base()}/price_rules/${rule.id}/discount_codes.json?limit=250`, { headers: this._headers() })
        .catch(() => ({ discount_codes: [] }));
      for (const c of (dc && dc.discount_codes) || []) {
        if (String(c.code || '').trim().toUpperCase() === target) {
          const pct = rule.value_type === 'percentage' ? Math.abs(Number(rule.value)) || 0 : 0;
          return { code: target, percent_off: pct, price_rule_id: rule.id };
        }
      }
    }
    return null;
  }
}

/* --------------------------- 通用 REST 适配器 --------------------------- */
/**
 * 通用「独立站」后端：站点自建 REST 接口（或 CSV 导出转 REST）。
 * 通过 spec.fieldMap 把源字段映射到统一 schema，适配多个不同技术栈的独立站。
 *   spec = { type:'rest', baseUrl, apiKey, headers, fieldMap:{ email, name, locale, country, ordersCount, totalSpent, tags } }
 */
class GenericRestConnector extends StoreConnector {
  constructor(spec = {}) {
    super(spec);
    this.baseUrl = (spec.baseUrl || '').replace(/\/$/, '');
    this.apiKey = spec.apiKey || '';
    this.extraHeaders = spec.headers || {};
    this.fm = Object.assign({ email: 'email', name: 'name', locale: 'locale', country: 'country', ordersCount: 'ordersCount', totalSpent: 'totalSpent', tags: 'tags' }, spec.fieldMap || {});
  }
  _headers() { return { 'Authorization': this.apiKey ? 'Bearer ' + this.apiKey : undefined, 'Content-Type': 'application/json', ...this.extraHeaders }; }
  _pick(src, key) { const k = this.fm[key]; return k ? src[k] : undefined; }

  async health() {
    if (!this.baseUrl) return { ok: false, type: 'rest', detail: '缺少 baseUrl' };
    try { await fetchJson(this.baseUrl + '/health', { headers: this._headers() }).catch(() => ({})); return { ok: true, type: 'rest', detail: this.baseUrl }; }
    catch (e) { return { ok: false, type: 'rest', detail: e.message }; }
  }

  async getShopMeta() {
    try {
      const j = await fetchJson(this.baseUrl + '/shop', { headers: this._headers() });
      return { name: j.name, defaultLocale: normalizeLocale(j.defaultLocale, null, 'en'), currency: j.currency, domain: j.domain || this.baseUrl };
    } catch (e) { return { name: this.baseUrl, defaultLocale: 'en', currency: '', domain: this.baseUrl }; }
  }

  async listCustomers(filter = {}) {
    const j = await fetchJson(this.baseUrl + (filter.path || '/customers'), { headers: this._headers() });
    const rows = Array.isArray(j) ? j : (j.customers || j.data || []);
    return rows.map(r => ({
      id: 'rest_' + (this._pick(r, 'email') || Math.random().toString(36).slice(2)),
      email: String(this._pick(r, 'email') || '').toLowerCase(),
      name: this._pick(r, 'name') || '',
      locale: this._pick(r, 'locale') || null,
      country: this._pick(r, 'country') || null,
      tags: Array.isArray(this._pick(r, 'tags')) ? this._pick(r, 'tags') : (this._pick(r, 'tags') || '').toString().split(',').map(t => t.trim()).filter(Boolean),
      totalSpent: parseFloat(this._pick(r, 'totalSpent')) || 0,
      ordersCount: parseInt(this._pick(r, 'ordersCount')) || 0
    })).filter(r => r.email);
  }

  async listBehaviorEvents(filter = {}) {
    const j = await fetchJson(this.baseUrl + (filter.eventsPath || '/events'), { headers: this._headers() });
    const rows = Array.isArray(j) ? j : (j.events || j.data || []);
    return rows.map(e => ({
      email: String(e.email || '').toLowerCase(),
      type: ['cart_abandoned', 'browse', 'purchased', 'added_to_cart'].includes(e.type) ? e.type : 'browse',
      value: parseFloat(e.value) || 0,
      ts: e.ts || Date.parse(e.time) || Date.now()
    })).filter(e => e.email);
  }

  supportsDiscountCodes() { return true; }
  /** 通用 REST 约定：POST /discounts 建码、GET /discounts?code= 校验（自建站按此契约实现） */
  async createDiscountCode({ code, percent_off } = {}) {
    const j = await fetchJson(this.baseUrl + '/discounts', {
      method: 'POST', headers: this._headers(),
      body: JSON.stringify({ code: String(code || '').toUpperCase(), percent_off: Number(percent_off) || 0 })
    });
    if (!j || !j.code) throw new Error('discount 创建失败：' + JSON.stringify(j).slice(0, 160));
    return { code: String(j.code).toUpperCase(), percent_off: Number(j.percent_off) || Number(percent_off) || 0, raw: j };
  }
  async verifyDiscountCode(code) {
    const j = await fetchJson(this.baseUrl + '/discounts?code=' + encodeURIComponent(String(code || '').toUpperCase()), { headers: this._headers() });
    const d = j && (j.discount || j);
    return d && d.code ? { code: String(d.code).toUpperCase(), percent_off: Number(d.percent_off) || 0 } : null;
  }
}

/* ---------------------------- 多店聚合适配器 ---------------------------- */
class MultiStoreConnector extends StoreConnector {
  constructor(connectors = []) { super({ type: 'multi' }); this.connectors = connectors; }
  async getShopMeta() {
    const metas = await Promise.all(this.connectors.map(c => c.getShopMeta().catch(() => null)));
    const first = metas.find(Boolean);
    return first ? { ...first, name: (metas.filter(Boolean).map(m => m.name).join(' + ')) } : { name: 'multi', defaultLocale: 'en', currency: '', domain: '' };
  }
  async health() { return Promise.all(this.connectors.map(c => c.health().catch(e => ({ ok: false, type: c.type, detail: e.message })))); }
  async listCustomers(filter = {}) {
    const lists = await Promise.all(this.connectors.map(c => c.listCustomers(filter).catch(() => [])));
    const seen = new Set(); const out = [];
    for (const list of lists) for (const r of list) {
      const k = r.email.toLowerCase();
      if (seen.has(k)) continue; seen.add(k); out.push(r);
    }
    return out;
  }
  async listBehaviorEvents(filter = {}) {
    const lists = await Promise.all(this.connectors.map(c => c.listBehaviorEvents(filter).catch(() => [])));
    return lists.flat();
  }
  /** 多店：折扣码操作委托给第一个支持的连接器（E2 建码只在主店做，跨店不同步） */
  supportsDiscountCodes() { return this.connectors.some(c => c.supportsDiscountCodes && c.supportsDiscountCodes()); }
  async createDiscountCode(params) {
    const c = this.connectors.find(x => x.supportsDiscountCodes && x.supportsDiscountCodes());
    if (!c) throw new Error('multi: 无支持建码的连接器');
    return c.createDiscountCode(params);
  }
  async verifyDiscountCode(code) {
    const c = this.connectors.find(x => x.supportsDiscountCodes && x.supportsDiscountCodes());
    if (!c) throw new Error('multi: 无支持校验码的连接器');
    return c.verifyDiscountCode(code);
  }
}

/* -------------------------------- 工厂 -------------------------------- */
function createConnector(spec) {
  switch (spec && spec.type) {
    case 'shopify': return new ShopifyConnector(spec);
    case 'rest': return new GenericRestConnector(spec);
    default: throw new Error('未知连接器类型: ' + (spec && spec.type));
  }
}

/**
 * 从服务端配置构建连接器集合。
 * 配置来源（config.json，绝不回传前端）：
 *   config.shopify = { shopDomain, apiVersion, accessToken }
 *   config.stores  = [ { type:'rest', baseUrl, apiKey, fieldMap }, ... ]  // 多个独立站
 * 没有任何配置 → 返回 null（可通过 CSV 导入真实受众）。
 */
function buildConnectors(config) {
  const specs = [];
  if (config && config.shopify && config.shopify.shopDomain && config.shopify.accessToken) {
    specs.push({ type: 'shopify', ...config.shopify });
  }
  if (Array.isArray(config && config.stores)) {
    for (const s of config.stores) if (s && s.type) specs.push(s);
  }
  if (!specs.length) return null;
  if (specs.length === 1) return createConnector(specs[0]);
  return new MultiStoreConnector(specs.map(createConnector));
}

module.exports = {
  StoreConnector, ShopifyConnector, GenericRestConnector, MultiStoreConnector,
  createConnector, buildConnectors, normalizeLocale, COUNTRY_LOCALE,
  fetchJson
};
