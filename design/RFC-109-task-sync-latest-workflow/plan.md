# RFC-109 任务分解 — 任务工作流热同步

> 读法：先 `proposal.md` → `design.md` → 本文。子任务编号 `RFC-109-T*`。

## PR 拆分建议

- **PR-A（数据层 + 服务核心 + 校验）**：migration 0050、`resumeKick` 抽取、`syncTaskWorkflow`、`extra` 白名单扩展、`diffWorkflowForSync` 纯函数 + 全部 backend/shared 测试。可独立交付（无前端依赖）。
- **PR-B（路由 + 前端）**：preview/sync 端点、`WorkflowSyncBanner` + `WorkflowSyncDialog`、Task 序列化加 `workflowVersion`、i18n、前端测试、e2e。依赖 PR-A。

> 默认两 PR 强序（A→B）。若 review 要求，可把纯函数 diff 单独前置；但 diff 同时被 service 预览与前端用，合在 PR-A 更连贯。

## 子任务

### PR-A

- **RFC-109-T1｜migration 0050 + schema + startTask**
  - `db/migrations/0050_rfc109_task_workflow_version.sql`：`ALTER TABLE tasks ADD COLUMN workflow_version INTEGER;`
  - `schema.ts` `tasks` 加 `workflowVersion: integer('workflow_version')`（nullable）。
  - `task.ts` `startTask` INSERT 在 `workflowSnapshot:` 邻接写 `workflowVersion: workflow.version`（行号以字段名为锚，RFC-108 后已漂）。
  - **shared `TaskSchema`（`shared/src/schemas/task.ts`）加 `workflowVersion: z.number().nullable()`**（Codex 附；原无版本字段，Task 序列化要带）。
  - `_journal.json` +1 档；`upgrade-rolling.test.ts` journal 断言 +1。
  - 验收：AC-12。门禁含 binary smoke（0050 嵌入、无模块环）。
  - 依赖：无。

- **RFC-109-T2｜shared `sync-workflow` 事件 + lifecycle `extra` 白名单**（Codex F6）
  - **shared `lifecycle.ts`**：`TaskTransitionEvent` ADT 加 `{ kind: 'sync-workflow' }`；`targetForTaskEvent`→`'pending'`；`nextTaskStatus` `case 'sync-workflow'` allowed-from = `['failed','interrupted','done','canceled','awaiting_review','awaiting_human']`（`never` 穷举强制补全两个 switch）。
  - **backend `lifecycle.ts`**：`TaskStatusUpdateExtra` 的 `Pick` 追加 `'workflowSnapshot' | 'workflowVersion'`。
  - 测试：`allowedFromForTaskEvent({kind:'sync-workflow'})` = 全 6 非活跃态（源码穷举）；`workflow_snapshot`/`workflow_version` 可经 extra 写、`status` 仍不可走私（s14 不削弱）。
  - 验收：AC-11。依赖：T1（schema 有列）。

- **RFC-109-T3｜`resumeKick` 抽取（事件式 + rollbackStatuses，resume 零回归）**
  - 把 `resumeTask` 的 active 检查 + 状态闸 + CAS + 回滚 + 拉起抽成内部 `resumeKick(db,id,deps,{event,extra?,rollbackStatuses,reason,conflictCode})`。
  - CAS 走 `transitionTaskStatusByEvent({event, allowTerminal:true, extra:{清错误四元组,...extra}})`（Codex F6）。
  - 回滚走新 `selectSyncRollbackTargets(runs, rollbackStatuses)`（top-level/freshest-per-node/status∈rollbackStatuses/排除 RFC-095 wrapper-canceled 复活行）；`resumeTask` 传 `['failed','interrupted']` 时与既有 `selectResumeRollbackTargets` 字节等价。
  - `resumeTask` 改薄壳：`resumeKick({event:{kind:'resume'}, rollbackStatuses:['failed','interrupted'], reason:'resumeTask', conflictCode:'task-not-resumable'})`。新增 `worktreePath===''` 早退（AC-10）。
  - 测试：既有 resume 全套作回归网（行为字节不变）；新增 worktree-missing 早退 case。
  - 依赖：T2（事件已入表）；与 T4 同文件合并实现。

- **RFC-109-T4｜`syncTaskWorkflow` 服务**（含 Codex F3/F4/F5/F7 闸）
  - `services/task.ts` 加 `syncTaskWorkflow(db,id,deps&{expectedVersion})`：load workflow（删→`workflow-deleted`）→ **版本 TOCTOU**（`version!==expectedVersion`→`workflow-sync-preview-stale` F5）→ `validateWorkflowDef`（error→`workflow-invalid`）→ **同定义短路**（canonical 相等→`workflow-sync-noop` F7）→ **wrapper 结构变更 + live 行**（→`wrapper-structure-changed-with-live-state` F3）→ `resumeKick({event:{kind:'sync-workflow'}, extra:{workflowSnapshot,workflowVersion}, rollbackStatuses:['failed','interrupted','canceled'], reason:'syncTaskWorkflow', conflictCode:'task-not-syncable'})`。
  - 测试：`rfc109-sync-task-workflow.test.ts`——原子换快照、CAS 失败不改快照、六态放行、running/pending 拒、新增节点派发、failed+新 prompt 重跑、D2 保留 fresh 不重跑、**stale 下游级联重跑**（F1）、**canceled 写节点先回滚再复活**（F4）、版本 TOCTOU/同定义短路/wrapper 阻断/删/invalid/并发 各错误码。
  - 验收：AC-1/2/3/8/9。依赖：T1/T2/T3。

