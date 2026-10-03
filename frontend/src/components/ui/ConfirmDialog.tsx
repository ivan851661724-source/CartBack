'use client';

import Modal from './Modal';

/**
 * 自定义确认弹层（替代 window.confirm）。
 * 09-30 报告 P2-2：原生 confirm() 会阻塞自动化点击（模态 30s 卡住）且与应用弹层风格不一致；
 * 统一走 Modal 壳：遮罩点击/ESC 均可取消，danger 态确认键红色（重置/删除类）。
 */
export default function ConfirmDialog({
  open, title, message, confirmLabel = '确定', cancelLabel = '取消', danger, onConfirm, onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} width={380}>
      <div className="m-body">
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7, color: 'var(--text)' }}>{message}</p>
      </div>
      <div className="m-foot" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 20px 18px' }}>
        <button type="button" className="btn ghost sm" onClick={onCancel}>{cancelLabel}</button>
        <button
          type="button"
          className="btn primary sm"
          style={danger ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
