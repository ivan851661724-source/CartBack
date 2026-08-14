'use client';

import { useApp } from '@/state/AppProvider';

/** 全局 Toast（替换 alert）—— 读 provider.toast，3s 自动隐藏 */
export default function Toast() {
  const { toast } = useApp();
  return (
    <div className={`toast${toast.shown ? ' show' : ''}`}>
      <span className="td" />
      <span>{toast.msg}</span>
    </div>
  );
}
