# RFC-072 Task Detail "Outputs" Tab Redesign — Plan（任务分解）

状态：Done（已实现，单 PR）。子任务内部强序（schema → runner → API → 前端）。

**落地记录**：migration `0037_rfc072_node_run_output_kind.sql`（additive nullable `kind TEXT`，journal idx 36）
+ `db/schema.ts` `nodeRunOutputs.kind` + `runner.ts` 落库写 `outputKinds?.[name] ?? null` + shared
`NodeRunOutputSchema.kind` + `task.ts` `getTaskNodeRuns` 透出 kind；前端 `lib/output-port.ts`
（`isFileOutputKind` / `isSingleLinePath`）+ `lib/clipboard.ts`（`copyText` + execCommand 回退）+
`lib/worktree-download.ts`（`downloadWorktreeFile`，**复用** RFC-071 已落在 `WorktreeFilesPanel` 的
`worktreeFileDownloadUrl` / `downloadBaseName` 导出，未改其文件）+ `TaskOutputPanel.tsx` 两栏重写
+ `styles.css` `.task-outputs-panel*` 命名空间（删旧 `.task-output-card*` / 240px 截高）+ i18n
`taskOutputs.download/downloading/downloadFailed` cn/en。测试：shared 1（4 case）+ backend 3
（migration 2 + runner persist 1 + api mapper 2 + upgrade-rolling HEAD 36→37）+ frontend 4
（output-port 5 + clipboard 4 + 组件 5 + source-guard 4）。**协调**：RFC-071「工作目录文件下载」
并行进行中（uncommitted），用户拍板「复用不改其文件」。

## 子任务

### 后端：让 output kind 流到前端

- **RFC-072-T1**（migration）：新增 `packages/backend/db/migrations/0037_rfc072_node_run_output_kind.sql`
  —— `ALTER TABLE node_run_outputs ADD COLUMN kind TEXT;`。同步 `db/migrations/meta/_journal.json`
  追加一条（核对当前 idx，最新 0036 → 本迁移 0037）。依赖：无。
- **RFC-072-T2**（schema）：`packages/backend/src/db/schema.ts` `nodeRunOutputs` 加 `kind: text('kind')`。
  依赖：T1。
- **RFC-072-T3**（runner 持久化）：`packages/backend/src/services/runner.ts` 落库 loop（`:1081-1091`）
  写 `kind: opts.agent.outputKinds?.[name] ?? null`，`onConflictDoUpdate.set` 同步加 `kind`。
  依赖：T2。
- **RFC-072-T4**（shared schema）：`packages/shared/src/schemas/task.ts` `NodeRunOutputSchema` 加
  `kind: z.string().nullable().optional()`。依赖：无（可与 T1 并行）。
- **RFC-072-T5**（API mapper）：`packages/backend/src/services/task.ts` `getTaskNodeRuns` mapper
  （`:1361`）输出 `kind: o.kind`。依赖：T2 + T4。

### 前端：重画 Outputs tab

- **RFC-072-T6**（纯函数）：新增 `packages/frontend/src/lib/output-port.ts`
  （`isFileOutputKind` / `isSingleLinePath`）。依赖：T4（用 `tryParseKind`，已在 shared）。
- **RFC-072-T7**（clipboard）：新增 `packages/frontend/src/lib/clipboard.ts`（`copyText` + execCommand 回退）。
  依赖：无。
- **RFC-072-T8**（共享下载原语，与 RFC-071 协调）：`packages/frontend/src/lib/worktree-download.ts`
  （`worktreeFileDownloadUrl` / `downloadBaseName` / `downloadWorktreeFile`：blob fetch + Authorization
  头 + `a[download]`）。**单一实现**：若 RFC-071 先合，把其落在 `WorktreeFilesPanel.tsx` 的两纯函数
  上提到本 lib 并让 `WorktreeFilesPanel` 改 import（最小重构，不删其逻辑）；若本 RFC 先合，建好供
  RFC-071 import。见 design.md §3.1「与 RFC-071 协调」。依赖：无（用 `@/stores/auth`）。
