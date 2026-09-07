'use strict';
/**
 * 熔断器测试（PRD §0.2 底座：closed → open → half-open 三态，快速失败保护下游）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Breaker, BreakerRegistry, BreakerOpenError } = require('../lib/breaker');

test('breaker：连续失败达阈值 → open 拒绝；冷却期满 half-open 探测成功回 closed', async () => {
  let now = 1_000_000;
  const b = new Breaker('t1', { threshold: 3, cooldownMs: 1000, now: () => now });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => b.exec(async () => { throw new Error('x'); }));
  }
  assert.equal(b.state, 'open');
  // open 态直接拒绝（快速失败，不触达下游）
  await assert.rejects(
    () => b.exec(async () => { throw new Error('should not run'); }),
    (e) => {
      assert.ok(e instanceof BreakerOpenError);
      assert.equal(e.code, 'BREAKER_OPEN');
      assert.ok(e.retryAfterMs > 0);
      return true;
    }
  );
  assert.equal(b.stats.rejected, 1);
  // 冷却期满 → half-open 探测成功 → closed
  now += 1001;
  assert.equal(await b.exec(async () => 'probe-ok'), 'probe-ok');
  assert.equal(b.state, 'closed');
});

test('breaker：half-open 探测失败 → 立即回 open 重新冷却；成功后失败计数清零', async () => {
  let now = 2_000_000;
  const b = new Breaker('t2', { threshold: 2, cooldownMs: 500, now: () => now });
  for (let i = 0; i < 2; i++) await assert.rejects(() => b.exec(async () => { throw new Error('f'); }));
  assert.equal(b.state, 'open');
  now += 501;
  await assert.rejects(() => b.exec(async () => { throw new Error('probe-fail'); }));
  assert.equal(b.state, 'open');
  assert.equal(b.stats.opened, 2);
  now += 501;
  assert.equal(await b.exec(async () => 42), 42);
  assert.equal(b.state, 'closed');
  assert.equal(b.failures, 0);
});

test('breaker：未达阈值成功流零影响；reset() 手动复位', async () => {
  const b = new Breaker('t3', { threshold: 3, cooldownMs: 100 });
  assert.equal(await b.exec(async () => 'a'), 'a');
  await assert.rejects(() => b.exec(async () => { throw new Error('one'); }));
  assert.equal(b.state, 'closed');   // 1 次失败不熔断
  assert.equal(await b.exec(async () => 'b'), 'b');
  b.reset();
  assert.equal(b.failures, 0);
  assert.equal(b.snapshot().state, 'closed');
});

test('breaker registry：多下游独立计数（llm / esp / poster 互不影响）', async () => {
  const reg = new BreakerRegistry({ threshold: 1, cooldownMs: 10 });
  const llm = reg.get('llm');
  const esp = reg.get('esp');
  await assert.rejects(() => llm.exec(async () => { throw new Error('llm down'); }));
  assert.equal(llm.state, 'open');
  assert.equal(esp.state, 'closed');        // esp 不被 llm 连坐
  assert.equal(reg.get('llm'), llm);        // 同名复用同一实例
  assert.equal(reg.snapshotAll().length, 2);
});
