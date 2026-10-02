'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../lib/store');
const { migrateNeeds, migrateAct, mergeMonotonicAct, plainNeeds, countFilled } = require('../lib/needs');
const config = require('../lib/config');

// Windows 下 SQLite WAL 文件句柄释放略滞后于 close()，立即 rmSync 会偶发 EPERM：
// 用 maxRetries 让 fs.rm 自带重试（对 EPERM/EBUSY 生效）
const RM_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

test('act context state round-trips through the configured store backend', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-store-context-'));
  const store = new Store({ dbFile: path.join(dir, 'context.sqlite') });
  store.init();
  // 单钩子保证顺序：先关 SQLite 句柄再删目录（Windows 下打开中的文件不可删）
  t.after(() => {
    try { if (store.b) store.b.close(); } catch (e) { /* 已关闭 */ }
    fs.rmSync(dir, RM_OPTS);
  });

  store.upsertAct({
    id: 'act_context', stage: 'S1', needs: { audience: '加购未付客户' },
    messages: [{ role: 'user', content: '我卖跑鞋' }], status: 'active',
    created_at: 1, updated_at: 2, user_id: 'user_1',
    memory: { facts: [{ key: 'product', value: '跑鞋' }], decisions: [], corrections: [] },
    context_summary: { version: 1, through: 10, userNotes: ['主营跑鞋'] },
    summary_cursor: 10, context_version: 1
  });

  const loaded = store.getAct('act_context');
  assert.equal(loaded.memory.facts[0].value, '跑鞋');
  assert.equal(loaded.context_summary.through, 10);
  assert.equal(loaded.summary_cursor, 10);
  assert.equal(loaded.context_version, 1);
});

test('agent context defaults are explicit and safe', () => {
  assert.ok(config.DEFAULTs.aiContextWindowTokens >= 8192);
  assert.ok(config.DEFAULTs.aiMaxOutputTokens >= 256);
  assert.ok(config.DEFAULTs.aiContextSafetyMargin >= 512);
  assert.ok(config.DEFAULTs.aiRecentTurns >= 8);
  assert.equal(config.DEFAULTs.aiCriticMode, 'suspicious');
  assert.ok(config.DEFAULTs.aiMaxCallsPerTurn >= 2);
});

test('agent profiles are isolated by user and can be cleared', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-store-profile-'));
  const store = new Store({ dbFile: path.join(dir, 'profile.sqlite') });
  store.init();
  t.after(() => {
    try { if (store.b) store.b.close(); } catch (e) { /* 已关闭 */ }
    fs.rmSync(dir, RM_OPTS);
  });

  store.upsertAgentProfile('user_a', { product: '跑鞋' });
  store.upsertAgentProfile('user_b', { product: '手表' });
  assert.equal(store.getAgentProfile('user_a').product, '跑鞋');
  assert.equal(store.getAgentProfile('user_b').product, '手表');
  store.deleteAgentProfile('user_a');
  assert.deepEqual(store.getAgentProfile('user_a'), {});
  assert.equal(store.getAgentProfile('user_b').product, '手表');
});

// —— PRD v2 契约迁移（B-1）：旧字符串 needs / pain 槽名 → 三态对象 / reason ——
test('migrateNeeds maps legacy string needs and renames pain to reason', () => {
  const now = 1700000000000;
  const legacy = { audience: '加购未付客户', pain: '太久没动静', goal: '', offer: '9折优惠' };
  const migrated = migrateNeeds(legacy, now);
  assert.deepEqual(migrated, {
    audience: { value: '加购未付客户', source: 'explicit', at: now },
    reason: { value: '太久没动静', source: 'explicit', at: now },   // pain → reason
    offer: { value: '9折优惠', source: 'explicit', at: now },
    goal: null                                                        // 空串 → null，四槽键齐全
  });
  // 新契约幂等：已是三态对象的原样保留
  const modern = migrateNeeds(migrated, now + 1);
  assert.deepEqual(modern, migrated);
  // 空/异常输入 → 全 null 模板
  assert.deepEqual(migrateNeeds(null, now), { audience: null, reason: null, offer: null, goal: null });
  assert.deepEqual(plainNeeds(migrated), { audience: '加购未付客户', reason: '太久没动静', offer: '9折优惠', goal: '' });
});

