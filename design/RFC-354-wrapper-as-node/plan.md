# RFC-354 — 任务分解

## 1. PR 拆分（三个，均直接推 `main`，不建分支）

| PR   | 内容                                                                                               | 落地后的自洽态                                                                          |
| ---- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| PR-1 | **帧 + 闭包 + wrapper 参数**（零 schema 变更）：T1～T10                                              | 嵌套跑通、闭包 / 参数语义就位、画布渲染 loop / git 参数行；定义仍是 v5                     |
| PR-2 | **边模型 v6**：T11～T16                                                                              | PortRef 字段退役、loop 返回值 = 边界边、系统通道折表、升级器 + 32 golden、画布只写边        |
| PR-3 | **clarify 落行 + 展示 UX + 收口**：T17～T20                                                          | `settlesWithoutRow` 退役、任务详情面包屑 / 分组、e2e、实现门、Done                         |

每个 PR 推完按 exact SHA 盯 CI 到绿（`CLAUDE.md` §Test-with-every-change）。PR-2 依赖 PR-1（loop 返回值按帧提升、
exit 谓词按帧求值）；PR-3 依赖 PR-2（clarify 通道端口已在端口表）。

## 2. 任务

| 编号 | 任务                                                                                                                                                                                                                                                             | 依赖       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| T0   | 设计门（Codex，只审功能；用户决定是否跑）；findings 分「纯实现」与「设计方向」两堆，后者逐条呈用户                                                                                                                                                               | —          |
| **PR-1** |                                                                                                                                                                                                                                                              |            |
| T1   | shared：`nodePorts.ts` loop / git 边推导 `dataInputs`；`task-execution/domain/` 新增 `resolveInEnvironment` + `containerMemberRuns` 纯函数 + 表测                                                                                                                | —          |
| T2   | validator（PR-1 部分）：删 `wrapper-loop-nested` 与 loop / git 拒入边分支；新增 `wrapper-input-port-missing`（全 wrapper）/ `wrapper-fanout-unsupported-inner-kind`；前端 target 表 + zh/en 文案；两条棘轮；`rfc094` rule-1 翻转                                 | T1         |
| T3   | 迁移 0223 + contract：node_runs 两列 + 索引；clarify_rounds 一列 + 索引重建；`schemaContract.ts` + codec；`upgrade-rolling` 计数；journal prettier；RFC-349 写矩阵新列                                                                                          | —          |
| T4   | 回填 job + `aw doctor --backfill-containers`；oracle 测试（未命中 = 0）；`scope_path` ↔ `container_run_id` 守卫                                                                                                                                                | T3         |
| T5   | 帧身份接线：`MintNodeRunArgs` / `TaskScopeArgs` / `WrapperScopeDriverPort.drive` / `NodeExecutionQuery` / `wrapperRuns.findResumable` 加 `containerRunId`；`openGeneration` 按帧续接；fanout shard 行带帧；双 provider adapter                                    | T3         |
| T6   | 调度按帧读：frontier / freshness 帧过滤；`readPortRowAtIteration` / `resolveUpstreamInputs` 改调 `resolveInEnvironment`；`pickUpstreamSourceRun` 删窗口形参；gap4 runtime 分支改环境链；`closure-binding-unresolved`；源码守卫                                        | T1, T5     |
| T7   | `containerMemberRuns` 接入：`wrapperRevivalEvidence` / `innerRunsOf` / `retryNode` 级联 / `nodeRollback`；`topLevelOnly` → `excludeBornRunningChildren`（38 处认领）                                                                                             | T1, T5     |
| T8   | clarify 同帧：`prepareClarifyGateOpen` 加 `containerRunId`；round 复用键改；`nodeMechanics.ts:4792` 透传；双 provider；嵌套内 self / cross 用例                                                                                                                | T5, T6     |
| T9   | 语义用例：s06 翻转；三层嵌套；闭包 (a)(b)(c)；参数路由；resume / 重试；`lifecycle-wrapper-nested` 重写；既有 wrapper 用例零改动全绿                                                                                                                             | T6, T7, T8 |
| T10  | 最小前端 + PR-1 收口：`<WrapperBoundaryPortRow>` 抽取；loop / git 参数行；`NodeRun` DTO 加 `containerRunId` / `scopePath`（三层都带）；teaching 文案；`docs/workflow-yaml.md`（loop 嵌 loop / 入边 / 闭包边）；`design/design.md` §6.4-6.5 与 `CLAUDE.md` 对齐；**盯 CI 到绿** | T1～T9     |
| **PR-2** |                                                                                                                                                                                                                                                              |            |
| T11  | schema v6：`ReviewNodeSchema` 删 `inputSource`；`WrapperFanoutNodeSchema` 删 `inputs[]` 加 `shardSourcePort`；`LoopExitConditionSchema` 去 `nodeId`；`WORKFLOW_SCHEMA_VERSION = 6`；`workflow-node-references.ts` 清空四个 kind 的 PortRef 条目；teaching 键 union / strict 表 | PR-1       |
| T12  | 升级器 v5→v6（design D10 五步）+ 幂等 / 补边 / 冲突用例；32 个示例 + starter golden；`rfc199-starter-validator-golden` 更新；「升级前后执行逐字相同」双跑                                                                                                       | T11        |
| T13  | 端口表：loop 返回值由 `wrapper-output` 边推导（promoter 合并）；output / fanout 参数边推导；`DeclaredPort.channel` + 删 `systemChannelPorts.ts`，4+4 消费点改派生；`rfc147` 守卫改写                                                                             | T11        |
| T14  | 运行时：`runOutputNode` 读入边；review 12 处 `inputSource` 读点改读入边（双 provider）；`loopStrategy` 每轮先提升返回值再求 exit 谓词；fanout `shardSourcePort`；call-workflow 派生返回值改读子图 output 入边                                                    | T13        |
| T15  | validator（PR-2 部分）：`wrapper-loop-exit-port-missing`；fanout shard-source 规则改读 `shardSourcePort`；review / output 绑定规则改边规则；棘轮；gap4 改写                                                                                                    | T13        |
| T16  | 前端 + PR-2 收口：`connectionSync.ts` 双写删除；loop 右侧返回值行；inspector（loop exit 选择器、fanout `shardSourcePort`）；`docs/workflow-yaml.md`（`edges[]` / `review` / `output` / `wrapper-*` 小节）；e2e `canvas-connection-dialog` 断言；**盯 CI 到绿**     | T12～T15   |
| **PR-3** |                                                                                                                                                                                                                                                              |            |
| T17  | clarify 落行：`ClarifyNodeExecutor` / `CrossClarifyNodeExecutor` 无 open round 时铸 `skipped`；`settlesWithoutRow` 删除；frontier pass-2 删除；**核实点**：self 路径 park 行 → `done` 的转移点（cross 在 `legacySqliteClarify/service.ts:584`）；既有 clarify 用例 + 20 条 e2e 零改动全绿 | PR-2       |
| T18  | 任务详情：`tasks.detail.tsx` 面包屑；`node-history.ts` 按帧分组；`NodeDetailDrawer` / `InboxDrawer` 标签；纯函数测试                                                                                                                                              | PR-2       |
| T19  | e2e：`canvas-wrapper-membership` 加参数边 / 闭包边 / 返回值边三幕                                                                                                                                                                                             | T16, T18   |
| T20  | 收口：实现门（Codex，只审功能）+ STATE.md / plan.md 状态 Done + 架构账本重采                                                                                                                                                                                   | T17～T19   |

