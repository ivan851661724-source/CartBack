'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import Tag from '@/components/ui/Tag';

/** 设置四步向导（AI / ESP / 店铺 / 模式）+ danger zone —— 对应 flow.html #view-set + renderSet/saveConfig。 */
export default function SettingsView() {
  const { status, setMode, saveConfig, resetData } = useApp();
  const s = status || ({} as any);
  const [aiKey, setAiKey] = useState('');
  const [espKey, setEspKey] = useState('');
  const [espFrom, setEspFrom] = useState('');
  const [aiModel, setAiModel] = useState('deepseek-chat');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setAiKey(s.aiConfigured ? '••••••••' : '');
    setEspKey(s.espConfigured ? '••••••••' : '');
    setEspFrom(s.espFrom || '');
    setAiModel(s.aiModel || 'deepseek-chat');
  }, [status]);

  const onSave = async () => {
    await saveConfig({ aiKey, espKey, espFrom, aiModel });
    setMsg('已保存（密钥仅存于服务端，不回传前端）');
  };

  const configStatus = `AI：${s.aiConfigured ? '已配置' : '未配置（离线桩模型）'} · ESP：${s.espConfigured ? '已配置（真实发送）' : '仿真发送'} · 发件域：${s.espFrom || '—'} · 模型：${s.aiModel || 'deepseek-chat'}`;

  return (
    <div className="view-body">
      <div className="phead">
        <h2>设置</h2>
        <span className="desc">一次性接好 · 之后只负责聊天和点确认</span>
      </div>
      <div className="setup-wrap">
        <div className="setup-card glass-card done">
          <div className="s-no">✓</div>
          <div className="s-body">
            <div className="s-head"><h3>连接 AI 助手</h3><Tag kind={s.aiConfigured ? 'intent' : 'gray'}>{s.aiConfigured ? '已连接' : '待配置'}</Tag></div>
            <div className="s-desc">开放式对话引擎（IGDE）在线 · 密钥仅存本机。</div>
            <div className="row">
              <input type="password" placeholder="sk-…（已保存，输入新值可替换）" value={aiKey} onChange={(e) => setAiKey(e.target.value)} />
              <input type="text" placeholder="deepseek-chat" style={{ maxWidth: 200 }} value={aiModel} onChange={(e) => setAiModel(e.target.value)} />
              <button className="btn ghost sm" onClick={onSave}>保存</button>
            </div>
          </div>
        </div>

        <div className="setup-card glass-card">
          <div className="s-no">2</div>
          <div className="s-body">
            <div className="s-head"><h3>连接发信服务（ESP）</h3><Tag kind={s.espConfigured ? 'intent' : 'price'}>{s.espConfigured ? '已连接' : '待配置'}</Tag></div>
            <div className="s-desc">配置后「确认发送」= 真实送达；未配置时走仿真发送，流程可完整体验。</div>
            <div className="row">
              <input type="password" placeholder="re_…（Resend 密钥）" value={espKey} onChange={(e) => setEspKey(e.target.value)} />
              <input type="text" placeholder="onear@yourdomain.com" style={{ maxWidth: 225 }} value={espFrom} onChange={(e) => setEspFrom(e.target.value)} />
              <button className="btn ghost sm" onClick={onSave}>保存</button>
            </div>
            <div className="config-status">{configStatus}</div>
            {msg && <span className="msg-ok">{msg}</span>}
          </div>
        </div>

        <div className="setup-card glass-card">
          <div className="s-no">3</div>
          <div className="s-body">
            <div className="s-head"><h3>连接店铺（真实收件人源）</h3><Tag kind="default">即将支持</Tag></div>
            <div className="s-desc">Shopify / 店匠 / 通用 REST 统一连接器 · 接入后自动拉取真实顾客，语种跟随客户 locale。</div>
            <div className="row"><button className="btn ghost sm">暂用 CSV 导入代替</button></div>
          </div>
        </div>

        <div className="setup-card glass-card">
          <div className="s-no">4</div>
          <div className="s-body">
            <div className="s-head"><h3>运行模式</h3><Tag kind={s.mode === 'real' ? 'intent' : 'gray'}>{s.mode === 'real' ? '真实' : '演示'}</Tag></div>
            <div className="s-desc">演示模式用仿真数据先看效果；真实模式只显示真实归因结果。</div>
            <div className="row">
              <div className="seg">
                <button className={`seg-btn${s.mode !== 'real' ? ' active' : ''}`} onClick={() => setMode('demo')}>演示（仿真回流）</button>
                <button className={`seg-btn${s.mode === 'real' ? ' active' : ''}`} onClick={() => setMode('real')}>真实（需 ESP 密钥）</button>
              </div>
            </div>
            {s.mode === 'real' && <div className="mode-warn show">切换到真实模式后，看板只显示真实归因数据；ESP 未配置前「确认发送」仅生成草稿。</div>}
          </div>
        </div>

        <div className="danger-zone">
          <span>重置全部数据（清空对话 / 邮件 / 看板）</span>
          <button className="btn ghost sm" style={{ color: 'var(--danger)', borderColor: 'var(--danger-bg)' }} onClick={resetData}>重置数据</button>
        </div>
      </div>
    </div>
  );
}
