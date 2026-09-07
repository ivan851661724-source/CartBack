'use strict';
/**
 * G0 语种拦截专项测试（PRD §4.4 / 闸门 G0：消费者邮件零非白名单中文）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const render = require('../lib/render');

test('G0：主题/正文/优惠码说明全字段扫描', () => {
  const r = render.g0Intercept({
    subject: '限时 12% OFF',
    body: 'Clean body',
    couponNote: 'CODE12'
  }, []);
  assert.equal(r.blocked, true);
  assert.ok(r.hits.includes('subject:限时'));
});

test('G0：中文品牌名白名单放行（商家设置页维护）', () => {
  const text = { subject: '老王家的锅 12% OFF', body: 'Shop 老王家的锅 today', couponNote: 'WANG12' };
  assert.equal(render.g0Intercept(text, []).blocked, true);          // 无白名单 → 拦
  assert.equal(render.g0Intercept(text, ['老王家的锅']).blocked, false); // 白名单 → 放行
});

test('G0：白名单词外的混入中文仍拦截', () => {
  const r = render.g0Intercept({ subject: '老王家的锅 限时特惠', body: '', couponNote: '' }, ['老王家的锅']);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.hits, ['subject:限时特惠']);
});

test('G0：拦截发生在管线末端——blocked 的封不发送（契约）', async () => {
  const result = await render.renderCampaign({
    draft: { id: 'd', coupon: 'C1', discount: 10, brand: 'B' },
    variants: [{ tier: 'standard', subject: '主题行泄漏', body: 'hello' }],
    recipients: [{ id: 'a', email: 'a@x.com', name: 'A', locale: 'en' }],
    whitelist: [],
    translateFn: null
  });
  assert.equal(result.stats.blocked, 1);
  assert.equal(result.messages[0].blocked, true);
  assert.equal(result.messages.filter(m => !m.blocked).length, 0);   // 可发送集合为空
});

test('G0：日文假名/韩文不在拦截范围（只拦 CJK 统一表意文字，按 PRD 口径）', () => {
  // PRD 正则口径 /[\u4e00-\u9fff]/：仅中文表意区。片假名/谚文不在此区间（消费者母语文案不误伤）
  assert.equal(render.g0ScanText('セール 40% OFF').blocked, false);
  assert.equal(render.g0ScanText('세일 40% OFF').blocked, false);
});
