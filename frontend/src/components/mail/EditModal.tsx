'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { Close } from '@/components/ui/icons';
import { api } from '@/lib/api';

/** 按人群/语言预览数据（后端渲染管线同口径产出） */
interface DraftPreview {
  tiers: { tier: string; count: number; subject?: string; body?: string; locale?: string; sample?: string; blocked?: boolean }[];
  languages: { locale: string; count: number }[];
  g0_blocked: { email: string; hits: string[] }[];
}
const TIER_LABEL: Record<string, string> = { discount: '价格敏感 · 折扣主打', urgency: '高意向 · 紧迫', standard: '标准提醒' };

/** 构建预览 HTML：把图片引用改写到同源 /api/image 端点（经 Next 反代到 backend） */
function rewriteImageUrls(html: string, imgPath: string): string {
  let out = html || '';
  if (out && imgPath) {
    const imgUrl = '/api/image/' + encodeURIComponent(imgPath);
    // 旧版 cid 内嵌 src 与 use_cid=false 的本地绝对路径 src 都改写到同源端点
    out = out.replace(/cid:hero-image/g, imgUrl);
    const escPath = imgPath
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
    if (escPath) out = out.split(escPath).join(imgUrl);
  }
  return out;
}

/**
 * 邮件预览 / 编辑弹窗（Figma 446:4589 / 446:6142 / 446:6853）。
 * 预览态：单栏邮件渲染 + 发送/编辑按钮；
 * 编辑态：双栏（左预览右编辑面板：主题/正文/主图/提示词+生成图片/按人群预览/保存并预览）。
 */
