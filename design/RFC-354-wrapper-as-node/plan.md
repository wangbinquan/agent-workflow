# RFC-354 — 任务分解

## 1. PR 拆分（三个，均直接推 `main`，不建分支）

| PR   | 内容                                                    | 落地后的自洽态                                                                       |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| PR-1 | **帧 + 闭包 + wrapper 参数**（零 schema 变更）：T1～T10 | 嵌套跑通、闭包 / 参数语义就位、画布渲染 loop / git 参数行；定义仍是 v5               |
| PR-2 | **边模型 v6**：T11～T16                                 | PortRef 字段退役、loop 返回值 = 边界边、系统通道折表、升级器 + 32 golden、画布只写边 |
| PR-3 | **clarify 落行 + 展示 UX + 收口**：T17～T20             | `settlesWithoutRow` 退役、任务详情面包屑 / 分组、e2e、实现门、Done                   |

每个 PR 推完按 exact SHA 盯 CI 到绿（`CLAUDE.md` §Test-with-every-change）。PR-2 依赖 PR-1（loop 返回值按帧提升、
exit 谓词按帧求值）；PR-3 依赖 PR-2（clarify 通道端口已在端口表）。

## 2. 任务

| 编号     | 任务                                                                                                                                                                                                                                                                                                                                                                                                       | 依赖       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| T0       | 设计门（Codex，只审功能；用户决定是否跑）；findings 分「纯实现」与「设计方向」两堆，后者逐条呈用户                                                                                                                                                                                                                                                                                                         | —          |
| **PR-1** |                                                                                                                                                                                                                                                                                                                                                                                                            |            |
| T1       | shared：`nodePorts.ts` loop / git 边推导 `dataInputs`；`task-execution/domain/` 新增 `resolveInEnvironment` + `containerMemberRuns` 纯函数 + 表测                                                                                                                                                                                                                                                          | —          |
| T2       | validator（PR-1 部分）：删 `wrapper-loop-nested` 与 loop / git 拒入边分支；新增 `wrapper-input-port-missing`（全 wrapper）/ `wrapper-fanout-unsupported-inner-kind`；前端 target 表 + zh/en 文案；两条棘轮；`rfc094` rule-1 翻转                                                                                                                                                                           | T1         |
| T3       | 迁移 0223 + contract：node_runs 两列 + 索引；clarify_rounds 一列 + 索引重建；`schemaContract.ts` + codec；`upgrade-rolling` 计数；journal prettier；RFC-349 写矩阵新列                                                                                                                                                                                                                                     | —          |
| T4       | 回填 job + `aw doctor --backfill-containers`；oracle 测试（未命中 = 0）；`scope_path` ↔ `container_run_id` 守卫                                                                                                                                                                                                                                                                                            | T3         |
| T5       | 帧身份接线：`MintNodeRunArgs` / `TaskScopeArgs` / `WrapperScopeDriverPort.drive` / `NodeExecutionQuery` / `wrapperRuns.findResumable` 加 `containerRunId`；`openGeneration` 按帧续接；fanout shard 行带帧；双 provider adapter                                                                                                                                                                             | T3         |
| T6       | 调度按帧读：frontier / freshness 帧过滤；`readPortRowAtIteration` / `resolveUpstreamInputs` 改调 `resolveInEnvironment`；`pickUpstreamSourceRun` 删窗口形参；gap4 runtime 分支改环境链；`closure-binding-unresolved`；源码守卫                                                                                                                                                                             | T1, T5     |
| T7       | `containerMemberRuns` 接入：`wrapperRevivalEvidence` / `innerRunsOf` / `retryNode` 级联 / `nodeRollback`；`topLevelOnly` → `excludeBornRunningChildren`（38 处认领）                                                                                                                                                                                                                                       | T1, T5     |
| T8       | clarify 同帧：`prepareClarifyGateOpen` 加 `containerRunId`；round 复用键改；`nodeMechanics.ts:4792` 透传；双 provider；嵌套内 self / cross 用例                                                                                                                                                                                                                                                            | T5, T6     |
| T9       | 语义用例：s06 翻转；三层嵌套；闭包 (a)(b)(c)；参数路由；resume / 重试；`lifecycle-wrapper-nested` 重写；既有 wrapper 用例零改动全绿                                                                                                                                                                                                                                                                        | T6, T7, T8 |
| T10      | 最小前端 + PR-1 收口：`<WrapperBoundaryPortRow>` 抽取；loop / git 参数行；`NodeRun` DTO 加 `containerRunId` / `scopePath`（三层都带）；teaching 文案；`docs/workflow-yaml.md`（loop 嵌 loop / 入边 / 闭包边）；`design/design.md` §6.4-6.5 与 `CLAUDE.md` 对齐；**盯 CI 到绿**                                                                                                                             | T1～T9     |
| **PR-2** |                                                                                                                                                                                                                                                                                                                                                                                                            |            |
| T11      | schema v6：`ReviewNodeSchema` 删 `inputSource`；`WrapperFanoutNodeSchema` 删 `inputs[]` 加 `shardSourcePort`；`LoopExitConditionSchema` 去 `nodeId`；`WORKFLOW_SCHEMA_VERSION = 6`；`workflow-node-references.ts` 清空四个 kind 的 PortRef 条目；teaching 键 union / strict 表                                                                                                                             | PR-1       |
| T12      | 升级器 v5→v6（design D10 五步）+ 幂等 / 补边 / 冲突用例；32 个示例 + starter golden；`rfc199-starter-validator-golden` 更新；「升级前后执行逐字相同」双跑                                                                                                                                                                                                                                                  | T11        |
| T13      | 端口表：loop 返回值由 `wrapper-output` 边推导（promoter 合并）；output / fanout 参数边推导；`DeclaredPort.channel` + 删 `systemChannelPorts.ts`，4+4 消费点改派生；`rfc147` 守卫改写                                                                                                                                                                                                                       | T11        |
| T14      | 运行时：`runOutputNode` 读入边；review 12 处 `inputSource` 读点改读入边（双 provider）；`loopStrategy` 每轮先提升返回值再求 exit 谓词；fanout `shardSourcePort`；call-workflow 派生返回值改读子图 output 入边                                                                                                                                                                                              | T13        |
| T15      | validator（PR-2 部分）：`wrapper-loop-exit-port-missing`；fanout shard-source 规则改读 `shardSourcePort`；review / output 绑定规则改边规则；棘轮；gap4 改写                                                                                                                                                                                                                                                | T13        |
| T16      | 前端 + PR-2 收口：`connectionSync.ts` 双写删除；loop 右侧返回值行；inspector（loop exit 选择器、fanout `shardSourcePort`）；`docs/workflow-yaml.md`（`edges[]` / `review` / `output` / `wrapper-*` 小节）；e2e `canvas-connection-dialog` 断言；**盯 CI 到绿**                                                                                                                                             | T12～T15   |
| **PR-3** |                                                                                                                                                                                                                                                                                                                                                                                                            |            |
| T17      | clarify 落行：`ClarifyNodeExecutor` / `CrossClarifyNodeExecutor` 无 open round 时铸 `skipped`；`settlesWithoutRow` 删除；frontier pass-2 删除；**核实点**：self 路径 park 行 → `done` 的转移点（cross 在 `legacySqliteClarify/service.ts:584`）；既有 clarify 用例 + 20 条 e2e 零改动全绿。**落地补记**：`__clarify__ → clarify` 改为真依赖（`dataflow: 'always'`），见 design.md §10「PR-3 实现偏离」     | PR-2       |
| T18      | 任务详情：`tasks.detail.tsx` 面包屑；`node-history.ts` 按帧分组；`NodeDetailDrawer` / `InboxDrawer` 标签；纯函数测试。**落地补记**：轮次列 / 抽屉 `statFrame` / 运行历史按帧分组均按 `scopePath`（`outer#1 › inner#0`）渲染，平铺工作流零变化；`clarifyRoundForRun` / `displayRetryForRun` 谱系改按帧过滤；InboxDrawer 未动——clarify session DTO 不带帧（只有 `iteration`），补 DTO 属后端改动，记入 §5 债 | PR-2       |
| T19      | e2e：`canvas-wrapper-membership` 加参数边 / 闭包边 / 返回值边三幕。**落地补记**：三幕都走 Connection Dialog（零拖拽、零歧义）：外部 → loop 本身 = 普通入边即参数（检查器 `wrapper-parameter-list` 列出）；外部 → 成员 = 穿墙闭包边（不进参数列表）；成员 → 自己的 loop = `boundary: 'wrapper-output'`（`loop-return-list` + 退出条件候选）                                                                 | T16, T18   |
| T20      | 收口：实现门（Codex，只审功能）+ STATE.md / plan.md 状态 Done + 架构账本重采。**落地补记**：Codex 配额耗尽，实现门改由独立 Claude 子代理执行（见 §5）                                                                                                                                                                                                                                                      | T17～T19   |

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

