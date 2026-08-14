import type { Config } from 'tailwindcss';

/**
 * CartBack Elegance v4 设计 token —— 1:1 映射自 styles.css 的 :root CSS 变量。
 * 视觉保真约束：品牌橙 #FF7F4D / 玻璃卡 / 分层阴影 / 系统字体栈。
 * 复合组件类（.glass-card / .btn / .nav / .opp …）仍在 globals.css 原样保留，
 * 此处的 token 映射主要服务于新写的布局/间距原子类。
 */
const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/state/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: 'var(--brand)',
          2: 'var(--brand2)',
          deep: 'var(--brand-deep)',
          glow: 'var(--brand-glow)',
          soft: 'var(--brand-soft)',
        },
        bg: {
          DEFAULT: 'var(--bg)',
          sec: 'var(--bg-sec)',
          modal: 'var(--bg-modal)',
          table: 'var(--bg-table)',
          input: 'var(--bg-input)',
          hover: 'var(--bg-hover)',
        },
        card: 'var(--card)',
        line: { DEFAULT: 'var(--line)', 2: 'var(--line-2)' },
        text: { DEFAULT: 'var(--text)', muted: 'var(--muted)', soft: 'var(--soft)' },
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        danger: 'var(--danger)',
        indigo: 'var(--indigo)',
        amber: 'var(--amber)',
      },
      fontFamily: {
        disp: 'var(--font-disp)',
        ui: 'var(--font-ui)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
        topbar: 'var(--shadow-topbar)',
        btn: 'var(--shadow-btn)',
        'btn-hover': 'var(--shadow-btn-hover)',
      },
      transitionTimingFunction: {
        ease: 'var(--ease)',
      },
    },
  },
  plugins: [],
};

export default config;
