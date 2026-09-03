# RFC-352 — Memory bounded context 合同归位（RFC-294 W4-E2）

- 状态：**Done（2026-09-03）**——用户当日批准 D1～D6 与 AC-1～AC-12 并授权完整实现；T8 分页按用户选定的选项 B 纳入本 RFC
- current-source pin：`6752ec8c7`（`HEAD=origin/main`）
- 所属波次：RFC-294 `plan.md §8` 的 **W4-E2 memory**；前置 W4-A（RFC-344）/ W4-C（RFC-345）/ W4-E0（RFC-347）均已 Done
- 分母：账本重分桶（`48078eaa2`）之后，`W4-E2` 桶为 **67 条 exact edge**、**8 个 facade**
- 影响域：`memory`（主）、`source-control`（新增一个 offered 薄 participant）、`bootstrap`（装配）

## 1. 摘要

Memory 是 W4-E2 的 bounded context，今天已经走了大半：路由主链路调 `modules/memory/public/*`，模块里有 28 个文件、
SQLite/PostgreSQL 双 provider store 齐全，最难的**正确性**部分（content-only PATCH、candidate Move、双 scope 同事务、
OCC receipt、commit 后 WS）已由 RFC-342 / P0-A 交付。**本 RFC 不重开那些已批准的行为**，只做四件结构上的收口：

1. 把仍住在 `services/` 的四块实现（注入 / 蒸馏 / 调度 / 源上下文渲染）迁进 `modules/memory` 的对应层，
   删掉 8 个兼容 facade；
2. 把**授权谓词从 infrastructure 层提到 application 层**——今天 `canViewMemory` / `canManageMemory` 住在
   `modules/memory/infrastructure/sqliteMemoryCatalog.ts:1098,1117`，即 SQLite adapter 持有授权策略；
3. 按 RFC-294 `design.md:3441` 落 source-control offered `RepositoryScopeAuthorizationInTx` 薄 participant，
   让 memory 不再自己拼 repo / repo_group scope 的判据（`plan.md §8` 明写「W4 先为 E2 落」它）；
4. 列表查询的**分页下推**收进 typed query，路由只 decode/call/map。

**行为零变化**：本 RFC 是结构迁移，不改任何用户可见行为、wire、schema 或权限档位。特别地，repo / repo_group / global
scope 的 memory **今天就是「全员可读、仅资源管理员可管」**（`sqliteMemoryCatalog.ts:1105-1129`，RFC-248 AC-29 /
RFC-305），新的 SC participant 必须**逐字保持**这一档，不得借迁移之名改成「仓库属主可管」。

## 2. Current-source 结论

### 2.1 `modules/memory` 已成形，但四块实现还在 `services/` 里被反向借用

