/**
 * CartBack v3 前端纯格式化工具（数字滚动动画在组件内用 rAF，不在此处）。
 */

/** ¥ + 整数（看板金额统一取整） */
export function fmtMoney0(n: number | undefined | null): string {
  return '¥' + Math.round(Number(n) || 0);
}

/** ¥ + 两位小数（受众弃购额 / 预估回流明细） */
export function fmtMoney2(n: number | undefined | null): string {
  return '¥' + (Number(n) || 0).toFixed(2);
}

/** 百分比：0.12 → "12.0%" */
export function fmtPct(rate: number | undefined | null, digits = 1): string {
  return ((Number(rate) || 0) * 100).toFixed(digits) + '%';
}

/** 倍数：1.23 → "1.2×" */
export function fmtX(n: number | undefined | null, digits = 1): string {
  return (Number(n) || 0).toFixed(digits) + '×';
}

/** 千分位整数（数字滚动目标值） */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

/** 取字符串首字符（头像），兜底 '?' */
export function initial(s: string | undefined | null): string {
  return (String(s || '?').trim().slice(0, 1)) || '?';
}

/**
 * 通知/回执时间展示（Wave4 Z7）：epoch 秒/毫秒数值或 ISO 字符串 → 'MM-DD HH:mm'；
 * 无法解析返回 ''（调用方按空值兜底展示 '—'）。
 */
export function fmtTime(t: number | string | undefined | null): string {
  if (t === undefined || t === null || t === '') return '';
  const d = typeof t === 'number' ? new Date(t < 1e12 ? t * 1000 : t) : new Date(t);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