- **RFC-109-T5｜`diffWorkflowForSync` 纯函数**（Codex F1/F2/F3）
  - `shared/src/workflow-sync-diff.ts`：`diffWorkflowForSync(oldDef,newDef,runSummary:Map<nodeId,NodeRunSyncSummary>)` → `WorkflowSyncDiff`（added/removed/modified/**warnings**/**blockers**/differs）。`NodeRunSyncSummary = {hasCompletedRun, producedPorts, hasLiveWrapperState}`。
  - 测试：`workflow-sync-diff.test.ts`——分类、`differs` 字节比较、`dangling-input-port` **基于 producedPorts**（端口改名命中、声明齐全但旧 run 无新名产出仍命中）、`new-upstream-into-completed-node`（F1）、`removed-node-feeds-downstream`、`wrapper-structure-changed-with-live-state` blocker 正反例（结构变+live 行命中 / 仅改内节点 prompt 不命中）、modified.completed 随 runSummary。
  - 验收：AC-5。依赖：无（被 T6 路由与 PR-B 前端共用）。

### PR-B

- **RFC-109-T6｜preview + sync 路由 + Task 序列化**
  - `routes/tasks.ts`：`GET /api/tasks/:id/workflow-sync-preview`（visibilityCheck；据 `canViewResource`/删/状态 给 `syncable`+`reason`；附 `validateWorkflowDef` 的 `invalid`；查 `node_run_outputs`/`node_runs` 组 `runSummary`〔producedPorts/hasLiveWrapperState〕后调 `diffWorkflowForSync`）；`POST /api/tasks/:id/sync-workflow`（body `{expectedVersion}`；`assertTaskWorkflowNotBuiltin` + `requireResourceView(workflow)`〔不可见 404 F8〕 → `syncTaskWorkflow`）。
  - Task 序列化加 `workflowVersion`。
  - 测试：`rfc109-sync-route.test.ts`——preview 各分支（syncable/differs/invalid/reason/blockers）、sync built-in 403 / 不可见 404 / 版本 stale 409 / 成功 200 翻 pending。
  - 验收：AC-4/6/7/10。依赖：T4/T5。

- **RFC-109-T7｜前端 `WorkflowSyncBanner` + `WorkflowSyncDialog`**
  - `components/tasks/WorkflowSyncBanner.tsx`：query preview；`syncable && differs` 显示 `.task-error-banner`（信息态配色）+「同步并继续」按钮开弹窗。
  - `components/tasks/WorkflowSyncDialog.tsx`：复用 `Dialog`（footer），展示版本号（vN→vM）+ added/removed/modified（chips/`DiffViewer` 同款）+ warnings + **blockers**；`invalid` 或 `blockers` 非空时**禁用确认**并列原因；确认 `POST sync-workflow`（body 带 preview 的 `latestVersion` 作 `expectedVersion`）+ 失效 query；收 `workflow-sync-preview-stale` 409 时刷新预览重提示。
  - 接入 `tasks.detail.tsx`（`StuckTaskBanner` 之后）；活跃 / 未变 / worktree 缺失 / 不可见时不渲染。
  - i18n `en-US.ts`/`zh-CN.ts` `tasks.syncWorkflow.*` 中英对称。
  - 测试（vitest）：横幅显隐（`findByRole`）、弹窗渲染 + invalid 禁用、mutation 成功失效 query、源码层不出现原生 modal chrome。
  - 验收：AC-13。依赖：T6。视觉对齐自查（与 /tasks、/workflows side-by-side）。

- **RFC-109-T8｜e2e + 收尾**
  - Playwright：launch → 编辑工作流（改某节点/加下游节点）→ 任务页见横幅 → 同步 → 断言新定义生效（新节点出现 / 失败节点用新 prompt）。
  - `api-contract-coverage` 登记新端点；STATE.md 落档、plan.md RFC 索引状态改 Done。
  - 依赖：T1–T7。

## 验收清单（汇总）

- [ ] AC-1 原子换快照+版本（CAS 内）
- [ ] AC-2 续跑语义：新增派发 / 已完成保留 / failed 用新定义重跑
- [ ] AC-3 六态可同步、running/pending 拒
- [ ] AC-4 preview 形态全分支
- [ ] AC-5 diff 纯函数 + 两类警告
- [ ] AC-6 built-in 403
- [ ] AC-7 工作流可见性 / 任务成员 ACL
- [ ] AC-8 workflow-deleted / workflow-invalid
- [ ] AC-9 并发 CAS 恰一胜、零副作用
- [ ] AC-10 worktree 缺失干净错误
- [ ] AC-11 extra 白名单 +2 字段、s14 不削弱
- [ ] AC-12 migration 0050 + startTask 写版本 + journal
- [ ] AC-13 前端横幅 + 弹窗 + i18n + 视觉对齐
- [ ] 门禁：`bun run typecheck && bun run test && bun run format:check` 全绿 + CI（lint + test×2OS + binary smoke×2OS + Playwright e2e + 静态扫描）
- [ ] Codex 双 gate：设计 gate（本三件套）+ 实现 gate（代码）各 fold
- [ ] STATE.md / plan.md RFC 索引同步

## 风险与缓解

- **`resumeKick` 抽取回归**：resume 是高敏感路径（RFC-014/096/097/098 多次加固）。缓解：逐字搬移、不改逻辑；既有 resume 全套测试为回归网；先抽取（T3）跑绿再加 sync（T4）。
- **`extra` 白名单扩面**：可能被误读为「放开 status 走私」。缓解：仅加两业务列、s14 源码断言显式锁 `status` 仍封闭。
- **RFC-108 合流**：两者碰 resume/lifecycle。缓解：本 RFC 不引入转移表、改动最小且加性；design §5 显式登记合流约定。
- **预览警告漏报**：纯函数启发式无法穷尽所有静默丢数据。缓解：明确标注「best-effort 风险提示，非保证」；端口/删节点两类高频场景先覆盖。
