# RFC-011 — 节点 Prompt 历史可见性 · 任务分解

PR 拆分：单 PR 合并 T1 + T2 + T3。commit message 前缀
`feat(task-ui): RFC-011 节点 prompt 历史可见性`。

---

## RFC-011-T1 · Backend review iterate / reject 改 mint 新行

依赖：无。

**改动文件**

- `packages/backend/src/services/review.ts`
  - `submitReviewDecision` 内 reject / iterate 分支（约 1038-1065 行）
    替换"`update(nodeRuns).set({status:'pending'})`"为：
    1. 老行 `update(... set({status:'canceled', finishedAt, errorSummary, errorMessage}))`
    2. `db.insert(nodeRuns).values({ id:ulid(), ...retryIndex:+1, status:'pending', preSnapshot:latest.preSnapshot, parentNodeRunId:null })`
- `packages/backend/tests/reviews-iterate-mints-new-run.test.ts` — 新文件，
  顶部注释链 RFC-011 + 说明 "locks: review iterate / reject 不得就地覆写
  上游 promptText，必须 mint retry_index+1 行"。
  case 列表：
  - "iterate keeps old run as canceled and preserves promptText"
  - "iterate mints a new pending row at retry_index+1 with inherited preSnapshot"
  - "reject does the same + sibling cascade still toggles other review rows to awaiting_review"

**验收**

- `bun run --filter @agent-workflow/backend test` 全绿（含上面 3 case）
- `bun run --filter @agent-workflow/backend typecheck` 全绿
- 既有 review 相关测试不回归（review-decisions / review-rollback / e2e）

---

## RFC-011-T2 · Frontend Prompt tab 加 attempts 切换器

依赖：T1 可并行实现，合并前与 T1 一起跑全套。

**新文件**

- `packages/frontend/src/lib/node-prompt.ts`
  - `export function sortNodeRunsForPromptHistory(runs: NodeRun[]): NodeRun[]`
  - `export function isPromptCapableKind(kind: string | null | undefined): boolean`
  - `export function formatAttemptLabel(run: NodeRun, t: TFunction, opts: { fanoutParent: boolean }): string`

**改动文件**

- `packages/frontend/src/components/NodeDetailDrawer.tsx`
  - `Props` 加 `nodeId: string | null` + `workflowNodeKind: string | null`
  - 重写 `PromptTab`：按 §4.2 逻辑（attempts picker + fan-out parent 分支 +
    N/A 分支 + 空 promptText 分支）
- `packages/frontend/src/routes/tasks.detail.tsx`
  - 顶层提升 `definition` useMemo（目前在 TaskStatusCanvas 内）到
    `TaskDetailPage` 主体；
  - 给 drawer 多传 `nodeId={runs.find(r => r.id === selectedNodeRunId)?.nodeId ?? null}`
    - `workflowNodeKind={kindFor(definition, that.nodeId)}`
  - `TaskStatusCanvas` 继续接收 definition 作 prop（避免重复 useMemo）
- `packages/frontend/src/styles.css`
  - 加 `.prompt-history` / `.prompt-history__picker` / `.prompt-history__select` 三规则
- `packages/frontend/src/i18n/en-US.ts` + `zh-CN.ts`
  - 新 keys：
    - `nodeDrawer.promptAttemptLabel`
    - `nodeDrawer.promptAttemptEntry`
    - `nodeDrawer.promptAttemptShard`
    - `nodeDrawer.promptFanoutParent`
    - `nodeDrawer.promptNotApplicable`
    - `nodeDrawer.promptEmpty`

**新测试文件**

- `packages/frontend/tests/prompt-history-sort.test.ts` — 5 case 覆盖
  sortNodeRunsForPromptHistory + isPromptCapableKind + formatAttemptLabel
  纯函数。
- `packages/frontend/tests/node-drawer-prompt-history.test.tsx` — 6 case
  覆盖 §6.2 列表。
- `packages/frontend/tests/node-drawer-prompt-source.test.ts` — 3 case
  源代码层兜底（按 [feedback_post_commit_ci_check] 风格）：
  - `NodeDetailDrawer.tsx` 不再含 `run.promptText === null` 旧分支
  - `NodeDetailDrawer.tsx` 含 `prompt-history__select`
  - `NodeDetailDrawer.tsx` 引用 `isPromptCapableKind`

**验收**

- `bun run --filter @agent-workflow/frontend typecheck && test` 全绿
- `bun run format:check` 全绿
- 既有 frontend 测试不回归（`tests/node-inspector.test.tsx` 等不动）

---

## RFC-011-T3 · 文档 / i18n / STATE / RFC index 同步

依赖：T1 + T2 完成后再做。

**改动文件**

- `design/design.md`
  - §7.4 review 状态机增补一段："review reject / iterate 重新调度上游节点时，
    通过 mint 新 `node_run` (retry_index+1) 而非就地覆写实现 prompt 历史保留；
    老行标记 status=canceled + errorSummary='superseded-by-review-{decision}'"。
  - §5 node_runs 行语义段落（如已存在）增补：同一 (taskId, nodeId, iteration)
    可由 retries + review iterate 累积多条 retry_index 行。
- `design/plan.md`
  - RFC 索引表追加 RFC-011 行（标题 + 状态 Draft → 实现后改 In Progress
    → 合并后改 Done）。
- `STATE.md`
  - 顶部"进行中 RFC"段加 RFC-011 一行（实现完毕后改 Done 并入"已完成 RFC"表）。

**验收**

- `git diff design/ STATE.md` 三处条目齐全
- 合并 PR 后立即按 [feedback_post_commit_ci_check] 查 GitHub Actions
  build-binary + e2e + lint+typecheck+test 三套全绿。

---

## 总验收清单（PR 合并前）

- [ ] T1 backend：review iterate / reject 改 mint 新行 + 3 case 测试
- [ ] T2 frontend：Prompt tab attempts 切换器 + N/A 分支 + 14 case 测试（5+6+3）
- [ ] T3 文档：design.md / plan.md RFC 索引 / STATE.md 同步
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] commit message: `feat(task-ui): RFC-011 节点 prompt 历史可见性`
- [ ] push 后立刻查 GitHub Actions（lint+typecheck+test × {macos,ubuntu} +
      build-binary × 2 + e2e × 2）全绿
