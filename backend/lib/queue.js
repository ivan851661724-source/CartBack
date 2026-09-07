'use strict';
/**
 * lib/queue.js — 异步任务队列（PRD §0.2 基础设施 / §0.5 jobs 表）
 *
 * 设计（零依赖、单进程、可测试）：
 *  - 任务持久化到 jobs 表（store），进程重启后 pending 任务由 recover() 重新入队或按策略标记失败；
 *  - dedupe_key 幂等：同键 pending/running 任务复用（send:{userId}:{draftId} / posters:{draftId}）；
 *  - 失败指数退避重试（retry_count < max_retries），重试调度用 setTimeout，不阻塞主进程；
 *  - handler 注册表：queue.register('send_draft', fn)；exec 收 {job, payload}，返回结果落 jobs.result；
 *  - /api/jobs/:id 前端轮询直接读 store，读接口不经过本模块也能工作（store 是唯一事实源）。
 */
const { BreakerOpenError } = require('./breaker');

class JobQueue {
  /**
   * @param {object} opts
   *   store        : Store 实例（jobs 表）
   *   concurrency  : 同时执行的 任务数（默认 2）
   *   baseDelayMs  : 重试退避基数（默认 2000，指数 ×2）
   *   maxRetries   : 默认最大重试次数（默认 3，可被 job.max_retries 覆盖）
   *   logger       : 结构化日志 fn(type, data)
   */
  constructor(opts = {}) {
    this.store = opts.store;
    this.concurrency = Math.max(1, opts.concurrency || 2);
    this.baseDelayMs = opts.baseDelayMs != null ? opts.baseDelayMs : 2000;
    this.maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
    this.log = opts.logger || (() => {});
    this.handlers = new Map();
    this.inflight = 0;
    this._timer = null;
    this._stopped = false;
  }

  register(type, handler) { this.handlers.set(type, handler); return this; }

  /**
   * 入队。返回 { job, deduped }；deduped=true 表示命中同 dedupe_key 的进行中任务。
   * payload 必须可 JSON 序列化（落库）。
   */
  enqueue({ type, payload = {}, dedupeKey = null, maxRetries = null }) {
    const { job, deduped } = this.store.createJob({
      type, payload, dedupe_key: dedupeKey,
      max_retries: maxRetries != null ? maxRetries : this.maxRetries,
      status: 'pending'
    });
    if (!deduped) this.log('job_enqueue', { job_id: job.id, type, dedupe_key: dedupeKey });
    this._schedule();
    return { job, deduped };
  }

  /** 重启恢复：pending 任务重新调度；running 任务（进程死掉的残留）标回 pending 再调度 */
  recover() {
    for (const j of this.store._read('jobs')) {
      if (j.status === 'running') this.store.updateJob(j.id, { status: 'pending', error: 'recovered after restart' });
    }
    const pending = this.store.listPendingJobs().length;
    if (pending) this._schedule();
    return pending;
  }

  stats() {
    const rows = this.store._read('jobs');
    return {
      pending: rows.filter(j => j.status === 'pending').length,
      running: rows.filter(j => j.status === 'running').length,
      inflight: this.inflight
    };
  }

  _schedule() {
    if (this._stopped) return;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._tick(); }, 0);
  }

  async _tick() {
    while (!this._stopped && this.inflight < this.concurrency) {
      const next = this.store.listPendingJobs()
        .filter(j => this.handlers.has(j.type))
        .sort((a, b) => a.created_at - b.created_at)[0];
      if (!next) return;
      this._run(next);
    }
  }

  _run(job) {
    this.inflight++;
    this.store.updateJob(job.id, { status: 'running' });
    const handler = this.handlers.get(job.type);
    Promise.resolve()
      .then(() => handler({ job, payload: job.payload || {} }))
      .then(result => {
        this.store.updateJob(job.id, { status: 'done', result: result == null ? {} : result, error: null });
        this.log('job_done', { job_id: job.id, type: job.type });
      })
      .catch(e => this._onFail(job, e))
      .finally(() => {
        this.inflight--;
        if (!this._stopped) this._schedule();
      });
  }

  _onFail(job, e) {
    const retryCount = (job.retry_count || 0) + 1;
    const maxRetries = job.max_retries != null ? job.max_retries : this.maxRetries;
    const canRetry = retryCount <= maxRetries;
    this.log('job_fail', { job_id: job.id, type: job.type, retry: retryCount, error: String(e && e.message || e) });
    if (canRetry) {
      const delay = this.baseDelayMs * Math.pow(2, retryCount - 1);
      this.store.updateJob(job.id, { status: 'pending', retry_count: retryCount, error: String(e && e.message || e) });
      setTimeout(() => { if (!this._stopped) this._schedule(); }, delay);
    } else {
      this.store.updateJob(job.id, { status: 'failed', retry_count: retryCount, error: String(e && e.message || e) });
    }
  }

  stop() { this._stopped = true; if (this._timer) { clearTimeout(this._timer); this._timer = null; } }
}

module.exports = { JobQueue, BreakerOpenError };