- **RFC-072-T9**（面板重写）：重写 `packages/frontend/src/components/TaskOutputPanel.tsx` 为两栏
  （左 `__list` 端口 listbox + 右 `__detail`），接 `kind`，接 T6/T7/T8。`collectPorts` 不动。
  依赖：T4/T5/T6/T7/T8。
- **RFC-072-T10**（CSS）：`packages/frontend/src/styles.css` 加 `.task-outputs-panel*` 命名空间
  （对齐 `.worktree-files-panel`），删旧 `.task-outputs__grid` + `.task-output-card*`。依赖：T9。
- **RFC-072-T11**（i18n）：`i18n/{en-US,zh-CN}.ts` `taskOutputs` 加 `download` / `downloadFailed`
  （cn/en 对称）；复用 `common.copy/copied/empty`。依赖：T9。

### 测试

- **RFC-072-T12**（shared 测试）：`node-run-output-kind-schema.test.ts`（kind 三形态 + 类型拒绝）。依赖：T4。
- **RFC-072-T13**（backend 测试）：`migration-0037-output-kind.test.ts`（列存在/可空/旧行 NULL）+
  `runner-output-kind-persist.test.ts`（markdown_file 端口 kind 落库 + undeclared→NULL + API 透出）+
  `upgrade-rolling.test.ts` HEAD count +1。依赖：T1/T3/T5。
- **RFC-072-T14**（frontend 纯函数测试）：`output-port.test.ts` + `clipboard.test.ts` +
  `worktree-download.test.ts`（`worktreeFileDownloadUrl` / `downloadBaseName`；与 RFC-071 共用，
  已存在则合并不重写）。依赖：T6/T7/T8。
- **RFC-072-T15**（frontend 组件 + 守门测试）：`task-output-panel.test.tsx`（两栏 / 选中 / copy /
  download 条件 / pending / empty）+ `task-output-panel-source-guards.test.ts`（无 `max-height:240px`
  / 无 `.task-outputs__grid` / 复制经 `copyText` / 两栏类存在）。依赖：T9/T10/T11。

### 收尾

- **RFC-072-T16**：`bun run typecheck && bun run test && bun run format:check` + `bun run lint` 全绿；
  更新 `design/plan.md` RFC 索引 Draft → Done；更新 `STATE.md`（顶部进行中行 → 完工行）；commit +
  push，按 [feedback_post_commit_ci_check] 查 CI（含 e2e）。

## 依赖图（简）

```
T1 → T2 → T3
       └→ T5 ← T4
T4 → T6 ─┐
T7 ──────┤
T8 ──────┤→ T9 → T10/T11 → T15
T5 ──────┘
T4 → T12 ; T1/T3/T5 → T13 ; T6/T7 → T14
全部 → T16
```

## 验收清单

- [ ] AC-1 两栏 + 默认选第一项 + 点选切换
- [ ] AC-2 详情撑满高度、长输出在详情区滚动（无 240px 截高）
- [ ] AC-3 pending / (empty) 占位语义保留
- [ ] AC-4 copy 在安全 / 非安全上下文都 work（execCommand 回退）、null 时禁用、成功显示已复制
- [ ] AC-5 文件 kind（path<ext>/markdown_file，单行路径）才出下载按钮
- [ ] AC-6 下载触发浏览器下载、文件名=basename、失败可见
- [ ] AC-7 单仓 / 多仓一致
- [ ] AC-8 视觉对齐既有页（btn/muted/EmptyState、不落自写 chrome）
- [ ] AC-9 旧任务 NULL kind → 纯文本无下载、不报错
- [ ] AC-10 每项改动带测试、三件 gate + lint 全绿

## 估算

≈ 2–4 工作日（后端 5 处小改 + 1 additive 迁移；前端 1 组件重写 + 3 纯函数文件 + CSS/i18n；
测试 shared 1 + backend 3 + frontend 4 文件）。
