# RFC-359：任务分解

## 0. 波次总览

**原则（D2/D3，修订）**：每一波自身可发布。实际顺序按硬依赖：**W2（原语+矩阵）→ W1 实现类条目 →
W1 接线类条目 → W3 → W4 → W5 → W6**。原稿「W1 优先」的理由对接线类条目成立，对实现类条目不成立
（它们在 PG 侧根本没有实现，在 W2 之前修只能抄第二份——正是本 RFC 要消灭的东西）。

| 波 | 内容 | 为什么是这个顺序 |
| --- | --- | --- |
| **W1** | 修 12 条 P0，让 PG 真的能跑任务 | 不修的话后面每一波都在一个跑不起来的 provider 上验证 |
| **W2** | 统一事务原语 ✅ + 能力矩阵 `EngineCapabilities` | 它是「一份实现」的唯一技术前提；矩阵是「PG 最高性能」的唯一表达处 |
| **W3** | 统一启动序列（消灭 `cli/start.ts` 的 provider 分支） | 结构性缺陷的正身；W1 修的多数缺口在这里被永久关闭 |
| **W4** | 逐 context 合一适配器（153 对 → 0） | 体量最大，但 W2 之后是机械工作 |
| **W5** | 防复辟：七条结构性守卫 + harness 按 provider 参数化 + **全量套件在真 PG 上进 push CI** | 守卫的棘轮值要等 W4 收敛完才能钉死；覆盖率对等棘轮可提前到 W1 后立即上 |
| **W6** | PostgreSQL 性能：JSONB + GIN 投影、`EXPLAIN (ANALYZE)` 热查询审计、双引擎性能基线 | 放 W4 之后——合一前给 PG 调优就是在给一份即将删除的实现调优 |

## 1. W1 —— 修 P0（让 PostgreSQL 可用）

| 任务 | 内容 | 证据 |
| --- | --- | --- |
| T1 | **P0-7** 延迟提问自动派发：PG 无实现。做法二选一（设计门定）——①把 `legacySqliteClarify/autoDispatch.ts` 收成 provider-中立一份；②W2 之后再合一，W1 先给 PG 一个诚实降级（不抛、记结构化诊断） | 真机实证，`node_runs` 0 行 |
| T2 | **F-H2-1** 评审决定 / 反问下发 / 快速澄清三条命令端口：PG 无实现，路由必 500 | `commandContext.ts:161-186` |
| T3 | **F-H2-2** development mission 的 `agentLauncher` / `scriptLauncher` 未注入 + 终态观察者零调用 | `agentActionOrchestrator.ts:274-279` |
| T4 | **P0-3/P0-4** boot 恢复四步在 PG 不可达；`servePostgresqlDaemon` 永不返回 | `cli/start.ts:1160-1162,1570,2007-2037` |
| T5 | **P0-5** clarify 全量封存在 PG 上 409 并回滚整笔答案 | `postgresqlNodeRunLifecyclePersistence.ts:154-160` |
| T6 | **P0-6** 定义损坏的工作流在 PG 上永久删不掉、列表整体 422 | `postgresqlWorkflowRepository.ts:258` |
| T7 | **P0-1/P0-2** 两道 owner 围栏：适配器不读环境上下文 / effect 账本私有 fence 加等值判定 | 真库复现 + `postgresqlTaskLifecycleTransaction.ts:153-157` 的反证注释 |
| T7b | **P0-10** 驱动释放不清算 effect ⇒ owner 永久卡 `claimed`、重启也救不回。**须连中立端口一起改**——`taskExecutionEffectStore.ts:125-150` 压根没声明这两个成员 | `postgresqlTaskDriverLifecycle.ts:106-157` vs `taskDriverLifecycle.ts:127-212` |
| T7d | **P0-11** 技能启动屏障从不装配 ⇒ 崩溃后该技能永久保存不了 / 同名永远建不了；损坏快照照常注入任务 | `composePostgresqlSkillCatalogBoot` 零调用方 |
| T7e | **P0-12** 工作组反问在 PG 上等于不存在（`protocolBlock` 是 stub，agent 永不发起反问） | `workgroupTurnsDriver.ts:432-439,551-562` |
| T7c | **任务删除认领无恢复方**：`recoverInterruptedTaskDeletes` 形参是 `LegacySqliteTaskDatabase`，**修好启动序列也接不上**，须写 provider-中立版 | 正常并发的 `ConflictError` 分支即可达 |

**每条都要**：先写一条能稳定复现的红用例（PG 侧），再修，修完再跑一次原变异确认转红。

