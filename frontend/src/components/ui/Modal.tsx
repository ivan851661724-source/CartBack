'use client';

import React, { useEffect } from 'react';
import { Close } from './icons';

/**
 * 统一弹窗壳 —— 对应 flow.html .overlay/.modal。
 * 提供：遮罩 + 点遮罩关闭 + ESC 关闭 + 头部（标题 + 关闭）。
 * 调用方在 children 内自行渲染 .m-body / .m-foot（与原结构一致）。
 */
export default function Modal({
  open, onClose, title, width, children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  width?: React.CSSProperties['width'];
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={width ? { width } : undefined}>
        <div className="m-head">
          <h3>{title}</h3>
          <button className="x" onClick={onClose} aria-label="关闭"><Close /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
