# RFC-075 — 任务分解与 PR 拆分

> 读前置：proposal.md / design.md。两个正交能力（A 工作分支 / B 自动
> commit&push）可分 PR 落地，B 依赖 A 的 shared/迁移地基但不依赖 A 的运行时。

## PR 拆分（建议 3 PR，强序）

- **PR-A（shared + DB + 能力 A 工作分支）**：可独立发布、独立有价值（只创建/
  复用工作分支 + 详情展示），不含自动提交。
- **PR-B（能力 B 自动 commit&push 运行时）**：依赖 PR-A 的 schema/迁移；
  scheduler 触发 + 框架 git + 修复循环 + commit 节点。
- **PR-C（前端会话视图 + Settings + e2e）**：依赖 PR-B 的 `commit_push_json`
  与会话捕获；commit 行弹窗、Settings 三控件、Playwright。

（若想更小步，可把"工作分支"和"commit&push 开关持久化但不触发"在 PR-A 一起
落，PR-B 只加触发与执行——下方任务已按此切。）

## PR-A：工作分支 + 地基

- **RFC-075-T1（shared）**：扩 `StartTaskSchema`（`workingBranch?` +
  `autoCommitPush?`，含 superRefine：working 仅在单一 task 级、与 repos[] 正交）；
  扩 `TaskSchema`/`TaskSummarySchema`（`workingBranch` / `autoCommitPush`）；
  新增 `CommitPushMetaSchema` + 扩 `NodeRunSchema.commitPush?`（PR-A 先建类型，
  PR-B 才写值）。单测：schema round-trip + 校验拒绝（空格/非法分支名/缺省）。
- **RFC-075-T2（migration）**：`00NN_rfc075_*.sql`——`tasks.working_branch` /
  `tasks.auto_commit_push DEFAULT 0` / `task_repos.working_branch` /
  `node_runs.commit_push_json`；drizzle schema 同步；journal idx +1；backfill
  测试（存量行 working_branch NULL / auto_commit_push 0）。
- **RFC-075-T3（util/git）**：`materializeWorkingBranch`（§4.1 全分支：新建 /
  复用-merge / 冲突 / fetch 失败 / in-use / 未填走旧 createWorktree）+
  `git check-ref-format` 校验封装。单测覆盖六分支 + grep guard 锁
  `agent-workflow/${taskId}` 仍在。
- **RFC-075-T4（services/task.ts）**：startTask/materialize 接 workingBranch，
  per-repo loop 调 `materializeWorkingBranch`；持久化 `working_branch` /
  `auto_commit_push`（task + task_repos）；working 路径 base-fetch 失败收紧为
  启动失败（仅此路径）。集成测试（path + url 模式 × 新建/复用）。
- **RFC-075-T5（routes/tasks）**：接受新 body 字段；422 codes
  （`working-branch-invalid` / `working-branch-in-use` /
  `working-branch-base-merge-conflict` / `working-branch-base-fetch-failed`）。
- **RFC-075-T6（getTask/列表）**：`Task.workingBranch` / `autoCommitPush` 注入；
  多仓逐仓 working/base。
- **RFC-075-T7（前端·启动表单 + 详情展示）**：「工作分支」TextInput +
  「自动提交推送」Switch（默认关，localStorage 记忆）；任务详情展示
  working/base（多仓逐仓）。RTL + i18n cn/en。

PR-A 验收：AC-1〜AC-7、AC-21（表单/详情部分）。

## PR-B：自动 commit & push 运行时

- **RFC-075-T8（新 services/commitPush.ts）**：纯/半纯逻辑——
  `shouldTriggerCommit(status, envelopeKind)` 真值表；
  `classifyPushFailure(stderr)`；diff 截断；fallback message 组装；
  `buildCommitMessagePrompt`。全单测。
- **RFC-075-T9（commit 节点执行器）**：合成 node_run（nodeId 约定 +
  parentNodeRunId）→ `git add -A` / stat / 起内置 commit agent 会话拿 message
  （复用 runner + sessionCapture）/ `git -c user.* commit`（RFC-067 身份）/
  `git push`；写 `commit_push_json`。集成（mock-opencode + 临时 bare remote）。
- **RFC-075-T10（修复循环）**：push 失败分类 → 鉴权降级 / 非快进有界合并 /
  规范拒收→修复会话→amend→重推；`retryIndex`/`repairAttempts`/上限
  `commitPushMaxRepairRetries`。集成（remote 装 pre-receive hook 模拟规范拒收
  + 指向只读 remote 模拟鉴权失败 + 耗尽路径）。
- **RFC-075-T11（scheduler 接线）**：在顶层 agent / wrapper done 后调
  `maybeCommitAfterTopLevelNode`（diff 驱动、多仓遍历、纳入写串行）；wrapper
  内部不触发。集成：多 port 单次提交 / 反问不提交 / readonly 跳过 / wrapper
  单次 / 多仓单仓 / 透明性 AC-17。
- **RFC-075-T12（内置 commit agent）**：固定 system prompt + outputs +
  `config.commitPushModel`。

PR-B 验收：AC-8〜AC-20。

## PR-C：会话视图 + Settings + e2e

- **RFC-075-T13（config.ts + loader）**：`commitPushModel` /
  `commitPushMaxRepairRetries`（默认 3）/ `commitPushDiffMaxBytes`（默认
  16384）+ backfill 默认。单测。
- **RFC-075-T14（前端·节点 commit 行 + 会话弹窗）**：`commit_push_json` 非空
  行渲染 + pushOutcome 小标 + 「查看会话」`<Dialog>` 内嵌 `SessionTab`（复用
  既有路由/组件）。RTL（getByRole）+ i18n。
- **RFC-075-T15（前端·Settings Git/提交分区）**：3 控件（Select/TextInput/
  NumberInput，走 Form primitives）。
- **RFC-075-T16（e2e）**：启动带工作分支 + commit&push 的任务 → 详情见
  working 名 + commit 行 + 打开会话弹窗。

PR-C 验收：AC-12（会话可见部分）、AC-21（全量）、Settings。

## 依赖

```
T1,T2 → T3 → T4 → T5,T6 → T7         (PR-A)
T1,T2 ─────────────→ T8 → T9 → T10 → T11   (PR-B)
                          T12 ┘
T9/T10(commit_push_json+会话) → T13,T14,T15 → T16   (PR-C)
```

## 验收清单（push 前逐项过）

- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] grep guard：`agent-workflow/${taskId}` 隔离分支未被误删
- [ ] AC-1〜AC-21 各有对应测试且绿
- [ ] migration backfill：存量任务字节级守恒（两开关默认关/空）
- [ ] 透明性：开/关 commit&push 跑同工作流，diff endpoint 逐字节一致
- [ ] 前端全走公共组件（Switch/TextInput/Dialog/StatusChip/Select），无原生
      元素 / 自写 chrome
- [ ] i18n cn/en 对称
- [ ] push 后立即查 GitHub Actions（[feedback_post_commit_ci_check]）
- [ ] STATE.md：落档时加"进行中 RFC-075"行；完工改 Done + 已完成表加行

## 估算

约 12-18 工作日（含测试 + 前端 + e2e）。与 RFC-066 同档（触及 DB/迁移 +
scheduler + 前端三层），但无 runtime 协议改动、无新节点 kind 枚举。
