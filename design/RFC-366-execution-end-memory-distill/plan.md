# RFC-366 任务分解

## 0. PR 拆分建议

单 RFC 单 PR（CLAUDE.md §RFC workflow 第 5 条默认形态），commit 前缀
`feat(memory): RFC-366 执行结束记忆提炼 + 任务来源准入门`。

理由：契约（枚举 / 迁移 / 配置）与两个触发点强耦合——拆开会留下「枚举已扩容但无人写入」
或「挂点已接但 CHECK 拒插」的中间态。若实现过程中体量失控，按下面的分组切成
**PR-A（契约 + 准入门 + 现有四类回归）** / **PR-B（两个新源 + 内容装载 + prompt）** /
**PR-C（前端 + e2e）**，并在本文件记录实际切法。

## 1. 子任务

### 契约层

- **RFC-366-T1** — `shared`：`DISTILL_SOURCE_KINDS` / `DistillSourceKindSchema` /
  `DISTILL_SOURCE_CONFIG_KEY`；`MemoryDistillJobSchema.sourceKind` 与
  `MemorySourceKindSchema` 换新枚举。
  依赖：无。测试：`shared/tests` 补映射逐字断言。

- **RFC-366-T2** — `shared`：config 三个新键 + `memoryDistillSourceContext` 四个可选预算 +
  `DEFAULT_SOURCE_CONTEXT_BUDGET` 补齐 + `resolveSourceContextBudget()` +
  `SETTINGS_NUMERIC_BOUNDS.memoryDistillAgentRunDebounceMs` + `ConfigPatchSchema` 三项。
  依赖：T1。测试：存量两键 config 仍能解析（**向后兼容回归**）、默认值逐项、
  `settings-bounds-parity` 守卫仍绿。

- **RFC-366-T3** — 迁移三件：`db/migrations/0228_rfc366_distill_source_kinds.sql`（SQLite 整表
  重建，注意 `memory_distill_events` 的 FK）、
  `db/postgresql-migrations/0004_rfc366_distill_source_kinds.sql`、
  `db/schema.ts` 两处 `enum:` 与两处 `check()`。
  依赖：T1。测试：`migration-0228-distill-source-kinds.test.ts`（见 design §10.5）。

### 准入门（memory domain / application）

- **RFC-366-T4** — `memory/domain/distillAdmission.ts`：`distillAdmission()` 纯函数 +
  `DistillRejectReason` + `DistillTaskFacts`。
  依赖：T1。测试：`rfc366-distill-admission.test.ts`（15 例，含全部禁用分支）。

- **RFC-366-T5** — `ports/distillWorkStore.ts`：`MemoryDistillTaskScopeRecord` 扩
  `launchOrigin` / `catalogVisibility` / `spaceKind`；
  `infrastructure/memoryDistillWorkStore.ts` 的 `findTaskScope` 投影同步扩（不加查询）。
  依赖：T4。

- **RFC-366-T6** — `application/distill/schedule.ts`：`DistillPolicy` + policy provider
  （吸收既有 lang provider）+ `enqueueDistillJob` 接准入闸、返回 `EnqueueResult | null` +
  `buildDebounceKey` 的 agent-run 分支 + `computeEligibleScopes` 的 `narrowAgentId` 参数 +
  agent 去抖窗口解析。
  依赖：T4、T5。测试：`rfc366-distill-debounce-key.test.ts`。

- **RFC-366-T7** — 四个既有调用方适配 `null` 返回：
  `clarify/autoDispatch.ts`、`collaborationCommittedEventConsumers.ts`、
  `collaboration/application/taskFeedback.ts`（跳过 `markDistilled`）、
  `modules/memory/composition.ts` 的 `distillCommands.enqueue` 签名。
  依赖：T6。测试：AC-15（留言被拒时 `distilled=false` / `distillJobId=null`）。

- **RFC-366-T8** — `cli/start.ts`（两处）+ `cli/postgresqlDaemonApplication.ts`：
  注册热读 policy provider，删除旧 lang provider 的全部调用点。
  依赖：T6。

### 新触发源

- **RFC-366-T9** — task-run consumer：`taskLifecycleConsumers.ts` 加
  `task-terminal-distill-enqueue`（`done|failed` + `!continuationHandoff`）+
  `enqueueTaskRunDistill` 依赖项；bootstrap 三处装配。
  依赖：T6。测试：`rfc366-task-terminal-consumer.test.ts`。

- **RFC-366-T10** — agent-run observer：
  `task-execution/application/ports/agentRunSettledObserver.ts` +
  `SchedulerState.opts.agentRunSettled?` + `nodeMechanics.ts` 结算点调用（终态过滤在此）+
  bootstrap 三处装配（组 observer、解析后转交 enqueuer）。
  依赖：T6。测试：`rfc366-agent-run-observer.test.ts`。

