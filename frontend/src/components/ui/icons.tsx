/**
 * CartBack 共用 SVG 图标 —— 路径与 flow.html / app.js 逐字符一致。
 * 父级 CSS（globals.css）按选择器给 svg 设定尺寸/描边/填充，故组件只输出 <svg viewBox>。
 */
import React from 'react';

type P = { className?: string };
const S = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <svg viewBox="0 0 24 24" className={className}>{children}</svg>
);

/** 侧栏五模块图标 */
export const NavChat = () => <S><path d="M21 12a8 8 0 0 1-8 8H5.5a2 2 0 0 1-2-2V11a8 8 0 0 1 8-8h1.5a8 8 0 0 1 8 8z" /><path d="M8.5 10h7M8.5 13.5h4.5" /></S>;
export const NavMail = () => <S><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3.5 7l8.5 6 8.5-6" /></S>;
export const NavData = () => <S><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></S>;
export const NavAud = () => <S><circle cx="9" cy="8" r="3.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17.5" cy="9" r="2.5" /><path d="M16 14.2c2.6.5 4.5 2.6 4.8 5.3" /></S>;
export const NavSet = () => <S><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" /></S>;

/** CartBack 品牌箭头（对话头像 / chat head / 机会 / 叙事 / 统计 brand 等） */
export const Arrow = () => <S><path d="M4 12h11M12 6l6 6-6 6" /></S>;

/** 发送 */
export const Send = () => <S><path d="M4.5 11.5l15-7-4.5 15-4-6z" /><path d="M11 13.5l9-9" /></S>;
/** 关闭 */
export const Close = () => <S><path d="M6 6l12 12M18 6L6 18" /></S>;
/** 对勾 */
export const Check = () => <S><path d="M5 13l4 4L19 7" /></S>;
/** 闪电火花（确认卡头） */
export const Spark = () => <S><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" /></S>;
/** 笔（方案主题） */
export const Pen = () => <S><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></S>;
/** 地球（语种跟随） */
export const Globe = () => <S><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></S>;
/** 信息（受众注释） */
export const Info = () => <S><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></S>;
/** 下载（导入） */
export const Download = () => <S><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 19h16" /></S>;
/** 警告（异常条） */
export const Alert = () => <S><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18.5v.5" /></S>;
/** 机会提醒 */
export const Bell = () => <S><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8" /><path d="M10 21h4" /></S>;
/** 邮件（统计 brand 图标） */
export const Mail = () => <S><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3.5 7l8.5 6 8.5-6" /></S>;
/** 触达对勾圈（统计 ok 图标） */
export const ReachCheck = () => <S><circle cx="9" cy="8" r="3.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M17 9l2 2 4-4" /></S>;

/** 侧栏底部品牌方块箭头（带显式白描边） */
export const FootArrow = () => (
  <svg viewBox="0 0 24 24"><path d="M4 12h11" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" /><path d="M12 6l6 6-6 6" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
