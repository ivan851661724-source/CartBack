'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import Tag from '@/components/ui/Tag';

/** 设置四步向导（AI / ESP / 店铺 / 模式 / 偏好）+ danger zone —— 对应 flow.html #view-set + renderSet/saveConfig。 */
export default function SettingsView() {
  const { status, setMode, saveConfig, resetData, guideStyle, setGuideStyle, prefs } = useApp();
  const s = status || ({} as any);
  const [aiKey, setAiKey] = useState('');
  const [espKey, setEspKey] = useState('');
  const [espFrom, setEspFrom] = useState('');
  const [aiModel, setAiModel] = useState('deepseek-chat');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [shopBrand, setShopBrand] = useState('');
  const [msg, setMsg] = useState('');
  // G0 白名单（品牌名/专有名词，含中文品牌名；白名单内不拦截）
  const [g0Terms, setG0Terms] = useState<string[]>([]);
  const [g0Input, setG0Input] = useState('');
  // —— Z6 AI 助手偏好（读 /api/state 顶层 prefs；本波后端无偏好写入端点，保存走 /api/config 并回读验证） ——
  const [prefTone, setPrefTone] = useState('');
  const [prefDiscount, setPrefDiscount] = useState('');
  const [prefSignature, setPrefSignature] = useState('');
  const [prefsMsg, setPrefsMsg] = useState('');
  const [prefsBusy, setPrefsBusy] = useState(false);

  useEffect(() => {
    setAiKey(s.aiConfigured ? '••••••••' : '');
    setEspKey(s.espConfigured ? '••••••••' : '');
    setEspFrom(s.espFrom || '');
    setAiModel(s.aiModel || 'deepseek-chat');
    setAiBaseUrl(s.aiBaseUrl || '');
    setShopBrand(s.shopBrand || '');
    setG0Terms(Array.isArray(s.g0Whitelist) ? s.g0Whitelist : []);
  }, [status]);

  useEffect(() => {
    setPrefTone(typeof prefs?.tone === 'string' ? prefs.tone : '');
    setPrefDiscount(typeof prefs?.discount_habit === 'string' ? prefs.discount_habit : '');
    setPrefSignature(typeof prefs?.signature === 'string' ? prefs.signature : '');
  }, [prefs]);

  const onSave = async () => {
    await saveConfig({ aiKey, espKey, espFrom, aiModel, aiBaseUrl, shopBrand });
    setMsg('已保存（密钥仅存于服务端，不回传前端）');
  };

  const configStatus = `AI：${s.aiConfigured ? '已配置' : '未配置（离线桩模型）'} · ESP：${s.espConfigured ? '已配置（真实发送）' : '仿真发送'} · 发件域：${s.espFrom || '—'} · 模型：${s.aiModel || 'deepseek-chat'}`;

  // —— G0 白名单维护：增删术语后经 /api/config 保存（merchant 品牌名默认已含）——
  const addG0Term = async () => {
    const t = g0Input.trim();
    if (!t) return;
    if (g0Terms.includes(t)) { setG0Input(''); return; }
    const next = [...g0Terms, t].slice(0, 50);
    setG0Terms(next);
    setG0Input('');
    await saveWhitelist(next);
  };
  const removeG0Term = async (term: string) => {
    const next = g0Terms.filter((x) => x !== term);
    setG0Terms(next);
    await saveWhitelist(next);
  };
  const saveWhitelist = async (terms: string[]) => {
    try {
      const { api } = await import('@/lib/api');
      await api('/api/config', { method: 'POST', body: JSON.stringify({ g0Whitelist: terms }) });
      setMsg('白名单已更新');
      setTimeout(() => setMsg(''), 2000);
    } catch { setMsg('白名单保存失败'); }
  };

  // —— Z6 偏好保存：/api/config 是现有通用配置端点（g0Whitelist 先例），偏好以 { prefs: {...} } 同路写入。
  // 后端本波无偏好写入端点时 POST 可能 200 但被忽略——回读 /api/state 验证真实持久化情况，
  // 不造假成功：已持久化 → 「偏好已保存」；被忽略 → 「已记录（后端持久化即将支持）」。
  const onSavePrefs = async () => {
    setPrefsBusy(true);
    try {
      const { api } = await import('@/lib/api');
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ prefs: { tone: prefTone, discount_habit: prefDiscount, signature: prefSignature } }),
      });
      const st = await api<any>('/api/state');
      const p = (st && typeof st.prefs === 'object' && st.prefs) || {};
      const persisted = p.tone === prefTone && p.discount_habit === prefDiscount && p.signature === prefSignature;
      setPrefsMsg(persisted ? '偏好已保存' : '已记录（后端持久化即将支持）');
      setTimeout(() => setPrefsMsg(''), 3000);
    } catch {
      setPrefsMsg('保存失败，请稍后再试');
      setTimeout(() => setPrefsMsg(''), 3000);
    }
    setPrefsBusy(false);
  };

  const hasAnyPref = Boolean(prefs?.tone || prefs?.discount_habit || prefs?.signature);

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
            <div className="row">
              <input
                type="text"
                placeholder="接口基地址（OpenAI 兼容，如 Token Plan 专属地址）"
                value={aiBaseUrl}
                onChange={(e) => setAiBaseUrl(e.target.value)}
              />
            </div>
            <div className="s-desc">专属 Key 必须与专属基地址配套（如阿里 Token Plan 走通用 dashscope 地址不抵扣套餐）；模型示例：deepseek-v4-flash / qwen3.7-plus / glm-5.2。</div>
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
            <div className="s-head"><h3>品牌名称（白标）</h3><Tag kind={s.shopBrand && s.shopBrand !== 'CartBack' ? 'intent' : 'gray'}>{s.shopBrand && s.shopBrand !== 'CartBack' ? '已配置' : '待配置'}</Tag></div>
            <div className="s-desc">邮件落款、页脚版权、发件人名称统一用你的品牌（M4 白标）。未配置时回退方案卡品牌。</div>
            <div className="row">
              <input type="text" placeholder="如 Qin Pet Custom（留空 = 跟随方案卡）" value={shopBrand} onChange={(e) => setShopBrand(e.target.value)} />
              <button className="btn ghost sm" onClick={onSave}>保存</button>
            </div>
          </div>
        </div>

        <div className="setup-card glass-card">
          <div className="s-no">4</div>
          <div className="s-body">
            <div className="s-head"><h3>连接店铺（真实收件人源）</h3><Tag kind="default">即将支持</Tag></div>
            <div className="s-desc">Shopify / 店匠 / 通用 REST 统一连接器 · 接入后自动拉取真实顾客，语种跟随客户 locale。</div>
            <div className="row"><button className="btn ghost sm">暂用 CSV 导入代替</button></div>
          </div>
        </div>

        <div className="setup-card glass-card">
          <div className="s-no">5</div>
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

        <div className="setup-card glass-card">
          <div className="s-no">5</div>
          <div className="s-body">
            <div className="s-head"><h3>引导风格</h3><Tag kind={guideStyle === 'demo' ? 'intent' : 'gray'}>{guideStyle === 'demo' ? '演示硬编码' : '安全纯意图'}</Tag></div>
            <div className="s-desc">与运行模式解耦的独立开关。演示：硬编码 Leo&apos;s PhoneCase 快捷词 + 浮层蒙层引导，适合演示；安全：纯意图快捷词不覆盖真实品牌 + 顶栏串联引导，适合真实商家。仅前端、记忆本机。</div>
            <div className="row">
              <div className="seg">
                <button className={`seg-btn${guideStyle === 'demo' ? ' active' : ''}`} onClick={() => setGuideStyle('demo')}>演示（硬编码+浮层引导）</button>
                <button className={`seg-btn${guideStyle === 'safe' ? ' active' : ''}`} onClick={() => setGuideStyle('safe')}>安全（纯意图+顶栏引导）</button>
              </div>
            </div>
          </div>
        </div>

        <div className="setup-card glass-card">
          <div className="s-no">7</div>
          <div className="s-body">
            <div className="s-head"><h3>AI 助手偏好</h3><Tag kind={hasAnyPref ? 'intent' : 'gray'}>{hasAnyPref ? '已设置' : '默认'}</Tag></div>
            <div className="s-desc">语气 / 折扣习惯 / 署名——助手写邮件时沿用；留空 = 跟随对话推断。</div>
            <div className="row">
              <input
                placeholder="语气偏好，如：轻松一点、别太促销腔"
                value={prefTone}
                onChange={(e) => setPrefTone(e.target.value)}
              />
              <input
                placeholder="折扣习惯，如：最多打 85 折"
                value={prefDiscount}
                onChange={(e) => setPrefDiscount(e.target.value)}
              />
            </div>
            <div className="row">
              <input
                placeholder="邮件署名，如：Leo · Qin Pet"
                value={prefSignature}
                onChange={(e) => setPrefSignature(e.target.value)}
              />
              <button className="btn ghost sm" disabled={prefsBusy} onClick={onSavePrefs}>
                {prefsBusy ? '保存中…' : '保存'}
              </button>
              {prefsMsg && <span className="msg-ok">{prefsMsg}</span>}
            </div>
          </div>
        </div>

        <div className="setup-card glass-card">
          <div className="s-no">6</div>
          <div className="s-body">
            <div className="s-head"><h3>中文白名单（G0 语种护栏）</h3><Tag kind="default">{g0Terms.length} 个词条</Tag></div>
            <div className="s-desc">发往消费者的邮件默认零中文；品牌名 / 专有名词加进白名单后不拦截（店铺品牌名已自动包含）。</div>
            <div className="row">
              <input
                placeholder="如：老王家的锅"
                value={g0Input}
                onChange={(e) => setG0Input(e.target.value)}
                style={{ maxWidth: 220 }}
                onKeyDown={(e) => { if (e.key === 'Enter') addG0Term(); }}
              />
              <button className="btn ghost sm" onClick={addG0Term}>添加</button>
              {msg && <span className="msg-ok">{msg}</span>}
            </div>
            {g0Terms.length > 0 && (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {g0Terms.map((t) => (
                  <button key={t} className="btn ghost sm" onClick={() => removeG0Term(t)} title="点击移除">
                    {t} ×
                  </button>
                ))}
              </div>
            )}
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