**PR-1 收红**（`b7bad7ee5`）：守卫清单删 `canvas-wrapper-inbound-guard` 种子；RFC-230 活性夹具补帧；能力目录 `wrapper-loop::wrapper-loop` 改 supported、fanout 体内 wrapper 三条改 static-rejected；S-4b 改读直接成员；`cli/frameBackfill.ts` 去 composition import（RFC-317 R1）。

**PR-2（T11～T16，schema v6）**落位与偏离项：

- T11：`WORKFLOW_SCHEMA_VERSION = 6`；`ReviewNodeSchema` 删 `inputSource`、`WrapperFanoutNodeSchema` 删 `inputs[]` 加 `shardSourcePort`、`LoopExitConditionSchema` 只剩 `portName`；`workflow-node-references.ts` 四个 kind 的 PortRef 条目清空；teaching 表随 strict schema 改（RFC-348 反查基线换成 `shardSourcePort`）。
- T12：`migrateWorkflowDefinitionV5ToV6`（review 入边补边 / output 端口成边 / loop 绑定成 `wrapper-output` 边 + exit 改指自己的返回口，无绑定的 exit 来源按原名提升、撞名加 `_2` / fanout `inputs[]` 折成 `shardSourcePort`；边 id `${src}_${port}_to_${tgt}_${port}` 撞号加 `_n`；空 `{nodeId:'',portName:''}` 视为未接线、不生成边）；`rfc354-schema-v6-upgrade`（shared）+ `rfc354-examples-v6-golden`（32 个示例：升级幂等、无 v5 字段残留、strict schema 通过、零边模型 code）。**偏离**：磁盘上的 32 个示例 YAML 保持 v5 形状不重写（升级器是导入契约，重写会丢注释 / 格式）；「升级前后执行逐字相同」双跑用例未单独立——既有全部 wrapper / review / output 运行时用例均以 v5 夹具经升级器跑绿即为该断言。
- T13：端口表——loop `dataOutputs` 由 `wrapper-output` 边派生（`wrapperOutputPortNames`），output / fanout 不再声明输入，call-workflow 子图输出改读子图 output 入边；D6 系统通道折表：`DeclaredPort.channel`，`systemChannelPorts()` / `isSystemChannelEdge` / `touchesSystemChannelPort` / `promptInjectedPortNames()` / `channelEdgeDataflowSkip` 全部从端口表派生，`systemChannelPorts.ts` 删除，`rfc147` 守卫改为「端口表是唯一来源」。**偏离**：`PROMPT_INJECTED_PORT_NAMES` 常量改为函数 `promptInjectedPortNames()`（表在模块初始化后才能投影）。
- T14：`runOutputNode` 读入边；review 读点统一走 shared `reviewInputSource(definition, nodeId)`（SQLite / PostgreSQL 同源）；`loopStrategy` 每轮先 `promoteReturns` 再对自己的返回口求 exit 谓词（`wrapper-loop-exit-port-missing`），返回边 source 不是直接成员时 prepare 阶段以 `wrapper-loop-return-source-out-of-scope` 拒绝（旧非法快照 fail-closed，gap4 改写）；fanout 分片 kind 取参数边 source 口 kind（`WrapperDataPort.sourcePortKind`）；`dispatchFrontier` / `taskDagGraph` / `inboundEdges` 的隐式来源块全部删除。
- T15：validator E1～E10 改边规则：output / fanout 目标口不再校验（口即边）、review 只认 `__review_input__` 入边（`review-input-edge-mismatch` 退役）、loop 返回边 `wrapper-loop-output-binding-out-of-scope`（锚在边）+ `wrapper-loop-exit-port-missing`、fanout `wrapper-fanout-shard-source-missing` / `-must-be-list` 改读 `shardSourcePort` + 参数边 source kind（source 无 kind 声明——input 节点、未解析子图——不判）、`binding-*` / `wrapper-loop-exit-node-*` / `wrapper-fanout-shard-source-duplicate` 退役；review 穿墙读改由通用边规则报一次 `wrapper-output-boundary-missing`；棘轮 145 → 132；入口 `validateWorkflowDef` 先升级再校验。
- T16（前端，828 个测试文件 / 6966 用例全绿，tsc 0）：`connectionSync.ts` 只剩 review 单入替换 + output catch-all `_2` 消歧（全部只改边）；`workflow-transition.ts` 删 `set-review-input-source` / `set-output-ports`，node patch 只写 `shardSourcePort`，output / wrapper 参数重命名 = 整批同名边改名；`workflow-connection-plan.ts` 的 `set-fanout-inputs` → `set-fanout-shard-source`，legacy 拖拽落 fanout 无 shard 源时首个参数即 shard；`workflow-connection-boundary.ts` 删 `ensureLegacyWrapperFanoutInputForEdge`，`markBoundaryWrapperOutput` 扩到 loop（成员 → 自身 loop = `wrapper-output`）；画布：loop 返回值改为与 fanout 同形的右侧边界行 + `__return__` catch-all 条（拖成员出口到条上即声明返回值）；检查器：ReviewEdit 只读来源摘要 + 断开、OutputEdit 入边即端口行、WrapperGitLoopEdit 返回值只读列表 + 退出目标 = 自身返回口 Select、WrapperFanoutEdit 参数行 = 入边 + `shardSourcePort` Select；`workflows.edit.tsx` 加载边界 `migrateWorkflowDefinitionToLatest`；starters 改 v6；validation-target / projection 退役码删除；i18n 双语同步。`<WrapperBoundaryPortRow>`（PR-1 推迟项）随 loop 返回行与 fanout 参数行同形一并落地。**偏离**：Connection Dialog 没有 loop 返回值的引导流程（只能画布拖拽），fanout 的「kind」输入框保留为提示（合法性按外部源声明的 kind 判）。`docs/workflow-yaml.md` 的 `wrapper-fanout` / `output` / `wrapper-loop` / `review` / `edges[]` / 校验小节改为 v6。

