'use client';

import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import Modal from '@/components/ui/Modal';

/** 登录 / 注册弹窗 —— 对应 #authModal + authSubmit。切换由 authMode 驱动。 */
export default function AuthModal() {
  const { authOpen, setAuthOpen, authMode, setAuthMode, authSubmit } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState(false);
  // 受控 state 在浏览器/密码管理器 autofill 时可能不触发 onChange（state 仍空），
  // 提交时以 input DOM 真实值为准兜底，避免「填了却报邮箱密码为空」。
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (authOpen) { setMsg(''); setErr(false); }
  }, [authOpen, authMode]);

  const onSubmit = async () => {
    const e = (emailRef.current?.value ?? email).trim();
    const p = passwordRef.current?.value ?? password;
    const n = (nameRef.current?.value ?? name).trim();
    const r = await authSubmit(e, p, n);
    if (r !== true) { setMsg(r); setErr(true); }
  };
  const isReg = authMode === 'register';

  return (
    <Modal open={authOpen} onClose={() => setAuthOpen(false)} title={isReg ? '登录 / 注册' : '登录'} width="min(380px,100%)">
      <div className="m-body">
        <div className="auth-field">
          <input ref={emailRef} type="email" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input ref={passwordRef} type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
          {isReg && <input ref={nameRef} type="text" placeholder="昵称（仅注册时填）" value={name} onChange={(e) => setName(e.target.value)} />}
        </div>
      </div>
      <div className="m-foot">
        <button className="btn primary" onClick={onSubmit}>{isReg ? '注册并登录' : '登录'}</button>
        <button className="btn ghost" onClick={() => setAuthMode(isReg ? 'login' : 'register')}>{isReg ? '切到登录' : '切到注册'}</button>
        {msg && <span className={`msg${err ? ' err' : ''}`}>{msg}</span>}
      </div>
    </Modal>
  );
}
