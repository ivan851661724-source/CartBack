'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import Modal from '@/components/ui/Modal';

/** 邮件编辑弹窗：主题/正文可改，发送以最新内容为准（P0-1） */
export default function EditModal() {
  const { editOpen, editingDraft, setEditOpen, sendEditedDraft } = useApp();
  const [subj, setSubj] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState(false);

  // 打开新草稿时同步输入
  useEffect(() => {
    if (editOpen && editingDraft) {
      setSubj(editingDraft.subject || '');
      setBody(editingDraft.body || '');
      setMsg(''); setErr(false);
    }
  }, [editOpen, editingDraft]);

  const onSubmit = async () => {
    const ok = await sendEditedDraft(subj.trim(), body);
    if (!ok) { setMsg('主题和正文不能为空'); setErr(true); }
  };

  return (
    <Modal open={editOpen} onClose={() => setEditOpen(false)} title="编辑邮件">
      <div className="m-body">
        <p>主题与正文可直接微调，保存并发送时以最新内容为准。</p>
        <input type="text" placeholder="邮件主题" style={{ marginBottom: 9 }}
          value={subj} onChange={(e) => setSubj(e.target.value)} />
        <textarea spellCheck={false} placeholder="邮件正文…"
          value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="m-foot">
        <button className="btn primary" onClick={onSubmit}>保存并发送</button>
        {msg && <span className={`msg${err ? ' err' : ''}`}>{msg}</span>}
      </div>
    </Modal>
  );
}