**PR-3（T17～T20）**落位与偏离项：

- T17（`458801486` + 账本 `fe92861bd`）：clarify / cross gate 落行——`settlesWithoutRow` 列改名 `clarifyGate`、frontier pass-2 与
  `SETTLES_WITHOUT_ROW_KINDS` 删除、gateway 对所有 kind 判分支活性、`runIdleClarifyNode` 无 open round 时按 RFC-306 同形铸 `skipped`；
  **偏离**：`agent.__clarify__ → <gate>` 改为真依赖（端口表 `dataflow: 'always'`，`channelEdgeDataflowSkip(e)` 去 `kindOfTarget`），
  frontier 保留 N6「session 已开的无行 gate 不派发」。详见 design.md §10「PR-3 实现偏离」。既有 clarify 用例零改动；
  derive-frontier C1/N6、dispatch-frontier B3、rfc147 家族 D、no-runaway 源码锁四处改到新语义。
- T18：`node-history.ts` 加帧原语（`sameFrame` / `frameKeyOf` / `parseScopePath` / `formatFrameBreadcrumb` / `groupHistoryByFrame`），
  `clarifyRoundForRun` / `displayRetryForRun` 谱系按帧过滤；任务详情轮次列、抽屉 `statFrame`、运行历史分帧标题均按 `scopePath`
  渲染，平铺工作流零变化。**债**：InboxDrawer 的反问条目仍只显示 `iteration`——clarify session DTO 不带帧，补齐要动后端 DTO + 双 provider。