**W1 的实际形状比「接线」重**：T1（clarify 自动派发）、T2（三条决定命令）、T7b（effect 清算）、
T7c（删除恢复）四条**在 PG 侧根本没有实现**，或**中立端口本身没声明该能力**——不是「写好了没人调」，
是要连端口带实现一起补。规模评估须按这个口径重做，不能按 W3 的接线量类比。

**T7 的次序说明**：P0-1 当前被 P0-7 遮蔽（任务活不到 `runNode`）。T1 落地后 P0-1 是否立刻接棒
**必须实测确认**，不能假定。

## 2. W2 —— 统一事务原语

- **T8** `platform/persistence/transaction.ts`：`DatabaseSession.transaction()`，两个 provider 各一实现
  （design §3.2 / §3.3）。
- **T9** `platform/persistence/writerLease.ts`：SQLite 进程内单写者异步租约 + 重入检出
  （`AsyncLocalStorage`）。
- **T10** 原子性对拍用例：proposal §3 的三组实测固化，两个 provider 各跑一遍（**AC-3**）。
- **T11（修订）** ~~`dbTxSync` 改为兼容层~~ **做不到**（同步返回 `T`，转调异步必改签名）。改为：
  逐 context 迁移调用点，与 W4 各批同批；`dbTxSync` 调用点归零时删除。过渡期共存危险形态已由
  `db/transactionScope.ts` 堵死（`88b9a5940`）。
- **T11b** `platform/persistence/capabilities.ts`：`EngineCapabilities` 接口 + 两个 provider 实现
  （design §5）。把散落的既有资产收进来：`postgresqlNullOrdering.ts`、三条 parity 守卫的判据、
  `postgresqlSerializationRetry.ts` 的 `errno` 判据、RFC-357 的 `numeric*` 归一、标量函数 shim 清单。
  每项双引擎实测断言。
- **T11c** PG 会话默认 READ COMMITTED，`serializable(…)` 作 opt-in；`lockAggregateRoot` / `claimRows` /
  `advisoryLock` 三个并发原语落地并双引擎实测。
- **T12** 事务体软超时 + 结构化诊断；lint 规则禁止事务体内 import 进程/网络/fs（design §3.4）。
- **T13** RFC-311 基准库上实测吞吐前后对比，结果写回 proposal §6 的 **C-2**。

## 3. W3 —— 统一启动序列

- **T14** 删除 `servePostgresqlDaemon` 的永不返回形态；PG 与 SQLite 汇入同一条 boot 序列。
- **T15** 逐条接上 PG 缺的 boot 步骤（补审已列全）：boot 恢复四步、skill catalog boot 五项、
  终态工作区回收策略注册、数字员工模板播种、demo 播种、融合三步、定时任务载荷治愈、
  终态维护恢复五项。**多数 PG 适配器已写好且已接进 persistence，只是没人调。**
- **T16** `cli/start.ts` 里 `provider === 'sqlite'` 的执行分支归零（**AC-2**）。
- **T16b** schema 契约补**触发器**维度：今天投影只覆盖表/列/约束/索引，9 个 SQLite 触发器一个都没到 PG。
  逐条判定「投影成 PG 触发器」还是「上移为应用层判据」，`node_runs.lineage_slot_path_json` 是唯一
  当前没有应用层等价物的一条。

## 4. W4 —— 逐 context 合一适配器

按前置对账的缺陷密度排序，**每个 context 一个 PR**：

| 批 | context | 配对数 | 已知缺陷 |
| --- | --- | --- | --- |
| B1 | task-execution | 44 | 最多（P0 ×4 + P1 ×10+） |
| B2 | resource-catalog | 29 | P0 ×1 + P1 ×10 |
| B3 | collaboration | 19 | P0 ×2 + P1 ×2 |
| B4 | memory / identity-access / intent / integration / auth | 25 | P1 ×2 |
| B5 | digital-employee / development-automation / code-capability | 23 | P0 ×1 + P1 ×1 |
| B6 | platform / event-center / source-control / knowledge-evolution | 13 | **0**（本就同构，机械合一） |

每批的做法见 design §4。**B6 放最后**：它零缺陷，是最干净的收尾，也是给守卫钉棘轮的基线。

## 5. W5 —— 防复辟

