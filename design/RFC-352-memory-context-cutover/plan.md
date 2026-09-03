# RFC-352 实施计划 — Memory bounded context 合同归位

- 状态：**Approved / In Progress**（用户 2026-09-03 批准 D1～D6 与 AC-1～AC-12 并授权完整实现）
- 进度：**T1～T10 全部完成（2026-09-03）**。T5 并入 T2（注入迁位时一并完成）；T8 按用户选定的选项 B 在本 RFC 内做；T9 的退役 / 转交逐条见 §4.1
- current-source pin：`6752ec8c7`
- 开工分母（账本重分桶 `48078eaa2` 之后）：W4-E2 exact edge **67**、facade **8**

## 1. 任务分解

| 任务    | 内容                                                                                                                                                                                               | 依赖  | 冲突面                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| **T1**  | 落权限矩阵 characterization oracle（六 scope × 三角色 × 读/管），**先红后绿的反向用法**：迁移前它必须全绿，之后每一步都不许它变                                                                    | —     | 仅新增测试文件                                                               |
| **T2**  | `domain/` 建四个纯函数模块（注入渲染 / 蒸馏输出解析 / 源上下文 / prompt），从 `memoryInject.ts` / `memoryDistiller.ts` / `distillerSourceContext.ts` 平移，零行为改动                              | T1    | 三个 legacy 文件                                                             |
| **T3**  | `domain/scopeAuthorization.ts` + `application/memoryAuthorization.ts`：授权谓词从 `infrastructure/sqliteMemoryCatalog.ts:1098,1117` 上移，`hasResourceAclBypass` 改经 `ResourceAclBypassPort` 注入 | T1,T2 | `modules/memory/infrastructure/*`、`cli/start.ts:1917`                       |
| **T4**  | source-control 落 offered `RepositoryScopeAuthorizationInTx`（行为逐字等于今天），memory 的 repo/repo_group 分支改经它                                                                             | T3    | `modules/source-control/public/participants.ts`（新增）                      |
| **T5**  | 注入迁入 `application/injection/`，实现 `TaskMemoryInjectionPort`；`parseInjectedSnapshotJson` 经 `memory/public/types` 供 TE                                                                      | T2    | `modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts:111` |
| **T6**  | 蒸馏迁入 `application/distill/` + `infrastructure/distillerProcess.ts`（`DistillerProcessPort`）                                                                                                   | T2    | `services/memoryDistiller.ts`                                                |
| **T7**  | 调度迁入 `application/distill/schedule.ts`；保持 `memory-distill` 可暂停 handle 与 `beforeStart: recoverRunning`                                                                                   | T6    | `cli/start.ts:785`、`cli/postgresqlDaemonApplication.ts`                     |
| **T8**  | 列表分页下推进 typed query；`routes/memories.ts` / `memoryDistillJobs.ts` 收成 decode/call/map                                                                                                     | T3    | 两个路由文件                                                                 |
| **T9**  | 删 8 个 facade（生产 consumer 归零后）；转交 18 条不属于 memory 的 exact ids（fusion 9→E3、runtime 3→E4b、off-dag 6 登记进 DAG offered 集）                                                        | T2–T8 | `services/memory*.ts`、`rfc294Canonical.ts` 的 `TARGET_CONTEXT_EDGES`        |
| **T10** | `architecture:write` 重采 + 收口（`STATE.md` / `design/plan.md` / RFC 状态改 Done + exact-SHA CI 取证）                                                                                            | T9    | `architecture/*`（与并发 session 排队）                                      |

## 2. PR 拆分建议

单 RFC 单 PR（本仓直推 main）。提交按 T 分批，每批自带测试：
`T1` → `T2` → `T3+T4`（授权一刀，避免中间态两套判据）→ `T5` → `T6+T7` → `T8` → `T9` → `T10`。

## 3. 回滚点

- T2 是纯平移，可整批 revert；
- T3+T4 只切授权取数路径，不改判据——回滚先恢复 infrastructure 出口再切 binding；
- T6+T7 回滚需同时恢复 handle 注册，否则蒸馏 worker 会脱离可暂停集合（RFC-349 不变量）；
- T9 只在 consumer=0 后删 facade，回滚先恢复 facade 再切 import。

