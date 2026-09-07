'use strict';
/**
 * ④ 渲染管线测试（PRD §0.2 产品心脏 / §4）
 * 固定顺序：切片 → 变体选择 → 语种渲染(翻译缓存) → 模板本地展开 → G0 拦截
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const render = require('../lib/render');

test('resolveLocale：locale 优先 → country 映射 → en 回落', () => {
  assert.equal(render.resolveLocale({ locale: 'fr-CA' }), 'fr');
  assert.equal(render.resolveLocale({ locale: 'zh_CN' }), 'zh');
  assert.equal(render.resolveLocale({ country: 'DE' }), 'de');
  assert.equal(render.resolveLocale({ country: 'br' }), 'pt');   // 大小写归一
  assert.equal(render.resolveLocale({}), 'en');
  assert.equal(render.resolveLocale({}, 'es'), 'es');
});

test('tierOf 三档映射：价格敏感→discount；intent=hot→urgency；其余→standard', () => {
  const highPrice = render.tierOf({ price: '高' }, [{ tag_type: 'price_sensitivity', tag_value: 'high', weight: 7 }]);
  assert.equal(highPrice, 'discount');
  const hot = render.tierOf({}, [{ tag_type: 'intent', tag_value: 'hot', weight: 8 }]);
  assert.equal(hot, 'urgency');
  const plain = render.tierOf({}, [{ tag_type: 'intent', tag_value: 'cold', weight: 2 }]);
  assert.equal(plain, 'standard');
  // 无标签时按 audience 老字段近似
  assert.equal(render.tierOf({ price: '高', risk: '低' }, []), 'discount');
  assert.equal(render.tierOf({ price: '低', risk: '高' }, []), 'urgency');
  // 高权重 price_sensitivity 压过低权重 intent（折扣主打优先）
  const both = render.tierOf({}, [
    { tag_type: 'price_sensitivity', tag_value: 'high', weight: 7 },
    { tag_type: 'intent', tag_value: 'hot', weight: 9 }
  ]);
  assert.equal(both, 'discount');
});

test('expandTemplate：{{var}} 填充 + 单层 if + 未知变量清空，零 LLM', () => {
  const ctx = { name: 'Lin', coupon: 'BACK12', brand: 'Nova', empty: '' };
  assert.equal(
    render.expandTemplate('Hi {{name}}, use {{coupon}} at {{brand}}', ctx),
    'Hi Lin, use BACK12 at Nova'
  );
  assert.equal(
    render.expandTemplate('{{#if coupon}}Code: {{coupon}}{{/if}}', ctx),
    'Code: BACK12'
  );
  // 空值 if 分支整体剔除
  assert.equal(render.expandTemplate('A {{#if empty}}hidden{{/if}} B', ctx), 'A  B');
  // 未知变量 → 空串（不残留占位符）
  assert.equal(render.expandTemplate('{{unknown}}', ctx), '');
});

test('g0ScanText / g0Intercept：非白名单中文拦截，白名单品牌放行', () => {
  assert.equal(render.g0ScanText('Come back for 12% OFF').blocked, false);
  const zh = render.g0ScanText('Your cart 购物车 is waiting');
  assert.equal(zh.blocked, true);
  assert.deepEqual(zh.hits, ['购物车']);
  // 白名单（含中文品牌名）不拦截
  const wl = render.g0ScanText('老王家的锅 flash sale for you', ['老王家的锅']);
  assert.equal(wl.blocked, false);
  // 白名单外的中文仍然拦截
  const mixed = render.g0ScanText('老王家的锅 限时特惠', ['老王家的锅']);
  assert.equal(mixed.blocked, true);
});

test('g0Intercept：逐字段扫描并标注来源（subject/body/coupon）', () => {
  const r = render.g0Intercept(
    { subject: 'Welcome back', body: '你的购物车 in your cart', couponNote: 'CODE12' },
    []
  );
  assert.equal(r.blocked, true);
  assert.ok(r.hits.some(h => h.startsWith('body:')));
  const clean = render.g0Intercept({ subject: '12% OFF', body: 'Come back', couponNote: 'CODE12' }, []);
  assert.equal(clean.blocked, false);
});

test('renderCampaign 端到端：切片剔除无效/退信地址，逐收件人变体+语种，G0 拦截不发送', async () => {
  const variants = [
    { tier: 'discount', subject: '{{discount}}% OFF for {{name}}', body: 'Hi {{name}}, deal: {{coupon}}' },
    { tier: 'urgency', subject: 'Cart expiring, {{name}}', body: 'Hurry {{name}}' },
    { tier: 'standard', subject: 'Miss you, {{name}}', body: 'Come back {{name}}' }
  ];
  const recipients = [
    { id: 'a1', email: 'a@example.com', name: 'Ann', locale: 'en', price: '高' },
    { id: 'a2', email: 'b@example.com', name: 'Bob', locale: 'de', risk: '高', price: '低' },
    { id: 'a3', email: 'not-an-email', name: 'Bad' },
    { id: 'a4', email: 'c@example.com', name: '中文收件人', email_status: 'email_invalid' },
    { id: 'a5', email: 'd@example.com', name: ' blocked', locale: 'en' }
  ];
  // a5 的变体内容含非白名单中文 → G0 拦截（用 tagsOf 无法触发，直接在变体里验证不了逐人内容；
  // 这里用可注入 translateFn 给 de 语种产出带中文的译文，验证拦截路径）
  const calls = [];
  const result = await render.renderCampaign({
    draft: { id: 'dr_x', coupon: 'BACK12', discount: 12, brand: 'Nova' },
    variants,
    recipients,
    tagsOf: (r) => [],
    whitelist: ['Nova'],
    translateFn: async (text, locale) => {
      calls.push(locale);
      if (locale === 'de') return 'Angebot für 购物车';   // 模拟翻译产出中文（脏译文）
      return text;
    },
    cache: new Map()
  });
  assert.equal(result.stats.total, 5);
  assert.equal(result.stats.excluded, 2);        // 无效邮箱 + email_invalid 被切片剔除
  assert.equal(result.stats.renderable, 3);
  const byEmail = Object.fromEntries(result.messages.map(m => [m.email, m]));
  // a1：price=高 → discount 档，en 直出（无翻译调用）
  assert.equal(byEmail['a@example.com'].tier, 'discount');
  assert.equal(byEmail['a@example.com'].subject, '12% OFF for Ann');
  assert.equal(byEmail['a@example.com'].blocked, false);
  // a2：risk=高 → urgency 档，de 走翻译，脏译文被 G0 拦截
  assert.equal(byEmail['b@example.com'].tier, 'urgency');
  assert.equal(byEmail['b@example.com'].locale, 'de');
  assert.equal(byEmail['b@example.com'].blocked, true);
  assert.ok(byEmail['b@example.com'].g0Hits.length > 0);
  assert.equal(result.stats.blocked, 1);
  assert.equal(result.stats.byTier.discount, 1);
  assert.equal(result.stats.byTier.urgency, 1);
  assert.equal(result.stats.byTier.standard, 1);
});

test('renderLanguage：同 draft 同语言翻译缓存复用（零重复调用）', async () => {
  const cache = new Map();
  let calls = 0;
  const translateFn = async (text) => { calls++; return 'TX:' + text; };
  const v = { tier: 'standard', subject: 'Hello', body: 'Body text' };
  const r1 = await render.renderLanguage(v, 'fr', { translateFn, cache, draftId: 'd1' });
  const r2 = await render.renderLanguage(v, 'fr', { translateFn, cache, draftId: 'd1' });
  assert.equal(calls, 2);           // subject+body 各一次
  assert.equal(r1.subject, 'TX:Hello');
  assert.equal(r2.subject, 'TX:Hello');
  assert.equal(r2.translated, true);
  // 翻译失败 → 回落 en 原文，不抛错
  const r3 = await render.renderLanguage(v, 'ja', { translateFn: async () => { throw new Error('boom'); }, cache, draftId: 'd1' });
  assert.equal(r3.subject, 'Hello');
  // en 直出零调用
  const r4 = await render.renderLanguage(v, 'en', { translateFn, cache, draftId: 'd1' });
  assert.equal(r4.translated, false);
  assert.equal(calls, 2);
});

test('languageDistribution：语言分布统计（UI 语言预览数据源）', () => {
  const dist = render.languageDistribution([
    { email: 'a@x.com', locale: 'en' }, { email: 'b@x.com', locale: 'en-US' },
    { email: 'c@x.com', country: 'DE' }, { email: 'bad' }, { email: 'd@x.com', email_status: 'email_invalid', locale: 'en' }
  ]);
  assert.deepEqual(dist, [{ locale: 'en', count: 2 }, { locale: 'de', count: 1 }]);
});
