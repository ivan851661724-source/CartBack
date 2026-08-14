'use strict';
/**
 * 用户认证基础层（架构方案 v4 D7）
 *
 * - 密码哈希：node:crypto scrypt（内置，零依赖，不引 bcrypt）
 * - 会话：登录签发随机 token → 库中只存 SHA-256 哈希（库泄露不泄会话）
 * - 会话策略：云存档永久保存（用户 2026-08-11 拍板）——sessions 无过期字段，
 *   Cookie Max-Age 10 年；唯一失效途径 = 登出删行 / 退出所有设备
 * - Cookie：HttpOnly + SameSite=Lax；HTTPS 反代后设 COOKIE_SECURE=1 追加 Secure（本地 http 保持可跑）
 * - 登录限流：同邮箱连续 5 次失败锁 15 分钟（防爆破）
 * - 过渡兼容：resolveUser 优先会话 cookie，其次 x-local-token（仅 CARTBACK_OPEN_LOCAL=1 显式开启；
 *   默认关闭——否则 /api/bootstrap 向任意访客下发 token = 无鉴权）
 */
const crypto = require('crypto');

const SCRYPT_N = 16384;          // 成本参数（内存约 16MB），正式运营可上调 32768
const SCRYPT_KEYLEN = 64;
const SESSION_COOKIE = 'cb_session';
const COOKIE_MAX_AGE = 10 * 365 * 24 * 3600; // 秒；云存档永久（浏览器上限兜底）
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

// 本地开放模式：显式开启后 /api/bootstrap 下发 localToken、x-local-token 可鉴权。
// 默认关闭（安全默认）——公开部署时下发 token 给任意访客等于无鉴权。
const OPEN_LOCAL = process.env.CARTBACK_OPEN_LOCAL === '1';

/* ---------------- 密码哈希 ---------------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N }).toString('hex');
  return `scrypt:${SCRYPT_N}:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, n, salt, hash] = String(stored || '').split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const calc = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: parseInt(n, 10) || SCRYPT_N }).toString('hex');
    const a = Buffer.from(calc, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

/* ---------------- 会话 token ---------------- */
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

/** 定长秘密的常量时间比较（避免时序旁路；与密码校验 timingSafeEqual 一致） */
function secretEqual(a, b) {
  const sa = Buffer.from(String(a || ''));
  const sb = Buffer.from(String(b || ''));
  if (sa.length !== sb.length) return false;
  try { return crypto.timingSafeEqual(sa, sb); } catch (e) { return false; }
}

/* ---------------- Cookie ---------------- */
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const COOKIE_SECURE = process.env.COOKIE_SECURE === '1'; // HTTPS 反代后置 1（Secure 属性；本地 http 保持可跑）

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${COOKIE_SECURE ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`);
}

/* ---------------- 登录限流（内存计数，重启清零可接受） ---------------- */
const loginFails = {}; // email -> { count, until }

function isLoginLocked(email) {
  const f = loginFails[String(email || '').toLowerCase()];
  return Boolean(f && f.until > Date.now());
}
function noteLoginFail(email) {
  const k = String(email || '').toLowerCase();
  const f = loginFails[k] || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= LOGIN_MAX_FAILS) { f.until = Date.now() + LOGIN_LOCK_MS; f.count = 0; }
  loginFails[k] = f;
}
function noteLoginOk(email) { delete loginFails[String(email || '').toLowerCase()]; }

/* ---------------- 用户解析（中间件核心） ----------------
 * 返回 { userId, authMode: 'session' | 'local' } 或 null
 * - session：会话 cookie 命中
 * - local：x-local-token 命中（过渡兼容老前端；无内置管理员时懒创建）
 */
function resolveUser(req, store, config) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const s = store.findSessionByTokenHash(hashToken(token));
    if (s) {
      const u = store.getUserById(s.user_id);
      if (u && u.status !== 'disabled') return { userId: u.id, authMode: 'session' };
    }
  }
  const local = req.headers['x-local-token'];
  if (OPEN_LOCAL && local && config.localToken && secretEqual(local, config.localToken)) {
    const owner = ensureLocalOwner(store);
    return { userId: owner.id, authMode: 'local' };
  }
  return null;
}

/** 本地模式内置管理员：数据归属锚点（不可登录，密码随机；老前端数据挂它名下） */
function ensureLocalOwner(store) {
  const email = 'admin@local';
  let u = store.getUserByEmail(email);
  if (!u) {
    u = store.createUser({ email, name: '本地管理员', password_hash: hashPassword(crypto.randomBytes(16).toString('hex')), status: 'active' });
  }
  return u;
}

module.exports = {
  SESSION_COOKIE, COOKIE_MAX_AGE, OPEN_LOCAL,
  hashPassword, verifyPassword,
  newToken, hashToken, secretEqual,
  parseCookies, setSessionCookie, clearSessionCookie,
  isLoginLocked, noteLoginFail, noteLoginOk,
  resolveUser, ensureLocalOwner
};
