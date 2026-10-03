'use client';

import { useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { initial } from '@/lib/format';
import NotificationBell from './NotificationBell';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

/** 顶栏：logo / 停发徽标 / 引擎徽标 / 模式徽章 / 登录·头像 / 重置 —— 对应 flow.html .topbar */
// 09-30 引导收敛：needs 进度 pill（HintPill）与快捷词引导均已移除，采集进度改由对话流承载（F1/F4）。
export default function Topbar() {
  const { status, me, engine, global_paused, blackout, setAuthOpen, setAuthMode, authLogout, resetData } = useApp();
  const real = status?.mode === 'real';

  // 引擎健康态（done 帧与 GET /api/state 更新；缺省 online）：degraded 时提示去设置页检查模型 Key
  const degraded = engine === 'degraded';

  // Wave3 停发徽标（PRD I2「看得见才不会忘」）：全局停发（红）/ 停发日历命中（橙）常驻顶栏，
  // 两者并存时都显示；解除方式只有对话里明说（title 提示），顶栏不给解除按钮（防误触恢复发送）。
  const paused = Boolean(global_paused);
  const bo = blackout && blackout.active ? blackout : null;
  // 徽标文案取第一个命中区间：停发日历 · {label} {from}~{to}
  const boRange = bo?.ranges?.[0];
  const boLabel = [boRange?.label, boRange?.from && boRange?.to ? `${boRange.from}~${boRange.to}` : ''].filter(Boolean).join(' ');

  // 自定义确认弹层（09-30 报告 P2-2：原生 window.confirm 阻塞自动化点击且风格不一）：
  // 登出 / 重置两类确认统一走 ConfirmDialog
  const [confirmAsk, setConfirmAsk] = useState<'logout' | 'reset' | null>(null);

  const onUser = () => {
    if (me?.user) {
      setConfirmAsk('logout');
    } else {
      setAuthMode('login');
      setAuthOpen(true);
    }
  };

  const onReset = () => {
    setConfirmAsk('reset');
  };

  return (
    <header className="topbar">
      <div className="logo">
        <span className="logo-name">Cart<b>Back</b></span>
      </div>

      <span className="spacer" />
      {/* 停发徽标（常驻）：全局停发红 / 停发日历橙，位于引擎徽标旁；点击提示解除方式（对话里明说） */}
      {paused && (
        <span className="pause-pill" title="全局停发生效中：所有批次暂停发送。对话里说『恢复吧』/『撤掉停发』可解除">
          <span className="dot" />
          全局停发中
        </span>
      )}
      {bo && (
        <span className="blackout-pill" title={`停发日历生效中${boLabel ? `（${boLabel}）` : ''}：命中区间内批次顺延。对话里说『恢复吧』/『撤掉停发』可解除`}>
          <span className="dot" />
          停发日历{boLabel ? ` · ${boLabel}` : ''}
        </span>
      )}
      {/* Z7 通知铃铛：未读角标 + 下拉列表（打开即全部已读；60s 轮询 + loadState 顺带刷新） */}
      <NotificationBell />
      {/* 引擎徽标：在线（绿）/ 降级模式（橙，title 引导去设置页检查模型 Key） */}
      <span
        className={`engine-pill${degraded ? ' degraded' : ''}`}
        title={degraded ? 'AI 未连接：请联系管理员检查服务端 AI 配置（环境变量 CARTBACK_AI_KEY 等）' : '引擎在线'}
      >
        <span className="dot" />
        {degraded ? '降级模式 · AI 未连接' : '在线'}
      </span>
      <span className={`mode-pill${real ? ' real' : ''}`}>{real ? '真实' : '演示'}</span>
      <button className="tbtn" onClick={onUser} title={me?.user ? (me.user.name || me.user.email) : ''}>
        {me?.user ? '登出' : '登录'}
      </button>
      {me?.user && (
        <div
          className="t-avatar"
          title={me.user.name || me.user.email}
          style={{ display: 'flex' }}
        >
          {initial((me.user.name || me.user.email)).toUpperCase()}
        </div>
      )}
      <button className="tbtn" onClick={onReset}>重置</button>

      {/* 自定义确认弹层（P2-2）：登出 / 重置，ESC / 遮罩 / 取消均可关闭 */}
      <ConfirmDialog
        open={confirmAsk === 'logout'}
        title="退出登录"
        message="退出后需要重新登录才能继续使用，当前会话进度会保留在服务端。"
        confirmLabel="退出"
        onConfirm={() => { setConfirmAsk(null); authLogout(); }}
        onCancel={() => setConfirmAsk(null)}
      />
      <ConfirmDialog
        open={confirmAsk === 'reset'}
        title="重置全部数据"
        message="确定重置全部数据？对话 / 邮件 / 看板数据会被清空，假种子受众会重新生成。"
        confirmLabel="重置"
        danger
        onConfirm={() => { setConfirmAsk(null); resetData(); }}
        onCancel={() => setConfirmAsk(null)}
      />
    </header>
  );
}
