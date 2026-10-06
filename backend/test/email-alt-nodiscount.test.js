'use strict';
/**
 * 复测 10-06 P4 回归：无钩子方案 discount=0 时邮件不得出现「0% OFF」假折扣——
 * 正文徽标与 img alt 同源 discountStr；无折扣 alt 退化为品牌名，不留残缺「 - 品牌」格式。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEmailHtml } = require('../dist/email-builder');

test('discount=0（无钩子）不产生 0% OFF 文案或 alt', () => {
  const html = buildEmailHtml({
    subject: 'A reminder from CozyNest',
    body: 'Hi',
    image_url: 'https://example.com/hero.png',
    brand_name: 'CozyNest',
    discount: 0,
    cart_url: 'https://cartback.demo',
    lang: 'en',
  });
  assert.ok(!html.includes('0% OFF'), 'no-hook email must not contain 0% OFF');
  assert.match(html, /alt="CozyNest"/);
  assert.ok(!html.includes('- CozyNest"'), 'alt must not keep a dangling dash prefix');
});

test('正常折扣 alt 形如「30% OFF - 品牌」；discount 缺省同无折扣', () => {
  const withDiscount = buildEmailHtml({
    subject: 's', body: 'b', image_url: 'https://example.com/h.png',
    brand_name: 'NovaHome', discount: 30, cart_url: 'https://x', lang: 'en',
  });
  assert.match(withDiscount, /alt="30% OFF - NovaHome"/);
  const noField = buildEmailHtml({
    subject: 's', body: 'b', image_url: 'https://example.com/h.png',
    brand_name: 'NovaHome', cart_url: 'https://x', lang: 'en',
  });
  assert.ok(!noField.includes('% OFF'));
  assert.match(noField, /alt="NovaHome"/);
});
