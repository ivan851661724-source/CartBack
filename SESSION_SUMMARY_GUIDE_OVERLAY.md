# 新手引导浮层化重构 · 小结（2026-09-12）

> 本批改动将原顶栏 `HintPill` 串联式引导，重构为**分步聚焦式浮层引导**（蒙层 spotlight 镂空 + 右侧气泡 + 最后一步居中完成弹窗），并对引导文案、镂空描边、完成弹窗位置做了打磨。海报下线 / design.md 样式对齐 / 描边收细等打磨项见同目录 [`SESSION_SUMMARY_2026-09-12.md`](./SESSION_SUMMARY_2026-09-12.md)。

## 1. 引导浮层组件（新增）

- **`frontend/src/components/shell/GuideOverlay.tsx`（新增）**：核心组件。
  - 蒙层 spotlight：`box-shadow: 0 0 0 100vmax rgba(75,85,105,.42)` 镂空目标元素，蒙层色 `#4B5569 @42%`。
  - 步骤 1–3（`onboardingStep 0-2`）右侧气泡（280px，空间不足自动翻到左侧），2 秒后蒙层渐隐。
  - 步骤 4（`onboardingStep 3`）：完成弹窗 + 常驻蒙层。
  - 锚点靠 `data-guide-target`（撰写区 / 侧栏邮件配置 / 侧栏数据看板），rAF 轮询兜底布局抖动。
  - 自动跳步：step1→2（点邮件配置）、step2→3（点数据看板）；step0→1 由 ChatView 收集完成触发。
- **`frontend/src/app/page.tsx`**：挂载 `<GuideOverlay />` 到全局浮层区。
- **`frontend/src/components/shell/Sidebar.tsx`**：邮件配置 / 数据看板导航项加 `data-guide-target` 锚点。
- **`frontend/src/components/shell/Topbar.tsx`**：`HintPill` 退化为「仅非引导态显示 needs 进度」；引导态文案与跳步逻辑全部移交 `GuideOverlay`，移除顶栏内置 `ONBOARDING_TEXTS` 与 `setOnboardingStep` 跳步。

## 2. ChatView 引导期 checklist + 自动跳步

- **`frontend/src/components/chat/ChatView.tsx`**：
  - 引导期右侧机会栏改显 `OnboardingChecklist`（圆勾选 + 标签 + 已填短值 + 虚线分隔 + 进度条 + 完成按钮），引导走完 / 跳过后切回 `OpportunityCard`。
  - 步骤 1→2 自动跳步 effect：10 项 `BRAND_POINTS` 收集完 + 回复结束 + `planCard` 就绪 → 推进步骤 2 并生成草稿，保持 `planShown='confirm'`（确认卡持久化），不切 tab（由气泡指向侧栏让用户点）。
  - chip 改用 `BRAND_POINTS`，streaming 时禁用；快捷描述词从内联数组迁出到常量。
  - 确认卡样式从硬编码橙边 / 内联色 → 变量（`var(--line-2)` / `var(--muted)` / `var(--brand-soft)`），描边 `1px→0.5px`，橙色强调边 `2px→1px`。

## 3. 常量抽取

- **`frontend/src/lib/constants.ts`**：
  - 新增 `BRAND_POINTS`（10 项品牌基础信息：`key` / `label` / `msg` / `val`），chip 与 checklist 共用。
  - 新增 `ONBOARDING_TEXTS`（步骤 0–3 气泡文案），`GuideOverlay` 复用。

## 4. 本日引导微调（基于上述重构）

| 项 | 位置 | 改动 |
| --- | --- | --- |
| 步骤 2 文案 | `constants.ts` `ONBOARDING_TEXTS[1]` | `…查看要点，选好受众和折扣后点「发送」。` → `太棒了！点左侧「邮件配置」查看邮件详情` |
| 步骤 3 文案 | `constants.ts` `ONBOARDING_TEXTS[2]` | 去掉开头的「邮件已发出！」 |
| 镂空描边 | `GuideOverlay.tsx` spotlight | 所有步骤移除 `0 0 0 2px var(--brand)` 描边，仅留蒙层 |
| 完成弹窗居中 | `globals.css` `.guide-done-overlay` / `.guide-done-modal` | `align-items:flex-end→center`（纵横居中）；圆角 `16px 16px 0 0→16px`；阴影 `0 -12px→0 12px` |

## 5. 同批已纳入的打磨项（详见 SESSION_SUMMARY_2026-09-12.md）

- 邮件预览弹窗：移除海报画廊 → 改展示主图（`EditModal.tsx` + `server.js` 不再入队 posters）。
- `design.md` 样式规范对齐：圆角归档 / 内联色对齐调色板 / 暖调清理（`--bg-table`）。
- 描边 / 分割线收细 1px→0.5px。
- `igde.js` `s0Open()` 开场白文案更新。

## 验证

- 前端 `npx tsc --noEmit` 通过。
- 引导步骤编号映射：用户口语「步骤 N」= `onboardingStep N-1`；步骤 1 撰写区、2 邮件配置、3 数据看板、4 完成弹窗。
