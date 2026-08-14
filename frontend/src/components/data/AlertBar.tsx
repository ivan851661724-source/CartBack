'use client';

import type { Kpis } from '@/lib/types';

/** 异常条：发送失败 / 超时 —— 对应 app.js renderData 的 alert 段。 */
export default function AlertBar({ k }: { k: Kpis }) {
  const issues: string[] = [];
  if (k.failed) issues.push(`${k.failed} 封发送失败`);
  if (k.timeout) issues.push(`${k.timeout} 封超时`);
  if (!issues.length) return null;
  return (
    <div className="alert-bar show">
      <svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18.5v.5" /></svg>
      <span>⚠ {issues.join('，')}，请检查 ESP 配置或重试。</span>
    </div>
  );
}
