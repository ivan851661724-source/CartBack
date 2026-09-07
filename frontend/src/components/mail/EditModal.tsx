'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import Modal from '@/components/ui/Modal';
import { api } from '@/lib/api';

/** 按人群/语言预览数据（后端渲染管线同口径产出） */
interface DraftPreview {
  tiers: { tier: string; count: number; subject?: string; body?: string; locale?: string; sample?: string; blocked?: boolean }[];
  languages: { locale: string; count: number }[];
  g0_blocked: { email: string; hits: string[] }[];
}
const TIER_LABEL: Record<string, string> = { discount: '价格敏感 · 折扣主打', urgency: '高意向 · 紧迫', standard: '标准提醒' };

/** 邮件编辑弹窗：主题/正文可改，支持 HTML 预览 */
export default function EditModal() {
  const { editOpen, editingDraft, setEditOpen, sendEditedDraft } = useApp();
  const [subj, setSubj] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const [posters, setPosters] = useState<{ url: string; method: string }[]>([]);
  const [posterBusy, setPosterBusy] = useState(false);

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
      setPosters(((editingDraft as any).posters || []).filter((x: any) => x && x.url));
      // ④ 按人群/语言预览（渲染管线实际产物；失败静默不打扰编辑）
      if (editingDraft.id) {
        api<DraftPreview>(`/api/draft/${editingDraft.id}/preview`)
          .then((r) => setPreview(r))
          .catch(() => setPreview(null));
      }
    } else {
      setPreview(null);
    }
  }, [editOpen, editingDraft]);

  // ③ 海报「换一批」：重新入队生成，轮询任务完成后刷新缩略图
  const regenPosters = async () => {
    if (!editingDraft?.id || posterBusy) return;
    setPosterBusy(true);
    try {
      const r = await api<{ job_id: string }>('/api/posters', {
        method: 'POST',
        body: JSON.stringify({ draftId: editingDraft.id, regenerate: true }),
      });
      if (r.job_id) {
        for (let i = 0; i < 60; i++) {
          const j = await api<{ status: string; result?: { posters?: { url: string; method: string }[] } }>(`/api/jobs/${r.job_id}`);
          if (j.status === 'done') { setPosters((j.result?.posters || []).filter((x) => x.url)); break; }
          if (j.status === 'failed') break;
          await new Promise((res) => setTimeout(res, 900));
        }
      }
    } catch { /* 静默 */ } finally { setPosterBusy(false); }
  };

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
        {posters.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              海报（3 款）{' '}
              <button className="btn ghost sm" disabled={posterBusy} onClick={regenPosters} style={{ marginLeft: 6 }}>
                {posterBusy ? '生成中…' : '换一批'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {posters.map((p, i) => (
                <a key={i} href={p.url} target="_blank" rel="noreferrer" title={`${p.method} · 点击看大图`}>
                  <img
                    src={p.url}
                    alt={`poster-${i + 1}`}
                    style={{ width: 150, height: 75, objectFit: 'cover', borderRadius: 8, border: '1px solid #DDE2E8' }}
                  />
                </a>
              ))}
            </div>
          </div>
        )}
        {preview && preview.tiers.some((t) => t.count > 0) && (
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              按人群预览（{preview.tiers.reduce((s2, t) => s2 + t.count, 0)} 人 · 3 类变体） · 语言：{preview.languages.map((l) => `${l.locale.toUpperCase()}×${l.count}`).join(' / ')}
            </summary>
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              {preview.tiers.filter((t) => t.count > 0).map((t) => (
                <div key={t.tier} style={{ padding: '8px 10px', borderRadius: 10, background: 'rgba(125,125,125,.08)', fontSize: 12.5 as any }}>
                  <b>{TIER_LABEL[t.tier] || t.tier}</b>
                  <span style={{ opacity: 0.6 }}> · {t.count} 人 · {(t.locale || 'en').toUpperCase()}</span>
                  {t.blocked && <span style={{ color: '#d33', fontWeight: 700 }}> · ⛔ G0 拦截</span>}
                  <div style={{ marginTop: 4, opacity: 0.85 }}>主题样例：{t.subject}</div>
                </div>
              ))}
              {preview.g0_blocked.length > 0 && (
                <div style={{ color: '#d33', fontSize: 12.5, fontWeight: 600 }}>
                  ⛔ {preview.g0_blocked.length} 封被 G0 拦截（非白名单中文）：{preview.g0_blocked.map((b) => b.email).join('、')}
                </div>
              )}
            </div>
          </details>
        )}
      </div>
      <div className="m-foot">
        <button className="btn primary" onClick={onSubmit}>保存并发送</button>
        {msg && <span className={`msg${err ? ' err' : ''}`}>{msg}</span>}
      </div>
    </Modal>
  );
}