## 4. 验收清单

对齐 `proposal.md §7`：AC-1 facade 归零 / AC-2 模块不反向借 / AC-3 授权不在 infrastructure /
AC-4 SC participant 落地且错绑必红 / AC-5 权限矩阵逐格不变 / AC-6 路由只 decode-call-map /
AC-7 分页两 provider 对拍 / AC-8 蒸馏行为 oracle / AC-9 冻结守卫 / AC-10 转交记账 /
AC-11 零 schema-wire-前端 / AC-12 exact-SHA hosted CI 终态成功。

## 4.1 T9 执行结果（2026-09-03）——退役 / 转交逐条

判据沿用用户 2026-09-02 给 RFC-345 T9 定的规则：**修法完全落在 `modules/memory/**` 内部的才由本 RFC 退役；
需要往别的 context 的文件里塞注入、或需要新开公共合同的，转交该 consumer 所属的波。\*\*

W4-E2 桶：开工时 96 条 → T8 后 54 条 → T9 后 **35 条**。facade：8 → **2**。

### 本刀退役的（memory 自己的）

| 项                                                                                                                                                                          |        条数 | 做法                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `services/memoryInject.ts` / `distillerSourceContext.ts` / `memoryDistiller.ts` / `memoryDistillScheduler.ts` / `memoryDistillJobDetail.ts` / `memoryDistillSessionView.ts` | 6 个 facade | 按分层迁进模块（T2 / T6 / T7），后两个的函数体只是转发给 `MemoryDistillQueries`，路由改为直接调 port                                                                                             |
| memory → source-control 的**内部** import                                                                                                                                   |           4 | T8 落地时直接 import 了 SC 的 `application/` 与 `infrastructure/`；T9 由 SC 在 `public/` 补出唯一 owner 工厂与两个 reads，改为正常的 offered 消费（`memory → source-control` 本就在设计 DAG 上） |
| memory → resource-catalog `domain/resourceAccess`                                                                                                                           |           1 | 同一谓词此前两个 provider 从不同地方取（SQLite 走 legacy `@/services/resourceAcl`、PostgreSQL 深入 RC domain）。由 owner 在 `resource-catalog/public/types.ts` 给出唯一出口，两侧统一            |

### 转交的（修法在别人的文件里）

