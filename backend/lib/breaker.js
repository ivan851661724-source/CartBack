'use strict';
/**
 * lib/breaker.js — 熔断器（PRD §0.2 基础设施）
 *
 * 三态：closed（正常放行）→ 连续失败达阈值 → open（直接拒绝，快速失败，保护下游）
 *      → 冷却期满 → half-open（放一个探测请求）→ 成功回 closed / 失败回 open。
 *
 * 用途：LLM / ESP / 海报生成等外呼链路。熔断不是失败伪装——open 态 throw BreakerOpenError，
 * 调用方按各自降级策略处理（critic fail-open、生成链 fail-closed、海报占位重试）。
 */
class BreakerOpenError extends Error {
  constructor(name, retryAfterMs) {
    super(`breaker [${name}] open，冷却中（剩余 ${retryAfterMs}ms）`);
    this.code = 'BREAKER_OPEN';
    this.name = 'BreakerOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

class Breaker {
  /**
   * @param {string} name    熔断器名（日志/多实例区分）
   * @param {object} opts
   *   threshold     连续失败多少次进入 open（默认 5）
   *   cooldownMs    open 态冷却时长（默认 30_000），期满转 half-open
   *   halfOpenMax   half-open 态允许的探测并发数（默认 1）
   *   now           时间源（测试注入用）
   */
  constructor(name = 'breaker', opts = {}) {
    this.name = name;
    this.threshold = Math.max(1, opts.threshold || 5);
    this.cooldownMs = opts.cooldownMs != null ? opts.cooldownMs : 30000;
    this.halfOpenMax = Math.max(1, opts.halfOpenMax || 1);
    this._now = opts.now || (() => Date.now());
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.halfOpenInflight = 0;
    this.lastError = null;
    this.stats = { opened: 0, closed: 0, rejected: 0, probes: 0 };
  }

  _nowMs() { return this._now(); }

  /** open 且冷却期满 → 转 half-open（允许探测） */
  _refreshState() {
    if (this.state === 'open' && this._nowMs() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
      this.halfOpenInflight = 0;
    }
  }

  /** 手动检查是否放行（不执行 fn 时用） */
  allow() {
    this._refreshState();
    if (this.state === 'open') return { ok: false, retryAfterMs: this.cooldownMs - (this._nowMs() - this.openedAt) };
    if (this.state === 'half-open' && this.halfOpenInflight >= this.halfOpenMax) {
      return { ok: false, retryAfterMs: this.cooldownMs };
    }
    return { ok: true };
  }

  /**
   * 经熔断执行 fn。拒绝时 throw BreakerOpenError（不吞错——降级策略由调用方定）。
   */
  async exec(fn) {
    this._refreshState();
    if (this.state === 'open') {
      this.stats.rejected++;
      throw new BreakerOpenError(this.name, this.cooldownMs - (this._nowMs() - this.openedAt));
    }
    if (this.state === 'half-open') {
      if (this.halfOpenInflight >= this.halfOpenMax) {
        this.stats.rejected++;
        throw new BreakerOpenError(this.name, this.cooldownMs);
      }
      this.halfOpenInflight++;
      this.stats.probes++;
    }
    try {
      const r = await fn();
      this._onSuccess();
      return r;
    } catch (e) {
      this._onFailure(e);
      throw e;
    } finally {
      if (this.state === 'half-open' || this.halfOpenInflight > 0) {
        this.halfOpenInflight = Math.max(0, this.halfOpenInflight - 1);
      }
    }
  }

  _onSuccess() {
    // half-open 探测成功 → 回 closed；closed 里成功清零连续失败计数
    if (this.state === 'half-open' || this.state === 'open') {
      this.state = 'closed';
      this.stats.closed++;
    }
    this.failures = 0;
    this.lastError = null;
  }

  _onFailure(err) {
    this.failures++;
    this.lastError = err ? String(err.message || err) : 'unknown';
    if (this.state === 'half-open') {
      // 探测失败 → 立即回 open，重新冷却
      this.state = 'open';
      this.openedAt = this._nowMs();
      this.stats.opened++;
      return;
    }
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = this._nowMs();
      this.stats.opened++;
    }
  }

  /** 手动复位（测试 / 运维） */
  reset() {
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.halfOpenInflight = 0;
    this.lastError = null;
  }

  snapshot() {
    this._refreshState();
    return {
      name: this.name, state: this.state, failures: this.failures,
      retryAfterMs: this.state === 'open' ? Math.max(0, this.cooldownMs - (this._nowMs() - this.openedAt)) : 0,
      lastError: this.lastError, stats: { ...this.stats }
    };
  }
}

/** 多熔断器注册表：breakers.get('llm') / get('esp') 各自独立计数 */
class BreakerRegistry {
  constructor(defaults = {}) {
    this.defaults = defaults;
    this.map = new Map();
  }
  get(name, opts = {}) {
    if (!this.map.has(name)) {
      this.map.set(name, new Breaker(name, { ...this.defaults, ...opts }));
    }
    return this.map.get(name);
  }
  snapshotAll() { return [...this.map.values()].map(b => b.snapshot()); }
}

module.exports = { Breaker, BreakerRegistry, BreakerOpenError };
