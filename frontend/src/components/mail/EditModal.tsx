'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import Modal from '@/components/ui/Modal';

/** 邮件编辑弹窗：主题/正文可改，支持 HTML 预览 */
export default function EditModal() {
  const { editOpen, editingDraft, setEditOpen, sendEditedDraft } = useApp();
  const [subj, setSubj] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');

  useEffect(() => {
    if (editOpen && editingDraft) {
      setSubj(editingDraft.subject || '');
      setBody(editingDraft.body || '');
      setMsg(''); setErr(false);

      // 构建预览 HTML：把图片引用改写到同源 /api/image 端点（经 Next 反代到 backend）
      let html = (editingDraft as any).html || '';
      const imgPath = (editingDraft as any).image_path || '';
      if (html && imgPath) {
        const imgUrl = '/api/image/' + encodeURIComponent(imgPath);
        // 旧版 cid 内嵌 src 与 use_cid=false 的本地绝对路径 src 都改写到同源端点
        html = html.replace(/cid:hero-image/g, imgUrl);
        const escPath = imgPath
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
        if (escPath) html = html.split(escPath).join(imgUrl);
      }
      setPreviewHtml(html);
    }
  }, [editOpen, editingDraft]);

  const onSubmit = async () => {
    const ok = await sendEditedDraft(subj.trim(), body);
    if (!ok) { setMsg('主题和正文不能为空'); setErr(true); }
  };

  return (
    <Modal open={editOpen} onClose={() => setEditOpen(false)} title="邮件预览">
      <div className="m-body">
        {previewHtml ? (
          <iframe
            srcDoc={previewHtml}
            style={{ width: '100%', height: '400px', border: '1px solid #DDE2E8', borderRadius: '10px' }}
            title="邮件预览"
          />
        ) : (
          <>
            <p>主题与正文可直接微调，保存并发送时以最新内容为准。</p>
            <input type="text" placeholder="邮件主题" style={{ marginBottom: 9 }}
              value={subj} onChange={(e) => setSubj(e.target.value)} />
            <textarea spellCheck={false} placeholder="邮件正文…"
              value={body} onChange={(e) => setBody(e.target.value)} />
          </>
        )}
      </div>
      <div className="m-foot">
        <button className="btn primary" onClick={onSubmit}>保存并发送</button>
        {msg && <span className={`msg${err ? ' err' : ''}`}>{msg}</span>}
      </div>
    </Modal>
  );
}