## 5. 进度（2026-09-03）

**PR-1 已推 `main`（T1～T10）**。落位与偏离项：

- T1：`domain/environmentChain.ts`（`resolveSourceFrame` / `resolveSourceFrameInScope` / `parentFrameOf` / `childScopePath`）、`domain/containerMembership.ts`、`application/frameChain.ts`；plan 里的 `resolveInEnvironment` 以这两个名字落地。
- T3：迁移 `0223_rfc354_node_run_frames.sql`（node_runs 两列 + 索引、clarify_rounds 一列 + `idx_clarify_rounds_asking` 重建）；RFC-349 schema-contract 与 PostgreSQL baseline / journal 同批重采。
- T4：`domain/frameBackfill.ts`（纯规划器，oracle 测试）+ `application/frameBackfillJob.ts` + 双 provider store + `composition/frameBackfill.ts`；SQLite / PostgreSQL 启动各接一次（`maintenance_state` 标记 `rfc354.frame-backfill.v1`），`aw doctor --backfill-containers` 强制重走（daemon 运行中拒绝）。**未做**「`scope_path` ↔ `container_run_id` 守卫」——`scope_path` 由 adapter 从容器行派生（`childScopePath`），铸行时不再继承（`rfc354-mint-record-frame` 锁定），守卫失去对象。
- T6：`readPortRowAtIteration` → `readPortRowAtFrame`（只读一帧）；wrapper 读点（`wrapperMechanics.readPort`）先按环境链解析来源帧，loop 的 exitCondition / outputBindings 与 gap4（体外来源）同走此路；`resolveUpstreamInputs` 逐来源解析。
- T7：`wrapperRevivalEvidence` / `runLiveness.innerRunsOf` / `retryNode` 级联（同帧继承）已切成员关系；**未做** `topLevelOnly` → `excludeBornRunningChildren` 改名（38 处纯改名，留 PR-3 收口一并做，避免与并发 session 撞文件）；`nodeRollback` 无迭代逻辑，无需改。
- T8：`ClarifyGateRoundProjection.containerRunId` + round 复用键 / designer readiness 按帧（origin run 的帧）；PostgreSQL 同源。
- T9：`scheduler-audit-s06` 翻转并更名 `rfc354-nested-loop-frames`；`rfc354-nested-frames-closure`（闭包一次绑定 / 本地按帧 / 顶层只跑一次）；`rfc354-environment-chain` 覆盖两跳（三层）解析；`lifecycle-wrapper-nested` 的形状不变量仍成立，未重写。**留 PR-3**：三层以上嵌套的真实调度用例、resume / 重试嵌套用例。
- T10：`NodeRun` DTO 三层带 `containerRunId` / `scopePath`；画布 loop / git 接受入边（参数），wrapper→成员边统一标 `wrapper-input`；检查器只读「参数（入边）」行。**偏离**：`<WrapperBoundaryPortRow>` 抽取推迟到 PR-2——fanout 的 inputs 行是可编辑声明、loop / git 的参数行是按边派生的只读行，形态不同；PR-2 loop 返回值改 `wrapper-output` 边后两者才同形。

