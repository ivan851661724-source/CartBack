'use strict';
/**
 * 异步队列测试（PRD §0.2 底座：JobQueue 幂等 / 重试 / 恢复；jobs 表持久化）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const { JobQueue } = require('../lib/queue');

// Windows 下 SQLite WAL 句柄释放略滞后：单钩子先 close 再删目录
function tempStore(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-' + name + '-'));
  const store = new Store({ dbFile: path.join(dir, 'q.sqlite') });
  store.init();
  const cleanup = () => {
    try { if (store.b) store.b.close(); } catch (e) { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { store, cleanup };
}

test('queue：任务执行成功落 done + result；dedupe_key 幂等复用', async () => {
  const { store, cleanup } = tempStore('queue-ok');
  try {
    const q = new JobQueue({ store, concurrency: 2, baseDelayMs: 5, maxRetries: 1 });
    let runs = 0;
    q.register('echo', async ({ payload }) => { runs++; return { echoed: payload.x }; });
    const a = q.enqueue({ type: 'echo', payload: { x: 1 }, dedupeKey: 'k1' });
    assert.equal(a.deduped, false);
    // dedupe 命中：pending 期间同键入队复用同一任务
    const b = q.enqueue({ type: 'echo', payload: { x: 2 }, dedupeKey: 'k1' });
    assert.equal(b.deduped, true);
    assert.equal(a.job.id, b.job.id);
    for (let i = 0; i < 100 && store.getJob(a.job.id).status !== 'done'; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    const job = store.getJob(a.job.id);
    assert.equal(job.status, 'done');
    assert.deepEqual(job.result, { echoed: 1 });
    assert.equal(runs, 1);
    // done 之后同键入队 → 新任务（幂等只挡进行中）
    const c = q.enqueue({ type: 'echo', payload: { x: 3 }, dedupeKey: 'k1' });
    assert.equal(c.deduped, false);
    await new Promise(r => setTimeout(r, 30));
    q.stop();
  } finally { cleanup(); }
});

test('queue：失败按指数退避重试，超过 max_retries 落 failed', async () => {
  const { store, cleanup } = tempStore('queue-retry');
  try {
    const q = new JobQueue({ store, concurrency: 1, baseDelayMs: 10, maxRetries: 2 });
    let attempts = 0;
    q.register('flaky', async () => { attempts++; throw new Error('boom ' + attempts); });
    const { job } = q.enqueue({ type: 'flaky', payload: {}, maxRetries: 2 });
    for (let i = 0; i < 200 && !['failed', 'done'].includes(store.getJob(job.id).status); i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    const done = store.getJob(job.id);
    assert.equal(done.status, 'failed');
    assert.equal(attempts, 3);            // 首次 + 2 次重试
    assert.match(done.error, /boom 3/);
    assert.equal(done.retry_count, 3);
    q.stop();
  } finally { cleanup(); }
});

test('queue：recover() 把 running 残留标回 pending 并重新调度', async () => {
  const { store, cleanup } = tempStore('queue-recover');
  try {
    store.createJob({ id: 'job_stuck', type: 'work', payload: {}, status: 'running' });
    const q = new JobQueue({ store, concurrency: 1, baseDelayMs: 5, maxRetries: 0 });
    q.register('work', async () => ({ healed: true }));
    const pending = q.recover();
    assert.ok(pending >= 1);
    for (let i = 0; i < 100 && store.getJob('job_stuck').status !== 'done'; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(store.getJob('job_stuck').status, 'done');
    q.stop();
  } finally { cleanup(); }
});