export default function EditModal() {
  const { editOpen, editingDraft, setEditOpen, sendEditedDraft, confirmState } = useApp();
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [subj, setSubj] = useState('');
  const [body, setBody] = useState('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [imgPath, setImgPath] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (editOpen && editingDraft) {
      setMode('preview');
      setSubj(editingDraft.subject || '');
      setBody(editingDraft.body || '');
      setImagePrompt(editingDraft.image_prompt || '');
      setImgPath((editingDraft as any).image_path || '');
      setPreviewHtml(rewriteImageUrls((editingDraft as any).html || '', (editingDraft as any).image_path || ''));
      setMsg(''); setErr(false); setRegenerating(false);

      // ④ 按人群/语言预览（渲染管线实际产物；失败静默不打扰编辑）
      // 形状校验：500 时返回 {error} 而非抛异常，直接 set 会让下方 preview.tiers.some 崩溃
      if (editingDraft.id) {
        api<DraftPreview>(`/api/draft/${editingDraft.id}/preview`)
          .then((r) => setPreview(r && Array.isArray(r.tiers) ? r : null))
          .catch(() => setPreview(null));
      }
    } else {
      setPreview(null);
    }
  }, [editOpen, editingDraft]);

  // 发送闸门联动（Wave2）：仅当该草稿正是 confirm 流程建的（confirmState.planCard.draft_id 匹配）
  // 才有核对单数据 → all_pass=false 禁用发送；无关联数据（邮件页其他草稿 / 旧后端）按现行为不禁用，
  // 绝不因数据缺失永久禁用发送。
  const linkedChecklist = editingDraft && confirmState?.planCard?.draft_id === editingDraft.id
    ? confirmState.checklist
    : null;
  const failCount = linkedChecklist ? linkedChecklist.items.filter((i) => !i.pass).length : 0;
  const sendBlocked = Boolean(linkedChecklist && linkedChecklist.all_pass === false);

  // 发送（预览态/编辑态共用；以当前编辑内容为准）
  const onSend = async () => {
    const ok = await sendEditedDraft(subj.trim(), body);
    if (!ok) { setMsg('主题和正文不能为空'); setErr(true); }
  };

  // 「生成图片」：按（可编辑的）提示词重跑主图；文案/主题不动，成功后刷新预览
  const onRegenImage = async () => {
    if (!editingDraft) return;
    if (!imagePrompt.trim()) { setMsg('提示词不能为空'); setErr(true); return; }
    setRegenerating(true); setMsg(''); setErr(false);
    try {
      const r = await api<{ image_path?: string; image_prompt?: string; html?: string; error?: string }>(
        `/api/draft/${editingDraft.id}/image`,
        { method: 'POST', body: JSON.stringify({ prompt: imagePrompt.trim() }) },
      );
      if (r.error) { setMsg(r.error); setErr(true); return; }
      if (r.image_path) setImgPath(r.image_path);
      if (r.image_prompt) setImagePrompt(r.image_prompt);
      if (r.html) setPreviewHtml(rewriteImageUrls(r.html, r.image_path || imgPath));
      setMsg('图片已重新生成');
    } catch (e: any) {
      setMsg('生成失败：' + (e?.message || e));
      setErr(true);
    } finally {
      setRegenerating(false);
    }
  };

  // 主图：邮件正文里的 Hero 图（image_path → 同源 /api/image 端点）
  const heroPath = editOpen && editingDraft ? imgPath : '';
  const heroUrl = heroPath ? '/api/image/' + encodeURIComponent(heroPath) : '';

  // 「变体」标签直接填充命中的心理分层名称（只计实际有收件人的档位）：
  // 1 档 →「1 人 · 价格敏感 · 折扣主打」；多档 →「12 人 · 折扣主打 / 紧迫 / 标准提醒」
  const activeTiers = preview ? preview.tiers.filter((t) => t.count > 0) : [];
  const tierNames = activeTiers.map((t) => TIER_LABEL[t.tier] || t.tier).join(' / ');
  const totalReach = preview ? activeTiers.reduce((s, t) => s + t.count, 0) : 0;

  // 自绘 overlay（Modal 壳已弃用）：ESC 关闭两态通用
  useEffect(() => {
    if (!editOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editOpen, setEditOpen]);

  // 预览面板内容（预览态/编辑态共用）：邮件渲染 + 按人群预览下拉 + 操作行
  const previewPane = (
    <>
      {previewHtml ? (
        <iframe
          className="em-iframe"
          srcDoc={previewHtml}
          style={{ width: '100%', height: mode === 'edit' ? '860px' : '600px', border: '1px solid #DDE2E8', borderRadius: '10px', background: '#fff' }}
          title="邮件预览"
        />
      ) : (
        <p>主题与正文可直接微调，保存并发送时以修改后内容为准。</p>
      )}

      {preview && activeTiers.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, marginTop: 10 }}>
            按人群预览（{totalReach} 人 · {tierNames}） · 语言：{preview.languages.map((l) => `${l.locale.toUpperCase()}×${l.count}`).join(' / ')}
          </summary>
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            {activeTiers.map((t) => (
              <div key={t.tier} style={{ padding: '8px 10px', borderRadius: 10, background: 'rgba(125,125,125,.08)', fontSize: 12.5 as any }}>
                <b>{TIER_LABEL[t.tier] || t.tier}</b>
                <span style={{ opacity: 0.6 }}> · {t.count} 人 · {(t.locale || 'en').toUpperCase()}</span>
                {t.blocked && <span style={{ color: 'var(--danger)', fontWeight: 700 }}> · ⛔ G0 拦截</span>}
                <div style={{ marginTop: 4, fontWeight: 600 }}>{t.subject}</div>
                {t.body && <div style={{ marginTop: 2, opacity: 0.85, whiteSpace: 'pre-line' }}>{String(t.body).slice(0, 220)}{String(t.body).length > 220 ? '…' : ''}</div>}
              </div>
            ))}
            {preview.g0_blocked.length > 0 && (
              <div style={{ color: 'var(--danger)', fontSize: 12.5, fontWeight: 600 }}>
                ⛔ {preview.g0_blocked.length} 封被 G0 拦截（非白名单中文）：{preview.g0_blocked.map((b) => b.email).join('、')}
              </div>
            )}
          </div>
        </details>
      )}

      <div className="em-actions">
        <button
          className="em-btn"
          onClick={onSend}
          disabled={sendBlocked}
          title={sendBlocked ? `核对单 ${failCount} 项未过，修复后再发送` : undefined}
        >
          发送
        </button>
        {sendBlocked && (
          <span style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 600 }}>
            核对单 {failCount} 项未过，修复后再发送
          </span>
        )}
        <button className="em-btn" onClick={() => setMode('edit')} disabled={mode === 'edit'}>
          {mode === 'edit' ? '编辑中...' : '编辑'}
        </button>
        {msg && <span className={`msg${err ? ' err' : ''}`}>{msg}</span>}
      </div>
    </>
  );

  // 编辑面板内容（右侧独立卡片，无标题栏）：主题/正文/主图/提示词+生成图片/保存并预览
  const editorPane = (
    <div className="em-editor">
      <input type="text" placeholder="邮件主题" value={subj} onChange={(e) => setSubj(e.target.value)} />
      <textarea spellCheck={false} placeholder="邮件正文…" value={body} onChange={(e) => setBody(e.target.value)} />

      {heroUrl && (
        <div className="em-hero-wrap">
          <a href={heroUrl} target="_blank" rel="noreferrer" title="点击看大图">
            <img className="em-hero" src={heroUrl} alt="邮件主图" />
          </a>
        </div>
      )}

      <div className="em-prompt-row">
        <textarea
          spellCheck={false}
          className="em-prompt"
          placeholder="图片提示词（万相出图）…"
          value={imagePrompt}
          onChange={(e) => setImagePrompt(e.target.value)}
        />
        <button className="em-btn em-regen" onClick={onRegenImage} disabled={regenerating}>
          {regenerating ? '生成中…' : '生成图片'}
        </button>
      </div>

      <div className="em-foot">
        <button className="btn primary" onClick={() => setMode('preview')}>保存并预览</button>
      </div>
    </div>
  );

  // 两态统一 DOM（Figma 446:4589 / 446:6142）：
  // 预览态 = 左面板居中（右轨道塌缩）；编辑态 = 右轨道展开 → stage 变宽 → overlay 居中重排，
  // 左面板自然平滑左移（面板位置变化动效由 grid 列宽/间距 transition 驱动，无需 JS）
  if (!editOpen) return null;
  return (
    <div className="overlay open" onClick={(e) => { if (e.target === e.currentTarget) setEditOpen(false); }}>
      <div className={`em-stage${mode === 'edit' ? ' dual' : ''}`}>
        <div className="modal em-panel">
          <div className="m-head">
            <h3>邮件预览</h3>
            <button className="x" onClick={() => setEditOpen(false)} aria-label="关闭"><Close /></button>
          </div>
          <div className="m-body">{previewPane}</div>
        </div>
        <div className="modal em-panel em-panel-editor" aria-hidden={mode !== 'edit'}>
          <div className="m-body">{editorPane}</div>
        </div>
      </div>
    </div>
  );
}
