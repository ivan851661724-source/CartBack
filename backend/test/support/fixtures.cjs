const { uid } = require('../../lib/store');
const { StoreConnector } = require('../../lib/storeConnector');
class AudienceFixture {
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
        source: 'test_fixture', created_at: Date.now(),
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

}
class MockConnector extends StoreConnector {
  constructor(spec = {}) {
    super(spec);
    this.shop = spec.shop || 'Mock Store';
    this.codes = new Map();
    const seed = spec.codes || { SAVE10: { percent_off: 10 } };
    for (const [code, meta] of Object.entries(seed)) {
      this.codes.set(String(code).toUpperCase(), { percent_off: Number(meta && meta.percent_off) || 10 });
    }
  }
  async health() { return { ok: true, type: 'mock', detail: this.shop }; }
  async getShopMeta() { return { name: this.shop, defaultLocale: 'en', currency: 'USD', domain: 'mock.local' }; }
  supportsDiscountCodes() { return true; }
  async createDiscountCode({ code, percent_off } = {}) {
    if (this.spec.createLatencyMs) await new Promise(r => setTimeout(r, this.spec.createLatencyMs));
    if (this.spec.createFails) throw new Error('mock: 店铺建码失败（HTTP 503）');
    const name = String(code || '').trim().toUpperCase();
    const pct = Number(percent_off);
    if (!name || !Number.isFinite(pct) || pct <= 0) throw new Error('mock: code/percent_off 参数非法');
    if (this.codes.has(name)) throw new Error('mock: 折扣码已存在（' + name + '）');
    this.codes.set(name, { percent_off: pct });
    return { code: name, percent_off: pct, price_rule_id: 'mock_' + name.toLowerCase() }; // 模拟店铺回执
  }
  async verifyDiscountCode(code) {
    const name = String(code || '').trim().toUpperCase();
    const hit = name ? this.codes.get(name) : null;
    return hit ? { code: name, percent_off: hit.percent_off } : null;
  }
  async listCustomers() {
    return [
      { id: 'm1', email: 'alice@example.com', name: 'Alice', locale: 'en', country: 'US', tags: ['vip'], totalSpent: 1200, ordersCount: 5 },
      { id: 'm2', email: 'bob@example.fr', name: 'Bob', locale: 'fr', country: 'FR', tags: [], totalSpent: 80, ordersCount: 1 },
      { id: 'm3', email: 'chen@example.com', name: 'Chen', locale: 'zh', country: 'CN', tags: [], totalSpent: 320, ordersCount: 2 },
      { id: 'm4', email: 'diego@example.es', name: 'Diego', locale: 'es', country: 'ES', tags: [], totalSpent: 0, ordersCount: 0 }
    ];
  }
  async listBehaviorEvents() {
    return [
      { email: 'alice@example.com', type: 'purchased', value: 1200, ts: Date.now() - 86400000 },
      { email: 'bob@example.fr', type: 'cart_abandoned', value: 80, ts: Date.now() - 3600000 },
      { email: 'chen@example.com', type: 'cart_abandoned', value: 320, ts: Date.now() - 7200000 },
      { email: 'diego@example.es', type: 'cart_abandoned', value: 45, ts: Date.now() - 1800000 },
      { email: 'diego@example.es', type: 'browse', value: 0, ts: Date.now() - 900000 }
    ];
  }
}


module.exports={seedAudience:AudienceFixture.prototype.seedAudience,MockConnector};