## 3. 验收清单（对应 proposal §5）

- [ ] AC-1 s06 翻转 + 三层嵌套（T9）
- [ ] AC-2 禁令 / 拒入边全仓零命中（T2 + 守卫）
- [ ] AC-3 参数三来源 + 边界边路由 + `wrapper-input-port-missing`（T1, T2, T13）
- [ ] AC-4 loop 返回值 = 边界边 + exit 谓词（T14, T15）
- [ ] AC-5 闭包三条 + 既有 wrapper 用例零改动（T9）
- [ ] AC-6 PortRef 字段退役 + `connectionSync` 双写删除（T11, T16）
- [ ] AC-7 升级器 golden / 幂等 / 零 error / 执行逐字相同（T12）
- [ ] AC-8 系统通道折表（T13）
- [ ] AC-9 clarify 落行 + 既有用例零改动（T17）
- [ ] AC-10 嵌套内 clarify（T8）
- [ ] AC-11 resume / 重试（T9）
- [ ] AC-12 回填 oracle（T4）
- [ ] AC-13 双 provider（T3, T5, T14）
- [ ] AC-14 前端（T10, T16, T18）
- [ ] AC-15 fanout 校验（T2, T15）
- [ ] AC-16 文档（T10, T16）
- [ ] AC-17 三个 PR 各自 exact SHA CI 绿

## 4. 已知踩坑预案（摘自 `docs/dev-gotchas.md`，动手前再扫一遍）

- 加一条迁移 = 四件套；带迁移的未定稿代码先用 `AGENT_WORKFLOW_HOME=~/aw-rfc354` 跑。
- 新 validator code 触发 `rfc199-workflow-validation-targets` 计数与 `rfc203-validation-copy` 文案两条棘轮。
- 删 strict schema 字段（review / fanout）会让 RFC-348 teaching 表编译红——那是设计如此，按红改；passthrough kind（output / loop）
  改 `types.ts` 键 union + `fieldSources`。validator 读 passthrough 字段一律走 helper。
- 端口读点过滤必须 done ∪ skipped；「没输出」与「输出了空」靠 `node_run_outputs.active` 分。
- 「给容器边界加字段时三层都要」：DTO select → 值对象 → 前端投影。
- 删枚举 / 字段前先问「有没有可能已躺在用户 DB 里」：本 RFC 的字段删除全部在**读出时**升级，DB 里的 v5 定义原样保留。
- 架构账本 8 处联动；`architecture:write` 不在共享树上跑。
- 共享树提交：只 `git add` 自己的路径，`git commit -- <路径>`，推前 `git diff --cached --stat`。
