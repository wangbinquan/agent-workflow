# RFC-191 · 任务分解

单 PR（`feat(frontend): RFC-191 工作流/工作组列表画廊化`），任务顺序即实现顺序。

## 任务

- **RFC-191-T1 `<RelativeTime>` 原语落地**
  `lib/relative-time.ts`（`relativeTimeToken`，双向阈值表）+ `components/RelativeTime.tsx`（`<time dateTime title>`；`ts: number | string` 契约，NaN 兜底 em dash；模块级共享 `useNowTick(30_000)` ticker——静态页无 refetch 也持续推进）+ `common.relTime.*` zh/en key + `lib/homepage.ts#formatRelativeTime` 改 delegate（token 形状不变，`homepage-lib.test.ts` 保持绿）。
  测试：`relative-time.test.ts` 阈值边界 + string/NaN + fake-timer ticker + delegate 兼容。
  依赖：无。**RFC-192 依赖本任务。**

- **RFC-191-T2 画廊公共组件**
  `components/gallery/ResourceGalleryPage.tsx`（含 `notice` 槽）+ `GalleryCard`（基于 `Card`，stretched-link 模式；徽标不抬升、仅 ops 抬升）+ styles.css `.gallery` / `.gallery-card` 命名空间段 + `Form.tsx#TextInput` 最小扩展（`type` / `aria-label` / `className` 透传）供搜索框使用。
  测试：`gallery-page.test.tsx`（三态 / 过滤 / 空态不渲染搜索框 / notice 槽次序 / 链接与启动按钮 role 断言）+ TextInput 兼容单测。
  依赖：T1。

- **RFC-191-T3 workflows 页迁移**
  `routes/workflows.tsx` 装配 items（描述 / vN / 节点数 / 启动深链 `?kind=workflow&workflow=<id>`）；导入 YAML + QuickCreate（含 `createOpenRef` 守卫）原样迁入槽位；行内删除移除。i18n 追加 `workflows.cardNodes` / `workflows.noDescription`。
  测试：`workflows-pages.test.tsx` 重写（design §6-3）。
  依赖：T2。

- **RFC-191-T4 workgroups 页迁移**
  `lib/workgroup-mode.ts`（`WORKGROUP_MODE_KIND` 映射）+ `routes/workgroups.tsx` 装配（模式语义色 / 成员数 / leader / 全自动 chip / 启动深链，启动按 shared `workgroupLaunchReadiness` 门禁——not-ready 不渲染）；删除 Dialog 与行内删除退役。i18n 追加 `workgroups.cardMembers` / `workgroups.cardLeader` / `workgroups.autonomousChip` / `workgroups.noDescription`。
  测试：`workgroups-pages.test.tsx` 重写（含 not-ready 门禁断言）+ 映射表单测。
  依赖：T2。

- **RFC-191-T5 共享件收缩与锁清扫**
  `ResourceNameCell.to` 联合收缩（移除两页 entry）+ `resource-list-shell.test.tsx` 更新；新增 `gallery-callsite.test.ts` 反向锁（两页禁 `data-table`）；`empty-loading-callsite` / `page-hint-removal` / `i18n-phase-a` / `chip-row-vertical-center` 命中集复核。
  依赖：T3、T4。

- **RFC-191-T6 视觉自查与全量门**
  minimal-repro 明暗截图与 `/agents` side-by-side 对齐（按钮高度/圆角/间距/字号）；`bun run typecheck && bun run lint && bun run test && format:check` + frontend vitest + Playwright e2e（确认 `workflows.png` 基线零 churn）；`bun run build:binary` smoke。
  依赖：T5。

## 验收清单

- [ ] 两页卡片画廊上线，proposal §6 六条验收全过；
- [ ] `common.relTime.*` 原语被两页使用，homepage token 锁不红；
- [ ] 删除入口收敛详情层，列表无删除按钮，相关既有测试改写完毕；
- [ ] 空态字节不变（visual-regression 零基线更新）；
- [ ] 五门全绿 + binary smoke + Codex 实现门（[feedback_codex_review_after_changes]）。
