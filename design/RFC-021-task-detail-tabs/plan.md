# RFC-021 — 任务分解

总计 7 个子任务，预期单 PR 落地。

| ID | 任务 | 依赖 |
| --- | --- | --- |
| RFC-021-T1 | 抽 `lib/task-detail-tabs.ts` 纯函数 + 改 `TaskOutputPanel.collectPorts` export + 改 `DiffViewer.splitByFile/lineClass` export + 新 `DiffFileBody` 子组件 + 纯函数单测 | — |
| RFC-021-T2 | 新建 `components/WorktreeDiffPanel.tsx`（两栏 + 竖向 file tab + selectedKey 自愈）+ 6 case 集成测试 | T1 |
| RFC-021-T3 | tasks.detail.tsx 重构 return（page header + banners + tab bar + 5 pane）+ jumpToFailed wire + worktree-diff pane 内嵌 `WorktreeDiffPanel` | T1, T2 |
| RFC-021-T4 | styles.css 加 page--task-detail / tab-bar / panes 规则 + canvas-frame--task tab 内 100% + `.worktree-diff` 两栏样式 | T3 |
| RFC-021-T5 | i18n 中英 +6 key（5 tabXxx + detailsHeading）+ worktree-diff 截断 / 空状态文案沿用现有 key 不改 | T3 |
| RFC-021-T6 | 集成测试 task-detail-page-tabs.test.tsx + CSS 契约 task-detail-layout-viewport-fit.test.ts | T3, T4 |
| RFC-021-T7 | STATE.md / design/plan.md RFC 索引同步 + commit + push + CI 复核（6 jobs 全绿） | T1..T6 |

## 验收清单（PR merge 前必须勾完）

- [ ] T1：`task-detail-tabs.test.ts` 6 case 全绿（含 `TAB_ORDER` 顺序、
      `availableTabs` 两态、`nextTabForFailedJump` 三态）。
- [ ] T1：`grep '^export function collectPorts'
      packages/frontend/src/components/TaskOutputPanel.tsx` 命中。
- [ ] T1：`grep '^export function splitByFile\|^export function lineClass\|
      ^export function DiffFileBody' packages/frontend/src/components/
      DiffViewer.tsx` 三处均命中。
- [ ] T2：`worktree-diff-panel.test.tsx` 6 case 全绿（3 文件默认选首、切
      tab、空 diff、truncated banner 位置、selectedKey 自愈、100 文件
      perf smoke）。
- [ ] T3：`tasks.detail.tsx` 渲染断言：
  - [ ] 默认 tab=workflow-status，pane 不带 `hidden`。
  - [ ] 切 details tab 后 dl.task-meta 出现、canvas pane 带 `hidden`。
  - [ ] jumpToFailed 同步切 tab + 设 selectedNodeRunId。
  - [ ] 切 worktree-diff tab + 3 文件 diff → 左栏出现 3 个 file tab。
- [ ] T4：CSS 契约 9 条断言（`.page--task-detail` 视口锁、`.task-detail__
      panes` flex / min-height、`.task-detail__pane[hidden]` display:none、
      `.worktree-diff` flex row + height 100%、`.worktree-diff__files`
      overflow + 固定宽、`.worktree-diff__body` flex 1 + overflow auto、
      `.worktree-diff__file-tab[aria-selected='true']` 选中态）。
- [ ] T5：6 个 i18n key 在 zh-CN.ts / en-US.ts 都有，类型签名同步加在
      `interface Tasks`。
- [ ] T6：4+1 case React Testing Library 集成测试通过（page tabs 4 case
      + worktree-diff file tab 1 case）。
- [ ] T7：`bun run typecheck && bun run lint && bun run format:check &&
      bun test && bun run --filter @agent-workflow/frontend test` 全绿。
- [ ] T7：push 后 CI 6 jobs 全绿（Lint+Typecheck+Test × {macos, ubuntu} +
      Build single-binary × {macos, ubuntu} + Playwright e2e × {macos,
      ubuntu}）。

## PR 拆分建议

**单 PR**。所有改动局限于 frontend，7 个子任务紧耦合（T1 抽函数 + T2 新
组件 + T3 page 重构 + T4 样式 + T5 文案 + T6 测试 + T7 落档），拆开
review 反而割裂。commit message：

```
feat(tasks): RFC-021 任务详情页 Tab 化（5 tab 页签 + worktree diff 竖向文件 tab）
```

## 风险点回顾

1. **xyflow viewport 丢失** — 用 `display: none` 切 tab 而非条件渲染解决。
2. **`hasOutputs` 计算与 TaskOutputPanel 漂移** — 强制 panel 导出
   `collectPorts`，page 与 panel 共用同一份解析逻辑。
3. **i18n 类型签名遗漏** — TS 在编译期会抓 missing key（i18n key 在
   `interface Tasks` 里都有强类型），typecheck 兜底。
4. **多人并发** — 工作树里 `tasks.detail.tsx` 当前有他人 modified 改动
   （RFC-007 review-output-drag follow-up）。落地前必须先 `git pull
   --rebase` 或确认这些是已知改动，避免覆盖。