- **T17** provider 命名文件只允许在 `platform/persistence/`（棘轮到 0）。
- **T18** 裸 `db.transaction(` 只允许在事务原语文件。
- **T19** `provider === ` 只允许在 `platform/persistence/`，其余全仓 exact 账本为空。
- **T19b** 组合根全量：`cli/` 与 `*/composition*` 下禁 `*-not-bound` 与晚绑定 holder。
- **T19c** 启动序列恰有一个调用方，`cli/start.ts` 无 provider 执行分支。
- **T19d** 覆盖率对等棘轮（过渡期，可在 W1 后立即上）：同一 port 两侧行覆盖率差超阈值即红。
- **T19e** `tests/helpers/eachProvider.ts`：`describeEachProvider` harness（design §11.1）——双引擎是
  **缺省**，PG 侧无 URL 即 **fail** 而非 skip（`AW_TEST_PROVIDERS=sqlite` 仅本地显式降级）；
  per-file schema 隔离；body 拿不到 provider 名。存量 816 文件 / 1,882 处 `createInMemoryDb(` 逐 context 迁入。
- **T19f** 守卫「测试不得写死引擎」：harness 之外的 `createInMemoryDb(` 棘轮 1,882 → 0；测试内
  按 provider 分叉须经 `capabilities` 且计数入账。
- **T21b** 执行链取证进 push CI：两个引擎上各起一个任务跑到 done（RFC-349 验收漏掉的那一环）；
  `postgresql-evidence.yml` 的 `prepareSoakDataset` 不再把在飞任务归一成 done。
- **T20** 方言表完备性守卫（语料按类型可达派生，沿用 `tests/architecture/postgresqlSurface.ts`）。
- **T21** **四个 backend 分片各自带 `services: postgres:17`**，PG 半边在每个分片里跑（design §11.2）；
  `test-backend-postgresql` 窄 lane 退役。时长由 per-file schema 并行 + W4 后测试数减半对冲，
  实测写回 proposal §6。按 D5 不打折。
- **T22** 退役 `rfc349-dual-provider-predicate-drift`（对象已消失），退役 `dbTxSync`（**C-1**）。

## 5b. W6 —— PostgreSQL 最高性能（design §10）

- **T23** DDL 投影：JSON 列在 PG 上渲染为 JSONB；热查询列建 GIN（D6，存量 PG 部署一次迁移）。
- **T24** 矩阵的 `jsonExtract` / `jsonContains` 渲染成 `->>` / `@>`；替换 `json_extract` shim 的热路径调用。
- **T25** 批量写：矩阵给出 `batchInsertMax`，逐行 INSERT 的热路径改按批。
- **T26** RFC-311 基准库在 PG 上跑 `EXPLAIN (ANALYZE, BUFFERS)`，逐热查询审执行计划，补 PG 独有索引
  （partial / expression / GIN）并经矩阵声明。
- **T27** 5 个性能守卫改 `describeEachProvider`；两个引擎各取 P95 基线；**PG 不劣于 SQLite**（AC-11）。
- **T28** 写法纪律审计：全仓「读—改—写中间不锁」的形状清单，逐条改成 `lockAggregateRoot`（design §10.1）。
  这类代码在 SQLite 上碰巧正确、在 PG 上是竞态——合一时必须改形状，不能原样搬。

## 6. 债与不做的事

- `legacySqlite*` 家族（clarify 子系统 3,401 行等）合一后仍带 legacy 命名与分层位置；
  **本 RFC 不迁**，随各 context 下一个 RFC 归位（design §1）。
- `workgroupTurns` 两侧是两套独立引擎（839 行 ↔ 2,801+561 行），**未做逐方法对拍**，
  分歧面可能比已发现的还大。**建议单独立一轮对账**，其结论可能给 W4-B1 增批。
- 前置对账的 5 条存疑项（Q1–Q5）不在本 RFC 范围，随 W4 各批顺带确认或销账。

## 7. 风险

| 风险 | 缓解 |
| --- | --- |
| W2 的单写者租约改变 SQLite 吞吐特征 | T13 基准实测；结果不可接受则回到「两套事务机制 + 上层一份实现」的退化方案（代价是 design §3 的统一性打折） |
| W4 体量大、跨 6 个 context、与并发 RFC 撞车 | 每 context 一个 PR；合一时只动 provider 维度，不顺手重构；撞车面按 CLAUDE.md 多人协作规则处置 |
| 合一过程中把 SQLite 侧的正确行为改坏 | 每对合一都带「合一前后 SQLite 行为逐字对拍」（AC-8） |
| P0 修复本身引入回归 | 每条先红后绿 + 修完再跑一次原变异确认转红（RFC-287 五轮门纪律） |