- **RFC-366-T11** — `enqueueDistillJob` 内的 agent id 解析（`nodeId` → snapshot →
  `agentRefOfNode`），含 quarantine / name-only / workgroup 三条回落。
  依赖：T6、T10。测试：折进 T6 的 debounce-key 用例。

### 内容装载

- **RFC-366-T12** — 端口 + adapter：五个新读方法
  （`listAgentRunSources` / `listNodeRunOutputs` / `listTaskRunSources` /
  `listTaskNodeStatuses` / `listTaskFinalOutputs`），SQLite + PostgreSQL 同一份实现。
  依赖：T1。

- **RFC-366-T13** — 抽 `renderNodeRunTranscript(store, runIds, maxBytes)`，
  clarify 既有路径改调它（**行为必须逐字不变**）。
  依赖：无。测试：既有 `memory-distiller-source-context.test.ts` 不改断言仍全绿。

- **RFC-366-T14** — `loadSourceEvents` 扩 `agentRun` / `taskRun` 两路 +
  `buildUserPrompt` 两个渲染分支 + 四个新预算接线。
  依赖：T12、T13。测试：`rfc366-source-context.test.ts`。

- **RFC-366-T15** — `domain/distillPrompt.ts`：枚举扩容 + `sourceRefs.kind` 扩容 +
  source-specific guidance 段落；同步更新 prompt 哈希基线与十类前缀 grep 锁。
  依赖：T1。测试：`memory-distiller.test.ts` / `memory-distiller-grep-output-lang-directive.test.ts` 更新。

### 前端

- **RFC-366-T16** — i18n：两个 `memory.sourceKind.*` + 设置页 label/hint（en-US / zh-CN 各约 14 key）。
  依赖：T1。

- **RFC-366-T17** — `routes/settings.tsx` 记忆卡片三组控件（白名单 5×Switch / 逐源 5×Switch /
  去抖 NumberInput）+ `lib/settings-drafts.ts` 草稿字段。**全部复用 `<Field>` / `<Switch>` /
  `<NumberInput>`**，不新写 CSS。
  依赖：T2、T16。测试：`rfc366-settings-distill-policy.test.tsx`。

- **RFC-366-T18** — `lib/memory.ts` 的 `sourceKindLabel` 两个分支 +
  `MemoryDistillJobsTable` 筛选下拉两个选项。
  依赖：T16。测试：`rfc366-distill-source-labels.test.tsx`。

### 收口

- **RFC-366-T19** — e2e `e2e/rfc366-execution-end-distill.spec.ts`（手工任务产出两类源；
  取消勾选 `manual` 后不再产出）。
  依赖：T9、T10、T17。

- **RFC-366-T20** — 文档收口：`design/plan.md` RFC 索引状态改 Done；`STATE.md` 已完成表加行；
  通用坑（若有）写进 `docs/dev-gotchas.md`。
  依赖：全部。

## 2. 依赖图

```
T1 ─┬─ T2 ── T17
    ├─ T3
    ├─ T4 ── T5 ── T6 ─┬─ T7
    │                  ├─ T8
    │                  ├─ T9 ──┐
    │                  ├─ T10 ─┼─ T19
    │                  └─ T11  │
    ├─ T12 ─┐                  │
    ├─ T15  ├─ T14             │
    └─ T16 ─┴─ T18             │
         T13 ─┘                │
                        T17 ───┘
                               └─ T20
```

## 3. 验收清单

实现完成后逐条对照 `proposal.md` §7：

- [ ] AC-1 … AC-18（功能）
- [ ] AC-19 … AC-21（回归防护）
- [ ] §6 能力影响清单 C1–C7 每条各有一条**拒绝分支测试**（design §10.1 / §10.2）
- [ ] 两个 provider（SQLite / PostgreSQL）的迁移各自跑通
- [ ] `bunx prettier --check` + `bunx eslint --max-warnings 0` 对本次改动文件
- [ ] push 后按 exact SHA 盯 GitHub Actions 到绿（CLAUDE.md §Test-with-every-change 运行门槛）
- [ ] Codex 实现门跑一遍（**只审功能，禁止安全检视**）并修 findings

## 4. 残债 / 后续

- 本 RFC 不做 per-agent / per-workflow 级别的提炼开关；若候选噪声仍高，下一 RFC 考虑
  在 agent frontmatter 加 `distill: false` opt-out。
- `memoryDistillerEnabled` / `memoryDistillSourceContext` 仍是启动快照（本 RFC 未改）；
  与新配置的热读形成两种先例共存，留作后续统一。
- 内部任务（C7）目前硬拒、无开关。若后续要放开，加第六个白名单条目 `internal`。
