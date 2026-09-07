'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../lib/store');
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