- T19：`canvas-wrapper-membership` 三幕（参数边 / 闭包边 / 返回值边），每幕由 Connection Dialog 建边、从定义回读三元组
  `source→target[boundary]` 并对照检查器列表；本地 chromium 5/5 绿。
- T20 实现门（Codex 配额耗尽至 09-08，按 memory 记录的替代姿势改用独立 Claude 子代理、同强度对抗评审，只审功能）：
  1 条 P1 + 2 条 P3，全部修复——P1：wrapper 体内 self 反问的 park 行落在顶层帧，答复后 gate 被再派发多铸 `skipped`
  （见 design.md §10「PR-3 实现偏离」末条；rfc040 两条 resume 用例加锁 gate 行 `['done']` + 帧）；P3：前端帧判断改经
  `formatFrameBreadcrumb`（旧 daemon 无 `scopePath` 字段不渲染空帧）；P3：三幕独立 `describe`、拖拽两幕单独串行。
  门同时指出 T17「既有 clarify 用例零改动全绿」不足以验收 wrapper 内 D7（那些用例不断言 gate 行）——已由上述加锁补上。

## 3. 验收清单（对应 proposal §5）

- [x] AC-1 s06 翻转 + 三层嵌套（T9） — `rfc354-nested-loop-frames`（外 2 × 内 2 = 4 次调起）+ 三层嵌套用例
- [x] AC-2 禁令 / 拒入边全仓零命中（T2 + 守卫） — `wrapper-loop-nested` 退役、loop / git 入边即参数
- [x] AC-3 参数三来源 + 边界边路由 + `wrapper-input-port-missing`（T1, T2, T13） — PR-1 + T13 端口表
- [x] AC-4 loop 返回值 = 边界边 + exit 谓词（T14, T15） — `wrapper-output` 边 + `wrapper-loop-exit-port-missing`
- [x] AC-5 闭包三条 + 既有 wrapper 用例零改动（T9） — `rfc354-nested-frames-closure`
- [x] AC-6 PortRef 字段退役 + `connectionSync` 双写删除（T11, T16） — schema v6 + T16
- [x] AC-7 升级器 golden / 幂等 / 零 error / 执行逐字相同（T12） — `rfc354-examples-v6-golden`（32 个示例）
- [x] AC-8 系统通道折表（T13） — `DeclaredPort.channel`，`rfc147-system-channel-ports` 改「端口表是唯一来源」
- [x] AC-9 clarify 落行 + 既有用例零改动（T17） — `rfc354-clarify-idle-skip` + 既有 clarify 用例零改动；实现门补 rfc040 gate 行加锁
- [x] AC-10 嵌套内 clarify（T8） — clarify 同帧 + T20 park 行帧修复
- [x] AC-11 resume / 重试（T9） — 重试级联按帧成员关系
- [x] AC-12 回填 oracle（T4） — `cli/frameBackfill.ts` + `aw doctor --backfill-containers`
- [x] AC-13 双 provider（T3, T5, T14） — SQLite / PostgreSQL 同源（review 读点、gate open、复用查找）
- [x] AC-14 前端（T10, T16, T18） — 画布只写边 + 任务详情按帧
- [x] AC-15 fanout 校验（T2, T15） — `wrapper-fanout-shard-source-*`
- [x] AC-16 文档（T10, T16） — `docs/workflow-yaml.md` v6 + design §10 偏离
- [x] AC-17 三个 PR 各自 exact SHA CI 绿 — PR-1 `87aab47cb`、PR-2 `e1e538b1b`（e2e 收红后 `fb608f89c` run 33800356235 全绿）、PR-3 `fb608f89c`；实现门收口 + god-surface 收红后的 tip `bf492f063` run 33806729877 全绿

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
