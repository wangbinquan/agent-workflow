# RFC-051 — 任务分解

整体一个 PR 即可（改动面较小：1 新 rehype 插件 + Prose 接 prop + 2 路由
小补丁 + 7 case 测试）。commit 顺序见 `design.md §7`。

## 子任务

### RFC-051-T1 — rehype 插件 + Prose 接 anchors prop
- `packages/frontend/src/components/prose/rehypeWrapAnchors.ts` 新文件
  （见 design.md §3.1）；用 `unist-util-visit` + `@types/hast`（均已
  作为 react-markdown 的间接依赖在 lockfile 里，无需新增 package）。
- `packages/frontend/src/components/prose/Prose.tsx`：`ProseProps` 加
  可选 `anchors?: ReadonlyArray<AnchorWrapInput>`；`useMemo<PluggableList>`
  在末尾追加 `[rehypeWrapAnchors, { anchors }]`（仅当 anchors 非空）。
- 测试 `packages/frontend/tests/prose-anchors-prop.test.tsx`（2 case）：
  - case 1：未传 vs `anchors=[]` outerHTML 字节级一致。
  - case 2：occurrenceIndex=2 精确锁第 N 个 occurrence。
- 验收：`bun run test` 全绿；既有 `Prose` 调用方（编辑器 preview / memory
  body / distill-job-detail / homepage 等）行为零变化。

### RFC-051-T2 — review-detail 切流 + 删 wrapAnchorsInDom 调用
- `packages/frontend/src/routes/reviews.detail.tsx`：
  - 删 `wrapAnchorsInDom` import + L512-523 `useLayoutEffect`。
  - 新 `const anchors = useMemo(() => sortedComments.map(c => ({
    commentId: c.id, selectedText: c.anchor.selectedText,
    occurrenceIndex: c.anchor.occurrenceIndex})), [sortedComments])`。
  - `<Prose>` 调用加 `anchors={diffMode ? undefined : anchors}`。
- `packages/frontend/src/lib/review/wrapAnchorsInDom.ts` **不动**——仍被
  `anchor.ts` 选区→anchor 计算使用。
- 测试 `packages/frontend/tests/reviews-detail-anchor-rehype.test.tsx`
  （3 case，见 design.md §6.2）。
- 验收：A→B→A 重入不抛；review-detail.tsx 不再含 `wrapAnchorsInDom(`
  调用文本；既有 review-detail / prose-reviews-detail / bubble-redesign
  / cross-heading-hint 测试零退化。

### RFC-051-T3 — clarify nodeRunId 复位
- `packages/frontend/src/routes/clarify.detail.tsx`：在 seeding effect
  之前新加一个 `useEffect(..., [nodeRunId])`，复位 `answers={}` /
  `draftLoaded=false` / `initialFocusedRef.current=false` / 清理
  `draftTimerRef`。
- 测试 `packages/frontend/tests/clarify-detail-nodeRunId-switch.test.tsx`
  （2 case，见 design.md §6.1）。
- 验收：连续点收件箱反问 A → 反问 B，B 的 QuestionForm 正常渲染；
  既有 `clarify-detail-route.test.tsx` 三 case 零退化。

### RFC-051-T4 — 三件套 + push + CI 检查
- 本地 `bun run typecheck && bun run test && bun run format:check` 全绿。
- 按多人协作原则**精确路径** `git add`（4 源文件 + 3 测试文件 + 3 设计文件 +
  STATE.md + design/plan.md RFC 索引更新）。
- commit：`fix(inbox): RFC-051 anchor 走 react 树 + clarify nodeRunId 复位`。
- push origin/main；按 `feedback_post_commit_ci_check` 拉
  `gh run list --branch=main --limit=1` 看六 jobs。

## 验收清单

- [ ] AC-1：clarify nodeRunId 切换后新 session 的 QuestionForm 渲染（T3 case 1）。
- [ ] AC-2：review mark 由 React 渲染（T2 case 1）。
- [ ] AC-3：review A→B→A 不抛 + 高亮跟新 anchor 走（T2 case 2）。
- [ ] AC-4：`reviews.detail.tsx` 不再含 `wrapAnchorsInDom(` 调用（T2 case 3 grep 守卫）。
- [ ] AC-5：本地 typecheck + test + format:check 三件套全绿；CI 六 jobs 全绿。
- [ ] 既有 11+ 条 review / clarify / prose 套件零退化。

## 显式不做（防 scope creep）

- 不动 `wrapAnchorsInDom.ts` 模块本身（anchor.ts 仍依赖其辅助函数）。
- 不给 `<Prose>` 在编辑器 / memory / distill 等老调用方加 anchors prop。
- 不动 backend / shared / DB / WS / i18n / Playwright e2e（前台改造闭环）。
- 不给 TanStack Router 加路由级 `key={nodeRunId}` 全局策略。
