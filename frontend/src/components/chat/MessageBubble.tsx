'use client';

import type { Message } from '@/lib/types';
import { TOUR_IMG } from '@/lib/chat-flow';

/** 单条对话气泡：agent（品牌橙头像）或 user（靛蓝头像「我」）；badge 可选（如 E1 拦截轮「建议」角标）
 *  agent 气泡支持 F5 导览配图：内容命中 TOUR_IMG 任一句 → 文本下方渲染对应示意图（缺图 onError 隐藏）
 *  「· XX——」开头的清单行（UX 481-7578）：从纯文本拆出，渲染为前面带勾选框的横向等间距响应式布局 */

const CHECKBOX_RE = /^·\s*(.+)$/;

function splitChecklist(content: string) {
  const lines = content.split(/\n/);
  const checklist: { label: string; desc: string }[] = [];
  const before: string[] = [];
  const after: string[] = [];
  let inChecklist = false;
  for (const line of lines) {
    const m = line.match(CHECKBOX_RE);
    if (m) {
      inChecklist = true;
      const [label, ...desc] = m[1].split('——');
      checklist.push({ label: label.trim(), desc: desc.join('——').trim() });
    } else if (inChecklist) {
      after.push(line);
    } else {
      before.push(line);
    }
  }
  return { before: before.join('\n'), checklist, after: after.join('\n') };
}

function Checklist({ items }: { items: { label: string; desc: string }[] }) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: '8px',
      margin: '8px 0', padding: 0,
    }}>
      {items.map((item, i) => (
        <div key={i} style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          padding: 0, borderRadius: 0,
          fontSize: '14px', fontWeight: 400, color: 'var(--text)',
          flex: '1 1 auto', minWidth: '80px', maxWidth: '100%',
        }}>
          <span style={{
            width: '12px', height: '12px', borderRadius: '3px',
            border: '1.5px solid var(--muted)', flexShrink: 0,
          }} />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function MessageBubble({ m, badge }: { m: Message; badge?: string }) {
  const tourImg = m.role === 'assistant' && m.content
    ? Object.entries(TOUR_IMG).find(([line]) => m.content.includes(line))?.[1]
    : undefined;
  const parsed = m.role === 'assistant' && m.content ? splitChecklist(m.content) : null;
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="avatar user">我</div>
        <div className="bubble">{m.content}</div>
      </div>
    );
  }
  // agent 侧去掉头像，气泡背景透明（10-08 用户指令：布局不变、去聊天 UI 视觉元素）
  return (
    <div className="msg agent bare">
      <div className="bubble">
        {badge && (
          <div style={{ marginBottom: 4 }}>
            <span style={{
              fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '1px 8px',
              color: 'var(--muted)', background: 'var(--bg-input)', border: '0.5px solid var(--line)',
            }}>{badge}</span>
          </div>
        )}
        {parsed && parsed.checklist.length >= 2 ? (
          <>
            {parsed.before && <>{parsed.before}<br /></>}
            <Checklist items={parsed.checklist} />
            {parsed.after}
          </>
        ) : (
          m.content
        )}
        {tourImg && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={tourImg}
            alt="导览示意图"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
            style={{ display: 'block', marginTop: 8, maxWidth: 300, borderRadius: 8, border: '0.5px solid var(--line)' }}
          />
        )}
      </div>
    </div>
  );
}