test('legacy act round-trips through the store with lazy migration', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-store-migrate-'));
  const store = new Store({ dbFile: path.join(dir, 'migrate.sqlite') });
  store.init();
  t.after(() => {
    try { if (store.b) store.b.close(); } catch (e) { /* 已关闭 */ }
    fs.rmSync(dir, RM_OPTS);
  });

  // 直接写一行旧契约 act（绕过 upsertAct 的迁移，模拟老库存量数据）
  store._write('acts', [{
    id: 'act_legacy', stage: 'S1',
    needs: { audience: '弃购客户', pain: '太久没动静、快被遗忘' },   // 旧：字符串 + pain 槽名
    messages: [], memory: { facts: [], decisions: [], corrections: [] },
    status: 'active', created_at: 1, updated_at: 2, user_id: null
  }]);

  const loaded = store.getAct('act_legacy');
  // 读出即惰性迁移
  assert.equal(loaded.needs.reason.value, '太久没动静、快被遗忘', 'pain → reason 惰性迁移');
  assert.equal(loaded.needs.audience.value, '弃购客户');
  assert.equal(loaded.needs.audience.source, 'explicit');
  assert.equal(loaded.needs.offer, null);
  assert.equal(loaded.code_status, 'none', 'code_status 兜底 none');
  assert.equal(loaded.filled_count, 2, 'filled_count 兜底计算');
  assert.ok(Array.isArray(loaded.memory.extras), 'memory.extras 兜底');
  assert.deepEqual(loaded.memory.ask_count, { audience: 0, reason: 0, offer: 0, goal: 0 });
  // 再走一次 upsert（新契约写入）→ 迁移幂等且不回退
  store.upsertAct(loaded);
  const reloaded = store.getAct('act_legacy');
  assert.equal(reloaded.needs.reason.value, '太久没动静、快被遗忘');
  assert.equal(reloaded.filled_count, 2);
});

test('filled_count is monotonic: a downgrade turn keeps previously filled slots', () => {
  const now = 1700000000000;
  const old = {
    id: 'act_mono', stage: 'S1',
    needs: {
      audience: { value: '加购未付客户', source: 'explicit', at: now },
      reason: { value: '太久没动静', source: 'explicit', at: now },
      offer: null, goal: null
    },
    memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 }, conflicts: [] },
    filled_count: 2, code_status: 'none'
  };
  // 恶意/异常的降级轮：audience/reason 被清空
  const downgraded = {
    id: 'act_mono', stage: 'S1',
    needs: { audience: null, reason: null, offer: { value: '包邮', source: 'explicit', at: now + 1 }, goal: null },
    memory: old.memory, filled_count: 0, code_status: 'none'
  };
  mergeMonotonicAct(downgraded, old, now + 2);
  assert.equal(countFilled(downgraded.needs), 3, '旧值已填的槽被回填，新值照写');
  assert.equal(downgraded.needs.audience.value, '加购未付客户', '拒绝降级：保留旧值');
  assert.equal(downgraded.needs.reason.value, '太久没动静');
  assert.equal(downgraded.needs.offer.value, '包邮');
  assert.equal(downgraded.filled_count, 3, 'filled_count 单调不减');

  // 降级路径同样覆盖 store.upsertAct（B-1 门禁：落库前比较）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-store-mono-'));
  const store = new Store({ dbFile: path.join(dir, 'mono.sqlite') });
  store.init();
  const cleanup = () => {
    try { if (store.b) store.b.close(); } catch (e) { /* 已关闭 */ }
    fs.rmSync(dir, RM_OPTS);
  };
  store.upsertAct(migrateAct({ id: 'act_s1', stage: 'S1', needs: { audience: '加购未付客户', pain: '忘了结账' }, messages: [], memory: {}, filled_count: 0 }));
  const stored = store.getAct('act_s1');
  store.upsertAct({ ...stored, needs: { audience: null, reason: null, offer: null, goal: null } });
  const after = store.getAct('act_s1');
  assert.equal(after.filled_count, 2, 'store.upsertAct 拒绝 filled_count 降级');
  assert.equal(after.needs.audience.value, '加购未付客户');
  cleanup();
});