| 残留文件                                                             |   行数 | 现状                                                                                                                                                      |
| -------------------------------------------------------------------- | -----: | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/memoryDistiller.ts`                                        |   1274 | 蒸馏 agent 的完整实现（`runDistill:980`、`loadSourceEvents:322`、`loadScopeContexts:517`、`parseDistillerOutput:734`、`validateAndPersistCandidate:805`） |
| `services/memoryInject.ts`                                           |    570 | 注入实现（`loadInjectableMemories:123`、`injectMemoryForRun:402`、`loadInjectedSnapshotFromFirstAttempt:500`、`parseInjectedSnapshotJson:533`）           |
| `services/memoryDistillScheduler.ts`                                 |    480 | 入队与 1Hz worker（`distillTick:256`、`recoverRunning:431`、`retryFailedJob:448`、`cancelPendingJob:459`、`listDistillJobs:466`）                         |
| `services/distillerSourceContext.ts`                                 |    153 | 两个纯函数：`renderSessionTreeToDistillerMd:35`、`clipHeadTail:143`                                                                                       |
| `services/memory.ts`                                                 |      4 | RFC-349 留下的 `export * from '@/modules/memory/infrastructure/sqliteMemoryCatalog'`                                                                      |
| `services/memoryDistillJobDetail.ts` / `memoryDistillSessionView.ts` | 11 / 8 | 薄 re-export，被 `routes/memoryDistillJobs.ts:14-15` 直接 import                                                                                          |

方向是**反的**：`modules/memory/composition.ts:45` 从 `@/services/memoryInject` 取 `injectMemoryForRun` 与
`loadInjectedSnapshotFromFirstAttempt`——模块向 legacy 借自己的实现。

### 2.2 授权策略住在 SQLite adapter 里

`canViewMemory`（`sqliteMemoryCatalog.ts:1098`）与 `canManageMemory`（`:1117`）都是「先 `hasResourceAclBypass(actor)`
早返回、再按 scopeType 分档」的**纯策略**，却落在 infrastructure 层，并从那里 import `@/services/resourceAcl`。
`cli/start.ts:1917` 的 `memoryVisibility` 适配器又把它们重新包一层交给 realtime 策略。这是 RFC-294 `design.md §3`
「application 不得依赖 infrastructure」的直接反例，也是 E2 无论怎么切都必须先处理的那块。

### 2.3 `RepositoryScopeAuthorizationInTx` 只存在于设计文档

RFC-294 `design.md:3441` 定义了它（与 `ResourceScopeAuthorizationInTx` 对称，前者只管 repository/group、后者只管
agent/workflow），`plan.md §8` 把它列为 **E2 的前置件**。源码里没有任何实现——今天 memory 自己按 `scopeType` 分档，
repo / repo_group 与 global 走同一条 `hasResourceAclBypass` 判据。

### 2.4 蒸馏 worker 已经是可暂停后台写手，迁移不能弄丢

`cli/start.ts:785` 用 `createPollingDaemonRuntimeHandleFactory({ id: 'memory-distill', … })` 注册，落在 provider session
的可暂停集合里——这是 RFC-349 冻结窗口的不变量（`rfc349-sqlite-daemon-pausable-writers.test.ts`）。迁移必须保持这条
注册与它的 `beforeStart: recoverRunning`，不能退回裸 ticker。

### 2.5 剩余 67 条 exact edge 的形状

账本重分桶后 W4-E2 桶里是：`services/fusion.ts → memory/public/fusion` 9 条（knowledge-evolution 消费，属 E3 的
consumer 面）、`modules/memory/composition.ts → services/memoryDistillScheduler|memoryInject` 8 条（模块反向借实现）、
5 个 legacy service → 模块 ports 13 条、`server.ts` / `cli/start.ts` / `cli/postgresqlDaemonApplication.ts` /
`routes/memories.ts` 装配与路由 12 条、6 条 `off-dag-offered`（task-execution 与 collaboration 消费
`memory/public/participants`）、`memoryDistillSessionCapture → services/runtime/*` 3 条。

## 3. 目标

- **G1** 四块实现按 RFC-294 分层迁入 `modules/memory`：纯函数 → `domain/`，编排 → `application/`，
  SQL / 进程 / 文件系统 → `infrastructure/`；8 个 facade 在生产 consumer 归零后删除。
- **G2** 授权谓词提到 `application/`，infrastructure 只做数据访问；`hasResourceAclBypass` 经注入而非 deep import。
- **G3** 落 source-control offered `RepositoryScopeAuthorizationInTx` 薄 participant（**行为逐字等于今天**），
  memory 的 repo / repo_group scope 授权改经它取。
- **G4** 列表 / 分页下推收进 typed query；`routes/memories.ts` / `memoryDistillJobs.ts` 只 decode/call/map。
- **G5** W4-E2 桶里**归属于 memory 自己**的 exact ids 归零；不属于 memory 的（fusion 9 条 → E3、
  runtime 3 条 → E4b、6 条 off-dag-offered → 登记进设计 DAG 的 offered 集）按 owner 转交并逐条记账。

## 4. 非目标

- **不改任何权限档位**。repo / repo_group / global 的「全员可读、仅资源管理员可管」原样保留；
  RFC-285 Q4 的 candidate 只对资源管理员可读也原样保留。
- **不做安全加固**。RFC-294 `plan.md §8` 给 E2 写的「不可见 count 无侧信道」是安全项，按用户 2026-08-26 的硬规则
  （存在性 oracle 一类一律不立项）**不承接**；本 RFC 只做它的功能半边——分页下推与列表分页正确性。
- **不改 schema、不加 migration、不改 WS 消息**。**wire 与前端：只增不改**——用户 2026-09-03 选定在本 RFC 内
  新增记忆列表分页（选项 B），原先「零 wire / 零前端」的承诺按此修订：`GET /api/memories` 新增两个**可选**
  query 参数（`cursor` / `limit`），**任一出现才切换到 `{items, nextCursor}` 封套；不传的调用逐字节保持旧的
  `{items}` 形状**（与 `GET /api/cached-repos` 同一约定）。6 个既有前端消费者与 `memory.list-memories.v1`
  MCP 工具因此一行都不用改；只有 `MemoryAllList` 主动接入分页。
- **不重开 RFC-342 已批准的 Move / PATCH 行为**，也不改蒸馏的模型 / prompt / 输出协议。
- 不把 `services/runtime/opencode/distillSessionCapture.ts` 带走（归 W4-E4b）。
- 不动 `services/fusion.ts` 自身（归 W4-E3），本 RFC 只保证它消费的 memory public 面稳定。

## 5. 待批裁决

### D1 — 一刀切完，不拆蒸馏与注入

catalog/query + inject + distill 一并收口。四块共用同一套 scope 授权谓词，拆开会让谓词搬两次。
（用户 2026-09-03 已选「一刀」。）

### D2 — SC 薄 participant 本轮就落，且行为逐字不变

按 `plan.md §8` 落 `RepositoryScopeAuthorizationInTx`。它的 `assertManageable` **必须编码今天的判据**
（repo / repo_group：仅 `hasResourceAclBypass`），不得改成仓库属主委派——那属于权限档位变更，须独立立项。
（用户 2026-09-03 已选「落」。）

### D3 — 蒸馏 agent 的进程 / 文件系统副作用留在 infrastructure

`defaultDistillerSpawn`、一次性 worktree 的 `mkdir` / `rm`、stderr 裁剪属 infrastructure；
`parseDistillerOutput` / `clipHeadTail` / `renderSessionTreeToDistillerMd` / `estimateTokens` / `clipByBudget`
是纯函数，进 `domain/`。`runDistill` 的编排进 `application/`，通过 port 取 spawn 与持久化。

### D4 — 注入选择器只作为 task-owned required port 的实现

按 RFC-294 `design.md`：memory 注入选择器是 memory-internal application handler，仅作为
`TaskMemoryInjectionPort` 的实现暴露，不从 memory public query 暴露正文；保持「每个 runNode 实时重取
current-approved」的既有语义（`memoryInject.ts:16-20` 的设计不变量）。

### D5 — 保持 `memory-distill` 的可暂停 handle 注册

迁移后仍由 `createPollingDaemonRuntimeHandleFactory({ id: 'memory-distill' })` 注册，
`beforeStart: recoverRunning` 不变；`rfc349-sqlite-daemon-pausable-writers` 守卫继续覆盖。

### D6 — 不属于 memory 的 exact ids 转交而非退役

`services/fusion.ts` 的 9 条转 W4-E3、`distillSessionCapture` 的 3 条转 W4-E4b、6 条 `off-dag-offered`
登记进 `TARGET_CONTEXT_EDGES` 的 offered 集（TE / collaboration → memory 是真实的设计意图边）。
判据沿用用户 2026-09-02 给 RFC-345 T9 定的规则：修法完全落在 `modules/memory/**` 内部的才由本 RFC 退役。

## 6. 能力影响清单

本 RFC **不关闭、不收缩任何既有能力**。唯一的行为变更是最后一行那处**放宽**，它修的是两个 provider 判据漂移造成的 UI 欠权。逐项确认：

| 能力                                                    | 迁移后                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| memory 列表 / 详情 / 创建 / 编辑 / 删除 / 审批          | 不变（同一 typed command/query，路由 wire 不变）                                                                                                                                                                                                                            |
| repo / repo_group / global scope 的读写档位             | 不变（全员可读 / 仅资源管理员可管，逐字保留）                                                                                                                                                                                                                               |
| candidate 的 RFC-285 Q4 可见性                          | 不变                                                                                                                                                                                                                                                                        |
| scope Move（RFC-342）                                   | 不变，只是 repo/group 分支改经 SC participant 取同一判据                                                                                                                                                                                                                    |
| 运行时注入（per-run current-approved、live read）       | 不变                                                                                                                                                                                                                                                                        |
| 蒸馏入队 / 去抖 / 重试 / 取消 / job 详情 / session 视图 | 不变                                                                                                                                                                                                                                                                        |
| 蒸馏 worker 的可暂停语义（RFC-349 冻结）                | 不变                                                                                                                                                                                                                                                                        |
| 列表逐行 `canManage`（UI 按钮可见性）                   | **SQLite 部署上放宽到与 API 门一致**：`write` 授权者开始看到审批 / 编辑 / 归档按钮。这不是新授权——API 门（`canManageMemory`）本来就放行、PostgreSQL 部署本来就显示；是两个 provider 判据漂移造成的 UI 欠权。合并判据时必须选一个值，用户 2026-09-03 裁定取 `write \| own`。 |
| 记忆列表分页                                            | **新增可选能力**：`GET /api/memories` 支持 `cursor` / `limit`，`MemoryAllList` 出现「加载更多」。不传分页参数的调用与迁移前逐字节相同，既有 6 个前端消费者与 `memory.list-memories.v1` MCP 工具不受影响；审批队列刻意不分页（待办队列全量看得见更合适）。                   |

## 7. 验收标准

- **AC-1** `services/` 下 8 个 memory facade 全部删除，生产 consumer = 0。
- **AC-2** `modules/memory/**` 不再 import 任何 `@/services/memory*` / `@/services/distillerSourceContext`。
- **AC-3** 授权谓词在 `application/`；`modules/memory/infrastructure/**` 不再导出 `canViewMemory` / `canManageMemory`，
  也不再 deep import `@/services/resourceAcl`。
- **AC-4** `modules/source-control/public/participants.ts` 导出 `RepositoryScopeAuthorizationInTx`，
  memory 经它验证 repo / repo_group scope；错把 agent/workflow ref 传给它、或把 repo ref 传给 RC participant 的变异必红。
- **AC-5** 权限矩阵 characterization 测试：六种 scope × 三种角色（普通用户 / 资源管理员 / ACL bypass）× 读/管
  的判定结果与迁移前**逐格相同**（迁移前先落这张表作为 oracle）。
- **AC-6** `routes/memories.ts` / `routes/memoryDistillJobs.ts` 只 decode/call/map：路由文件内无 DB / ACL / OCC / 审计。
- **AC-7** 列表分页：逐页拼接的结果与全量查询**逐条相同**（顺序一致、不重不漏）；分页项的字段集与全量项逐字
  相同（游标用的 `createdAt` 不上 wire）；标签 / scope 可见性 / 候选收窄三层在分页路径上与全量一致；坏游标
  显式报 400 而非静默从头；批数封顶时返回不满的一页 + 有效游标，判到底只看 `nextCursor === null`。
- **AC-8** 蒸馏链路的既有行为 oracle 全绿：去抖合并、指数退避、`DISTILL_MAX_ATTEMPTS`、候选级容错
  （单条 zod 失败不炸整批）、`recoverRunning`、重试 / 取消。
- **AC-9** `memory-distill` 仍注册为可暂停 handle，RFC-349 冻结守卫绿。
- **AC-10** W4-E2 桶中 memory 自有的 exact ids 归零；转交的 18 条（fusion 9 / runtime 3 / off-dag 6）各带 owner 与
  removeWave 记账，全局债不增。
- **AC-11** 零 schema / migration / WS 改动；wire 与前端**只增不改**：不带分页参数的 `GET /api/memories`
  响应与迁移前逐字节相同，既有消费者零改动。`architecture:write` 重采后各 wave 分母不回升。
- **AC-12** exact-SHA hosted CI 终态成功（并发 push 取消时按含本提交的后继 SHA 判）。
