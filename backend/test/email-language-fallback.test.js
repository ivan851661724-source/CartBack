'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEmailHtml } = require('../dist/email-builder');

test('image-free HTML keeps a visible localized cart link without instructions to click an image', () => {
  for (const lang of ['en', 'fr', 'zh', 'pt']) {
    const html = buildEmailHtml({ subject: 'Reminder', body: 'Your order', brand_name: 'NovaBrew', image_url: '', image_link: 'https://shop.example/cart', cart_url: 'https://shop.example/cart', lang });
    assert.match(html, /<a href="https:\/\/shop\.example\/cart"[^>]*>[^<]+<\/a>/);
    assert.doesNotMatch(html, /<img|Tap the image|Touchez l.image|点击上方图片/);
    assert.match(html, lang === 'zh' ? /返回购物车/ : lang === 'fr' ? /Retour au panier/ : /Return to your cart/);
  }
});

test('unsupported explicit languages never add Chinese HTML chrome; Chinese stays localized', () => {
  const base = { subject: 'Hello', body: 'Your order', brand_name: 'NovaBrew', image_url: 'https://example.com/hero.png', cart_url: 'https://example.com/cart' };
  for (const lang of ['pt', 'pt-BR', 'ru', 'ja', 'ko', 'ar', 'unknown']) {
    const html = buildEmailHtml({ ...base, lang });
    assert.doesNotMatch(html, /[\u4e00-\u9fff]/, lang);
    assert.match(html, /The NovaBrew Team/);
  }
  assert.match(buildEmailHtml({ ...base, lang: 'zh-CN' }), /NovaBrew 团队/);
});