| 项                                                                              |                     条数 | 转交给             | 理由                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | -----------------------: | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/fusion.ts` → `memory/public/fusion`                                   |                        9 | **W4-E3**          | fusion 属 knowledge-evolution；剩下的活是把**消费者**搬进它自己的 context                                                                                                                                                    |
| `routes/fusions.ts` → memory public | 2 | **W4-E3** | fusion 路由属 knowledge-evolution。原表把 `routes/memories.ts` 与它并列「各自 consumer 的波」，T10 查明前者根本不该在别人的桶里——见 §4.3 |
| memory → `ws/broadcaster`                                                       |                        8 | **W9**             | 目标形态是 commit 后由平台事件面投递，不由 application 直连 broadcaster                                                                                                                                                      |
| `memoryDistillSessionCapture` → `services/runtime/*`                            |                        3 | **W4-E4b**         | runtime 驱动合同归 runtime-management                                                                                                                                                                                        |
| TE / collaboration → memory public（off-dag）                                   |                        9 | **W4-E1 / W4**     | 合法消费但不在设计 §3.1 DAG 上；已在 `OFF_DAG_OFFERED_EDGE_DEBT` 逐条登记，反向补 DAG 会造成双向 context 边                                                                                                                  |
| `resource-catalog/infrastructure/legacy/skillVersion.ts` → `services/memory.ts` | 1（带走最后一个 facade） | **W4-C**           | 该 facade 的两个生产 consumer 一个在 `platform/persistence/sqlite/systemOverviewReadModel.ts`、一个在 RC legacy；修法是给平台读模型注入 memory 的 query port、给 RC 提供 tx-bound unfuse participant——都不在 memory 的文件里 |
| `services/runtime/opencode/distillSessionCapture.ts`（facade）                  |                        1 | **W4-E4b**         | 落在 runtime 目录下，随 runtime-management 迁                                                                                                                                                                                |

### 明确不在本刀处理、也不单方面重新归属的

`server.ts` / `cli/start.ts` / `cli/postgresqlDaemonApplication.ts` → `memory/composition*` 共 **11 条**。
它们是 bootstrap 装配模块的边，而这在 RFC-294 里正是 **W9-A DaemonContainer** 要重构的形态。
但实测这是**全仓普遍形态**：同样的 bootstrap→composition 边共 **381 条、横跨 10 个波**
（W4-C 71 / W4-E8 68 / W4-B 59 / W4-E1 42 / W4-E9 39 / W5 34 / W4 26 / W4-E4a 17 / W4-E7 14 / W4-E2 11）。
把它们整体改记 W9 是一次跨波重新归属，属独立决策，**不由 memory 这一刀单方面做**。

### 顺带修正的记账规则（R4 放宽）

`rfc294Canonical.ts` 的 R4（「legacy 消费模块已发布面 ⇒ 记消费者的波」）此前只认 EXACT public 入口，
而 `public/` 下还有一批**已登记**的非 exact 入口（`NON_EXACT_PUBLIC`，如 memory 的 `catalog.ts` / `fusion.ts`）。
就这条规则而言两者没有分别——消费者拿到的都是模块对外承诺的东西。用 EXACT 判会把
`services/fusion.ts` 这类消费者错记到被调模块头上（实测 9 条 fusion→memory 的边挂在 W4-E2，
而修法全在 knowledge-evolution 的文件里）。已改为「路径在 `public/` 下即算已发布面」。

## 4.2 T10 收口取证（2026-09-03）——逐 AC

| AC        | 判定                        | 证据                                                                                                                                                                                                                            |
| --------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AC-1**  | **按转交口径达成**（8 → 2） | 6 个 memory 自有 facade 已删；余 2 个的修法在别人的文件里（`services/memory.ts` 的两个生产 consumer 在 `platform/persistence/sqlite/systemOverviewReadModel.ts` 与 RC legacy；`distillSessionCapture.ts` 在 runtime 目录），逐条见 §4.1 |
| **AC-2**  | 达成                        | `grep -rn "@/services/memory\|@/services/distillerSourceContext" src/modules/memory/` 零命中                                                                                                                                     |
| **AC-3**  | 达成                        | 判据在 `domain/scopeAuthorization.ts`；`src/modules/memory/infrastructure/` 不再导出 `canViewMemory`/`canManageMemory`，也不再 import `@/services/resourceAcl`                                                                    |
| **AC-4**  | 达成                        | `modules/source-control/public/participants.ts` 导出 `RepositoryScopeAuthorizationInTx` + 唯一 owner 工厂；能力铸造合同由 `rfc294-architecture-preflight` 的 capability-forge 守卫锁定（brand / freeze / WeakSet / 单工厂）        |
| **AC-5**  | 达成                        | `rfc285-b7-memory-matrix.test.ts`（六 scope × 三角色 × 读/管）全绿。**唯一有意的一格变化**：SQLite 侧 `canManage` 由 `own` 放宽到 `write\|own`，与 PostgreSQL 侧对齐——那是双 provider 漂移出的真 bug，用户当日裁决取 `write\|own`  |
| **AC-6**  | 达成（T10 补完）            | 收口自查发现路由里还留着 RFC-285 Q4 收窄的**四份手抄件** + `@/services/resourceAcl` 的 ACL 谓词；已收成 `domain/candidateVisibility.ts` 一份判据经 `memory/public/types` 消费，ACL 谓词改经 `resource-catalog/public/types`。锁：`rfc352-memory-candidate-visibility.test.ts`（含源码层「路由里不得再出现手写 `status !== 'candidate'`」） |
| **AC-7**  | 达成                        | `rfc352-memory-list-pagination.test.ts`（8 例纯原语：游标往返 / 同毫秒决胜 / 稀疏跨批 / 触顶不满页 + 有效游标 / 触顶后能翻到底 / 空源 / 末页 null）+ `rfc352-memory-list-page-query.test.ts`（6 例 provider 集成：逐页拼接 === 全量、字段集逐字相同、标签 / 候选 / scope 三层一致、坏游标 400） |
| **AC-8**  | 达成                        | `memory-distiller*.test.ts` / `memory-distill-scheduler*.test.ts` / `memory-distill-job-detail*.test.ts` 全绿（去抖合并 / 退避 / MAX_ATTEMPTS / 候选级容错 / recoverRunning / 重试取消）                                          |
| **AC-9**  | 达成                        | `memory-distill` 仍在 `cli/start.ts` / `cli/postgresqlDaemonApplication.ts` 注册为可暂停 handle；`rfc349-postgresql-preflight` 冻结守卫绿                                                                                        |
| **AC-10** | **按转交口径达成**          | 见 §4.1 / §4.3：W4-E2 现 43 条 = bootstrap→composition 全仓形态 11 + `ws/broadcaster` 8 + runtime 3 + off-dag offered 9 + 两个路由文件 10 + RC legacy consumer 1 + facade 自身 1；memory **自有且修法在自己文件里**的已归零     |
| **AC-11** | 达成                        | 零 schema / migration / WS 改动；`GET /api/memories` 不带分页参数时逐字节保持 `{items}`（`routes-memories.test.ts` 既有断言未改）；前端只增 load-more。各波分母见 §4.3，无回升                                                  |
| **AC-12** | 见 §4.4                     | exact-SHA hosted CI 取证                                                                                                                                                                                                        |

## 4.3 T10 查出的桶归属错误（`routes/memories.ts`）

收口重采时发现 `routes/memories.ts` 的 `targetContext` 是 **`task-execution`**（W4-E1），而它的兄弟
`routes/memoryDistillJobs.ts` 是 `memory`（W4-E2）。原因是 `rfc294Canonical.ts` 的关键词级联第 449 行写的是
**单数** `/memory|distill/`：`memoryDistillJobs` 含 `distill` 命中，`memories`（复数）不含 `memory`，
一路落到兜底的 `task-execution`。全仓 121 个 route 文件里有 24 个落在这个兜底里。

这不是学术问题：R4 把 legacy → 模块 public 面的边按**消费者**记账之后，这个路由消费 memory / identity-access /
resource-catalog public 的 **8 条**边全记进了 W4-E1——而「把这个 memory 路由搬进模块 inbound」恰恰是 W4-E2
自己的活（AC-6 就是冲它去的）。不纠正的话，本 RFC 的退出数字是**靠一个分类 bug 变好看的**。

修法按本文件既有的 `*_INBOUND_FILES` 形态逐文件登记（新增 `MEMORY_INBOUND_FILES`），**不**把判据放宽成
`/memor/` 或加 `memories`：`services/fusion.ts#unfuseMemoriesTx` 一类符号同样含 `memories`，而 fusion 已由本 RFC
明确转交 knowledge-evolution（W4-E3），放宽会把它们反向吸回 memory。

纠正后：**W4-E2 35 → 43、W4-E1 846 → 838**，全局总数不变。其余 23 个兜底 route 文件的归属是同类问题，
但属全局记账裁决，随下一批账本工作处理（已登记进 RFC-294 `plan.md §14`）。

## 5. 并发协调

- `cli/start.ts` / `cli/postgresqlDaemonApplication.ts`：`agent-workflow-58`（RFC-349）已于 2026-09-03 明示
  「不占了」，但其 T10/T11 取证若再暴出 provider-session 问题会回来动 `start.ts`——开工前先 `git fetch` 看 tip。
- `architecture/*`：任何重采前先确认 census 源码面
  （`packages/{backend,shared,frontend}/src` + `.dependency-cruiser.cjs` + `scripts/depcheck.ts`）只剩自己的改动；
  推之前用 `git archive <本提交>` 导出重跑做逐字节自验。
- `services/fusion.ts` 属 E3，本 RFC 只保证它消费的 memory public 面稳定，不改它。
