# 双 provider（SQLite ↔ PostgreSQL）语义对账审计（2026-09-04）

> 起因：用户切到 PostgreSQL 后连撞两处任务列表缺陷（`bfc84968a` 页签计数、`d7b2fab72` 启动来源
> 筛选），提出判断——**「SQLite 路径是长出来的，PG 路径是凑出来的」，两个路径缺乏统一的架构抽象、
> 共享的设计规范和同步的优化演进**。本轮对全部 153 对 provider 适配器做一次逐对对账，验证该判断
> 并产出实际缺陷清单。
>
> **只审功能**（CLAUDE.md §工作准则 2026-08-26 硬规则）：安全类一律不扫不提；TOCTOU / 并发竞态 /
> 锁顺序 / 事务隔离级别按同一规则弃置。本文件中「两侧对同一输入算出的结果不同」属功能，收录；
> 「此处可被绕过 / 应加一道校验」属安全，不收。

## 0.0 采数基线与已被并发修复的条目（**先读这节**）

- **对读时的工作树**：RFC-357（任务列表页查询归一）正在并行落地，`taskListPage/` 当时是未追踪目录、
  `postgresqlTaskCatalogSources.ts` 处于修改中。
- **复核基线**：`87d080300`（`perf(tasks): RFC-357 PR-3 PostgreSQL 任务列表切到共用下推查询`）。
  在该 SHA 上 `postgresqlTaskCatalogSources.ts` 已从 290 行降到 **21 行**——第二份实现整个删除，
  两个 provider 共用 `taskListPage/`。
- **因此下列条目在 `87d080300` 上已修复，保留在本文件里只作为「同一形状曾经存在」的记录，
  不进处置清单**：P1-02（目录根页只取顶层行）、P1-03（耗时列双计）、P1-04（层级五字段写死）、
  P1-05（搜索面缺任务 ID 与多仓）、P1-06（来源页签归类错）、P2-01（`limit:10_000` + `SELECT *` + N+1）。
- **其余条目已在 `87d080300` 上逐条重核，仍然成立**；六条 P0 全部重核通过
  （`postgresqlNodeExecutionPersistence.ts:72` 的 `context === undefined` 围栏、
  `postgresqlTaskExecutionEffectPersistence.ts:93-94` 的等值判定、`cli/start.ts:1160` 的
  `never resolves`、`postgresqlWorkflowRepository.ts:258` 的无条件解析均在）。

## 0.1 端到端实证（2026-09-04，本机真 PostgreSQL 17.11）

**结论先行：PostgreSQL 部署上任务跑不了，已端到端证实；但当前生效的根因不是 §2 的 P0-1。**

### 实验设置

隔离 app home + Docker `postgres:17.11`，走与生产同一条路：SQLite 起库 → 建管理员 →
`/api/database/migrations` 一键迁移（preflight ok，184 表 / 149 行，到达 `accepting-writes`）→
`/api/database` 确认 `provider=postgresql` → 在 PG 上起同一个 demo 工作流任务。

### 对照组（SQLite）：正常

```
node_runs:  in_diff -> done
            review  -> running        ← 节点进得了 running
owners:     claimed  revision=18      ← owner 是 claimed，心跳在推进
```

### 实验组（PostgreSQL）：任务失败，零 node_run

```
tasks:      status=failed
            error_summary  = 'scheduler error'
            error_message  = 'deferred-question-dispatcher-not-bound'
node_runs:  0 行
daemon log: ERROR [scheduler] runTask: scope threw — failing task error=deferred-question-dispatcher-not-bound
```

### 新 P0（本轮 153 对配对审计**完全没覆盖到**）

**P0-7：PostgreSQL 上「延迟提问自动派发」子系统未实现，占位符在运行时抛错，每个任务必死。**

- `cli/postgresqlDaemonApplication.ts:719` 创建 `DeferredTaskQuestionDispatcherBinding`，`:722`
  作为 `deferredQuestions` 依赖传给 `createPostgresqlTaskDagCollaborationOperations`；
  **全文件对它的 `.bind(...)` 调用计数 = 0**，`current` 永远是 `null`（`:323-325` 抛）。
- `taskDagScope.ts:141` 在 `runTask` **开头**的 DAG scope 装配里调
  `taskDagCollaboration.autoDispatchDeferredQuestions(taskId)` ⇒ 立即抛 ⇒ scope threw ⇒ 任务 failed。
- **不是漏了一行 bind，是没有可绑的东西**：`dispatchDeferredTaskQuestions` 只存在于
  `legacySqliteTaskQuestionDispatch.ts:657`（SQLite 专属）；整个 `legacySqliteClarify/` 子系统
  **3,401 行**是 SQLite 专属；PG 侧 4 个 clarify 适配器没有一个是派发引擎。
  SQLite 那条路直连实现（`sqliteTaskDagCollaborationOperations.ts:16`），不经 holder。
- **这个形状defeat 了 RFC-349 唯一的完整性强制手段**：`rfc349-provider-completeness.test.ts`
  开篇写明「唯一在结构上逼这 216 个适配器保持完整的是**共享 port 接口**——加一个 METHOD 会让
  两个 provider 的工厂都编译不过」。**晚绑定 holder 在编译期满足接口、在运行期为空**，
  正好从这个强制手段底下穿过去。

### 对 P0-1 的定性更正

P0-1（PG 适配器不读环境执行上下文 ⇒ node 写入被 ownerless 围栏拒）**在适配器层是真的，
且已取得真库证据**——在本次的真 PostgreSQL 上造 `owner='claimed'` + 一条 node_run，
直接调 `PostgresqlNodeExecutionPersistence.patch`（不传 context）：

```
TaskExecutionError: ownerless task mutation refused durable owner for '01M1P4F8ESPNT37422C7JYV26Z'
```

**但它在今天的代码上够不着**：任务在铸出任何 node_run 之前就被 P0-7 杀死，`runner.ts` 从未被调用。
原文「PostgreSQL 部署上节点执行的第一次写就会被自己的围栏拒掉」**应更正为**：该围栏在适配器层
确实会拒，但当前被 P0-7 遮蔽，是否会在 P0-7 修复后立即接棒**未经验证**。

### 本审计的方法缺口（已在补）

本轮语料定为「153 对**配对**适配器」，于是 **163 个无 SQLite 配对的 PG 面文件（49,748 行，
与已审面积相当）整体不在语料里**——`cli/postgresqlDaemonApplication.ts`（1,929 行，PG 组合根正身）
就在其中，P0-7 正藏在那里。**配对 diff 找得到「两侧实现不同」，找不到「PG 这边压根没接线」。**
补审已另起一轮，按「装配缺口」判据切 6 片（daemon 组合根 / 模块 composition / resource-catalog /
employee-devauto / task-execution / platform）。

## 0. 总判定

判断成立，且比「凑出来的」更重。三层证据：

1. **数量**：153 对适配器中约 **55 条确证功能缺陷**（其中 6 条已由 `87d080300` / RFC-357 PR-3 修复，**约 49 条待处置**），含 **12 条 P0**（PG 上核心功能不工作，全部仍在）——其中 **P0-7 由端到端实证发现**（§0.1），它落在本轮语料**之外**的 PG 组合根里，且它先于 P0-1 生效。
2. **方向**：**不是单向劣化**。`E-1` 是 SQLite 侧更差；`B-2` / `D-1` 是 PG 侧违反了**写在本仓自己
   源码注释里的设计意图**。这是两条路径各自演进、互不知情，不是一条路径抄劣了另一条。
3. **分布**：平台底座层（committed events / 逻辑导出 / 事件中心 / 运行时注册表，13 对）**零缺陷**；
   越靠近用户功能面缺陷越密（task-execution 44 对约 29 条、resource-catalog 29 对约 20 条）。
   底座是「照着实现抄」，抄得住；功能层是「照着接口签名重写」，重写不住。

**根因不在 PostgreSQL，也不在数据**：分叉发生在**语义层**，而本仓的既有守卫覆盖的是 schema 层与
方言层（见 §5）。

## 1. 结构度量（可复跑）

| 指标 | 值 |
| --- | --- |
| `sqliteX.ts` ↔ `postgresqlX.ts` 配对 | **153** 对 |
| 配对文件行数 | SQLite 30,135 / PostgreSQL 49,288（**1.63×**） |
| PG 适配器代码**被任何测试执行过**的行占比 | **18%**（40,358 / 49,441 行从未执行） |
| 真库（真 PostgreSQL）测试文件数 | **4 / 1,669**，且只在每周 cron（`postgresql-evidence.yml`，`schedule: '30 3 * * 0'`）跑，push 不跑 |
| 性能守卫构造 SQLite / 提及 PostgreSQL | **5 / 0** |

覆盖率口径：对 236 个提到 postgresql 的测试文件跑 `bun test --coverage`（1,426 用例，156s），逐文件行覆盖。
未带仓里默认的 `--isolate --randomize`，产生 37 个失败，全部落在 `/api/mcps`、`/api/clarify` 等
**SQLite 侧路由测试**上；单独加 `--isolate` 重跑该文件 22 pass / 0 fail，确认是非隔离运行的串扰，
不影响 PG 侧数字。

**同一 port 两侧覆盖率对照**（节选）：

| port | SQLite | PostgreSQL |
| --- | --- | --- |
| `WorkgroupTaskRoomClarifyParticipant` | 100% | 2.38% |
| `TaskDagCollaborationOperations` | 100% | 3.45% |
| `TaskRuntimeLifecyclePersistence` | 100% | 4.39% |
| `CollaborationTaskAccess` | 90.68% | 4.17% |
| `McpRepository` | 90.96% | 7.60% |

`postgresqlSkillCatalogBoot.ts`（1,419 行）与 `postgresqlSourceTerminationParticipant.ts`（472 行）**零行执行**。

### 1.1 既有漂移守卫的盲区

`tests/rfc349-dual-provider-predicate-drift.test.ts` 的立意正确（其注释即记录了 RFC-352 的
`canManage` 漂移事故），但判据是「配对文件里**同名顶层 `function`** 的 body 逐字比对」：

- 153 对里 **106 对（69%）同名顶层函数为零**，守卫在它们身上一行都没扫到；
- 全仓真正被比对的只有 **131 个函数对**；
- 盲区恰好覆盖最大分叉——SQLite 侧是薄转调（逻辑在 `legacySqlite*` / `./legacy/*` /
  `@/services/*`）、PG 侧整份重写的那一类。例：`sqliteCollaborationRouteOperations.ts` 117 行
  ↔ `postgresqlCollaborationRouteOperations.ts` 2,268 行，同名顶层函数 0 个。

`d7b2fab72` 修的 `launch_origin` 正是盲区样本：两侧函数不同名、不同层（一个内存过滤、一个 SQL 谓词），
按定义看不见。

## 2. P0 — PG 上核心功能不工作

### P0-1 任务执行链：节点的第一次写就被自己的围栏拒掉（**已取得可执行证据**）

- **端口**：`NodeExecutionPersistence.patch` / `.appendEvents` / `.upsertOutputs` / `.replaceOutputs`；
  `NodeRunLifecyclePersistence.mint` / `.transition` / `.set`；`WrapperRunPersistence.clearReuseDisabled`
- **机制**：`services/runner.ts` **全文零处 `executionContext`**（grep 计数 0），依赖
  `AsyncLocalStorage` 环境上下文兜底。
  - SQLite 适配器读环境上下文：`input.context ?? currentTaskExecutionContext(input.taskId)`
    （`sqliteOwnedTaskMutation.ts:19`）
  - PG 适配器**不读**，把 `undefined` 当「无主」：`if (context === undefined) await
    assertPostgresqlTaskOwnerlessTx(tx, taskId)`（`postgresqlNodeExecutionPersistence.ts:72`；
    node_run 同形 `postgresqlNodeRunLifecyclePersistence.ts:36-39`；wrapper 同形
    `postgresqlWrapperRunPersistence.ts:89-93`）
  - `assertPostgresqlTaskOwnerlessTx` 要求 owner 行 `state === 'released'`
    （`postgresqlTaskLifecycleTransaction.ts:186-196`），而 drive 已在 attach 时把它 claim 成
    `'claimed'`（`postgresqlTaskDriverLifecycle.ts:80-99`），且整条 drive 包在
    `runWithTaskExecutionContext` 里（`taskDriveCoordinator.ts:184`）
  - 组装层**零包装**：`taskExecutionPersistence.ts:164` 裸 `new PostgresqlNodeExecutionPersistence(db)`
- **PG 确实走这条路**：`postgresqlTaskExecutionRuntimeParticipants.ts:22` 与
  `sqliteTaskExecutionRuntimeParticipants.ts:17` **import 同一个** `driveTaskEngineApplication`
  → `nodeExecution.ts` → `nodeMechanics.ts:88` → `runNode`（`services/runner.ts`）；
  `nodeMechanics.ts:204` 把 provider 选出的 persistence 传进去。
- **可执行证据**（脚本化 PG runtime，2026-09-04 实跑）：

  ```
  begin
  select "task_id" from "agent_workflow"."node_runs" where … = $1 limit $2
  select "state" from "agent_workflow"."task_execution_owners" where … = $1 limit $2
  rollback
  → TaskExecutionError: ownerless task mutation refused durable owner for 'T1'
  ```

  对照组 owner=`released` 不抛。
- **用户可见后果**：`runner.ts:911`（写 prompt 路径）不在 try/catch 内，进程还没 spawn 就抛；节点
  永不进入 `running`，任务以 `task-execution-stale-owner` 收场——一条与真实成因毫无关系的信息。
- **正确写法就在同模块**：`postgresqlRuntimeSessionCapturePersistence.ts:52` 与
  `postgresqlRuntimeSessionLeaseOperations.ts:41` 都先 `currentTaskExecutionContext(taskId)` 再 fence。

### P0-2 effect 账本私有围栏加了等值判定，首次心跳后所有 effect 写入被拒

- **端口**：`TaskExecutionEffectPersistence.prepareAndAcquire` / `.settle` / `.settleCodeHostNode` /
  `.settleWorkspacePreparation` / `.recordProcessSpawn`；`GateContinuationEffectPersistence.prepare` / `.settle`
- PG 私有 `assertOwner` 额外要求 `owner.revision !== token.ownerRevision`、
  `owner.leaseUntil !== token.leaseUntil`、`owner.leaseUntil < now`
  （`postgresqlTaskExecutionEffectPersistence.ts:93-95`），三处调用点用的都是 attach 时**冻结**的 token。
- **同一个仓里的公共** `assertPostgresqlTaskOwnerTx` 注释逐字写着：「心跳可能已经推进 revision，
  所以 revision/lease 快照**故意**不做等值谓词」（`postgresqlTaskLifecycleTransaction.ts:153-157`）。
  私有副本干的正是公共版本点名不能干的事。
- SQLite 侧 `withOwnedTaskTx` 从不比较 revision / leaseUntil（`sqliteTaskOwnership.ts:244-251`）。
- **后果**：心跳每 15s 推进 revision（`postgresqlTaskOwnershipPersistence.ts:229-236`，refreshed token
  被 `void … .catch()` 丢弃）；此后 `settleWorkspacePreparation` 抛错 ⇒ 工作树 / `task_repos` /
  `task_space_nodes` 一行不落；`prepareAndAcquire` 抛错 ⇒ 进程不 spawn；`settle` 抛错 ⇒ node_run 停在
  `running`。

### P0-3 PostgreSQL daemon 不跑 boot 孤儿收割与执行恢复

- `servePostgresqlDaemon` 以 `await new Promise<void>(() => { /* never resolves */ })` 结尾
  （`cli/start.ts:1158-1160`），PG 分支在 `:1569` 调用它；boot 恢复三步在 `:2006`
  （`prepareTaskExecutionRecovery`）/ `:2020`（`reapOrphanRuns`）/ `:2036`
  （`finalizeTaskExecutionRecovery`）——**全在其后，PG 上永远到不了**。
- `recovery.prepare(` / `recovery.finalize(` 全仓**零调用点**；
  `postgresqlTaskRecoveryOperations.ts:712-810` 与 `postgresqlTaskExecutionRecovery.ts:842-1085` 是生产死码。
- **后果**：PG 上重启一次 daemon，上一代所有在跑的任务与 node_run **永久停在 running/pending**；
  `listAutoResumeCandidates` 恒空；owner 行永远停在 `claimed` ⇒ 该任务此后任何启动 / 继续 / 重试
  恒 409 `task-execution-owner-conflict`。
- `tests/architecture/rfc349-provider-cutover.test.ts:37` 只把它记成 import 耦合债，**没写「PG 侧等于
  没有 boot 恢复」**。

### P0-4 兜底恢复写手同样被 ownerless 围栏拒绝

owner 行因 P0-3 永久非 `released`，而周期 orphan-reconcile（`postgresqlTaskRecoveryOperations.ts:812-826`，
异常被自己 `catch { return false }` 吞成静默）与 S4 自动修复
（`postgresqlTaskLifecycleAutoRepairCommand.ts:109`，抛出的 `TaskExecutionError` **不是**
`ConflictError`，`trySet` 的 catch 兜不住）在 PG 上恒空转。SQLite 侧三条路都不读
`task_execution_owners`。

### P0-5 clarify 全量封存：node_run 已离开 `awaiting_human` 时 PG 回滚整笔答案

- 两侧写入前置守卫**完全一致**（都只拒 `done`/`canceled` 的任务；`legacySqliteClarify/seal.ts:222-236`
  注释原文「failed / interrupted stay answerable」），所以两边都会走到状态翻转。
- SQLite：带 CAS 的条件 UPDATE，`WHERE id = ? AND status = 'awaiting_human'`，命中 0 行即安全 no-op，
  封存事务照常提交（`legacySqliteClarify/seal.ts:412-417`，注释原文「The CAS on
  status='awaiting_human' makes it a safe no-op if the node already left that state」）。
- PostgreSQL：`set({ allowedFrom: ['awaiting_human'] })`（`postgresqlNodeRunLifecyclePersistence.ts:154-160`）
  对终态行抛 `ConflictError`，与写答案同事务（`postgresqlCollaborationRouteOperations.ts:2171`）⇒ 整笔回滚。
- **后果**：PG 返回 409，用户刚提交的答案一条都没存下，round 仍停在 `awaiting_human`，重试只会再 409 ⇒ 死锁。

### P0-6 定义损坏的工作流在 PG 上永久删不掉，且列表整体坏死

- SQLite 专设 `getWorkflowAclRow`，注释写明「删除路径必须在 definition 损坏时仍可用（**你必须能删掉
  一个坏掉的工作流**），所以不能走 getWorkflow 的 schema 校验」（`legacy/workflow.ts:133-138`）。
- PG 的 delete 事务**第二条语句**就是无条件 `workflowFromPersistenceRow(row)`
  （`postgresqlWorkflowRepository.ts:258`），该 mapper 对坏 JSON / schema 不匹配抛
  `ValidationError('workflow-definition-corrupt')` ⇒ 422（`workflowPersistence.ts:31-48`）。
- **后果**：`GET /api/workflows` 两侧都过同一 mapper，一行坏数据就让整个工作流列表 422。SQLite 上
  用户删掉坏行即可自救，**PG 上没有任何 API 路径能移除它**。

### P0 的定性：是缺陷，不是「已知未实现」

对过 RFC-349 自身的验收标准，四条 P0 全部落在**它声称已达成的范围之内**：

- **AC-3**：「PostgreSQL provider 支持 boot migration、pool/readiness、**所有 application command/query**、
  事务、background、backup/restore 与 …」——任务执行是 application command 路径。
- **AC-12**：「SQLite 与 PostgreSQL 对关键 CAS、**lease/fence**、idempotency、outbox、committed event、
  apply recovery 运行**相同 behavior oracle**」——P0-1 / P0-2 正是 lease/fence 分叉。

§4 非目标里确有「scheduler lease 与 execution worker ownership 仍需后续 RFC」，但该句在原文中属于
**「不因 PostgreSQL 可连接就宣称支持多 daemon、水平扩容或高可用」**那一条，指的是**跨实例** ownership，
不是单 daemon 上 ownership 不工作。

AC-12 的 oracle（`tests/rfc349-dual-provider-behavior-oracle.test.ts`）确实存在，但其覆盖面是
resource-package apply journal + committed event delivery + maintenance run store 三处，
**不含任务执行的 owner fence**。AC-12 在字面上达成（oracle 存在），在实质上没有覆盖最要紧的那道 fence。

AC-14 的 hosted 取证「crash/resume 26/26」是**迁移检查点**的 crash matrix
（`postgresql-evidence.yml` 的 scale job 杀的是 durable migration checkpoint），不是任务执行恢复，
与 P0-3 不矛盾。

## 3. P1 — 结果错但不报错（约 28 条）

### 3.1 任务目录 / 详情（task-execution，均已逐条复核）

| # | 缺陷 | SQLite | PostgreSQL |
| --- | --- | --- | --- |
| P1-01 | 任务的工作流名恒为空 | `leftJoin(workflows)` + `workflows.name`（`services/task.ts:6464,6663`） | `workflowName: null` 写死（`postgresqlTaskRouteOperations.ts:329,404`），**零个 workflows JOIN**。连带首页整列显示「—」、来源列显示裸 ULID、详情页工作流跳转区块永不渲染 |
| P1-02 ✅已修 | 目录根页只取顶层行 | 匹配行 ∪ 祖先闭包；facets 覆盖全深度（`taskListPage/query.ts:75-93,176,194`） | `topLevelOnly: true`（`postgresqlTaskCatalogSources.ts:222`）；子任务不带出父、facets 不计子任务、排序不因子任务新起而顶上分支 |
| P1-03 ✅已修 | 耗时列**双计**且停等被计费 | 投影 `running_ms` / `running_since` 两列（`taskListPage/projection.ts:210-211`） | `now - startedAt` 现算（`:115-116`）；前端再 `+= now - runningSince`（`task-operations-duration.ts:17-20`）⇒ **≈2×**。schema 注释明写 RFC-207 的意图正是避免停等被计费（`db/schema.ts:992-1000`） |
| P1-04 ✅已修 | 层级五字段写死 | 全部来自 SQL 计算列（`projection.ts:213-220`） | `matchKind:'self'`、`qualifyingChildCount: item.childCount` 等硬编码（`:130-134`）⇒ 展开箭头打开空列表、命中分支永不自动展开、父不可见 chip 永不出现 |
| P1-05 ✅已修 | 搜索面不同 | 7 字段 + `EXISTS task_repos` + `ESCAPE`（`filters.ts:250-266`） | 内存 `includes` 9 字段（`:245-256`）：**无任务 ID、无多仓次要仓库**；`>100` 码点的 `q` SQLite 400、PG 200 |
| P1-06 ✅已修 | 来源页签归类错 | `source_agent_name`，与 shared 唯一判据 `taskExecutionKind` 同源（`shared/src/schemas/task.ts:721-723`） | `sourceAgentId`（**另一列**）、agent/workgroup **顺序反了**、无 `codeRoundId` 分支（`postgresqlTaskCatalogSources.ts:67-71`） |
| P1-07 | 多仓无基线 diff | `DomainError('task-no-base-commit', 409)`（`services/task.ts:7337-7341`） | 无此检查 ⇒ **200 + 空 diff**（`postgresqlTaskRouteOperations.ts:1103-1132`；单仓分支的 409 保留了） |
| P1-08 | 同步横幅误亮 | builtin / 任务状态 / worktree 三类判据齐全 | 只有 3 道闸，之后无条件 `syncable: true`（`:1236-1300`） |
| P1-09 | **内建工作流可被手动重跑** | `assertNotBuiltin` ×2（`sqliteTaskRouteOperations.ts:119,131`） | 整文件 grep `builtin` **零命中** ⇒ resume / retry / syncWorkflow 全部放行 |
| P1-10 | run 时间线漏 RFC-078 锚点重排 | SQL 排序后再 `runs.sort(compareNodeRunsForTimeline)`（`services/task.ts:7044`） | 全程不调该函数 ⇒ 评审行排到它所评审的那次重跑**之前** |

### 3.2 任务执行持久化（task-execution）

- **P1-11** `interruptSurvivor` 不做运行时钟结算：SQLite 在同一条 UPDATE 里
  `runningMs += now - runningSince` 并置空 `runningSince`（`platform/persistence/sqlite/taskLifecycle.ts:588-596`），
  PG 整段缺席（`postgresqlTaskExecutionShutdownOperations.ts:36-51`）⇒ 每次 daemon 重启白送一整段时长配额，
  且 interrupted 期间 `effectiveRunningMs` 持续增长并落进数字员工计费。
- **P1-12** Webhook 任务终态工作区自动清理在 PG 上整套是死的：`cli/start.ts:1622` 的注册落在 P0-3
  那段到不了的代码里，`composePostgresqlWebhookTerminalWorkspacePrunePolicy` 全仓零生产调用方；
  且 `postgresqlSourceTerminationParticipant.ts:300-347` 的手写 UPDATE 压根不查回收策略 ⇒ 设置开关
  在 PG 上完全无效，worktree 永不回收。
- **P1-13** 取消任务落库的原因文案不同（`'canceled by user'` vs `'canceled by parent task'` /
  `'canceled-by-user'`）。
- **P1-14** 冻结 `trigger_context_json` 损坏时恢复任务：SQLite 422 拒绝
  （`services/task.ts:4555-4561`），PG 无 `kind === 'invalid'` 分支 ⇒ 照常重跑
  （`postgresqlChildTaskLifecycleParticipant.ts:131-143`）。

### 3.3 collaboration

- **P1-15** 空源评审自动通过时 PG 把任务从 `awaiting_review` 放行：两侧 `refresh` 定义逐字相同
  （`legacySqliteReview.ts:835` / `postgresqlCollaborationRuntimeMechanics.ts:1553`），但 SQLite 要求
  `refresh && status==='awaiting_review'`（`legacySqliteReview.ts:1023`），PG **只看 status**（`:1347`）
  ——`refresh` 传了不用 ⇒ 另一个评审闸门还开着，任务已被放行，下一轮 frontier 再 park 回去 ⇒ 状态抖动。
- **P1-16** 正文文件被 GC 后看历史版本：SQLite 转 `NotFoundError` ⇒ 404
  （`legacySqliteReview.ts:1617-1630`）；PG 裸调无 catch，`HumanGateOperationError extends Error`
  （非 `DomainError`，`domain/humanGateOperation.ts:62`）⇒ **500**（`postgresqlCollaborationRouteOperations.ts:583`）。

### 3.4 resource-catalog

- **P1-17/18** 工作流删除**丢掉两道引用守卫**（运行中任务 `workflow-in-use`、定时任务
  `workflow-scheduled-referenced`）；代理删除**丢掉三道**（`agent-tasks-active` /
  `agent-scheduled-referenced` / `agent-launching`）⇒ 返回 204 而非 409：任务还在跑、工作流已消失；
  残留定时任务每次触发 `workflow-not-found` 直到自动停用。
- **P1-19** PG 自创一条「被别的工作流调用」删除拦截，且**跨 owner 按名字**匹配、全表扫
  （`postgresqlWorkflowPersistenceSemantics.ts:218-242`）：拦截者可能是删除者根本看不见的工作流，
  且复用 `workflow-in-use` 码 ⇒ 前端提示「请先删除引用它的任务」而根本没有这样的任务。
- **P1-20** 保存时从不校验**改过的**工作流名 ⇒ 创建表单拒绝的名字可经重命名绕进 DB / 导出 YAML /
  call-workflow 选择器。
- **P1-21** 改 MCP 权限时 SQLite 终结进行中的 playground 会话（`legacy/mcpRuntimeTestTransitions.ts:50-75`），
  PG 的 ACL 应用路径根本没有 `afterWriteInTx` 参数 ⇒ 零行被触碰。
- **P1-22** 工作组房间消息：SQLite 用 `monotonicFactory()`（`legacy/workgroup/messages.ts:28`），
  PG 用普通 `ulid()`（`workgroupTurnsDriver.ts:371`）。房间在服务端与客户端**都按 id 排序** ⇒ PG 上
  同一轮多条消息随机顺序；且游标推到批次最大值后，同批次里 id 较小的消息对该成员**永久不可见**。
  （本仓自测数据：普通 ULID 同毫秒 2000 对里 989 对逆序，`services/task.ts:6079-6082`）
- **P1-23** ZIP 导入不重写 SKILL.md 的 `name`（`postgresqlSkillContentLifecycle.ts:148-154` 原样落盘）
  ⇒ 预览面板承诺的「name will be replaced by directory name」不兑现；改名导入后 DB 行是新名、文件里
  是旧名；`stageSkills` 把整棵树拷进运行时配置 ⇒ **agent 看到的技能名是旧名**。
- **P1-24** PG 用另一个解析器读 SKILL.md，`trimBody` 剥掉正文首尾空白（`shared/src/skill-md.ts:63-65`）
  ⇒ 用户重新打开技能发现空行没了，下次保存把剥过的版本固化（SQLite 逐字保留，
  `util/frontmatter.ts` 文件头明写 "preserves the body verbatim"）。
- **P1-25** 引用**已停用**的插件，PG 报 `plugin-not-found`（行加载器直接
  `eq(plugins.enabled, true)`，`postgresqlAgentPersistenceSemantics.ts:98`）而非 SQLite 的
  `plugin-disabled` ⇒ 用户去找一个被删掉的插件，而不是把列表里那个重新启用。
- **P1-26** 代理删除两类冲突在 PG 被压成一个无 details 的 `agent-in-use` 且分支顺序相反 ⇒ 提示把用户
  指到错误的页面，`<ErrorDetails>` 引用清单为空。

### 3.5 其他

- **P1-27** 邮箱撞车（**方向相反：SQLite 更差**）：两条命令都无邮箱前置检查
  （`createManagedUser.ts:72,92` 只查 username），都撞库唯一约束。PG 把 `23505` 映射成
  `profile-email-conflict` ⇒ **409 + 可读文案**（`postgresqlUserAccessRepository.ts:742-757`）；
  SQLite 侧 `run` 无任何约束错误映射 ⇒ 裸 `SQLiteError` 一路抛到 `app.onError` ⇒ **500 `internal-error`**。
- **P1-28** 搜索的转义与大小写（**新方言差异，不在既有陷阱清单上**）：drizzle 的 `like`/`ilike`
  都不带 `ESCAPE` 子句。SQLite 实测——`%C:\build%` 命中 `C:\build\out`（`\` 是字面量）、`%cafe%` 命中
  `CAFE`（ASCII 折叠）、`%café%` **不命中** `CAFÉ`（非 ASCII 不折叠）；PG 的 `LIKE`/`ILIKE` 默认转义符
  就是 `\`、且按 collation 全量折叠 ⇒ 两个方向都错（`sqliteRuntimeStore.ts:672-683` vs
  `postgresqlRuntimeStore.ts:699-710`）。

## 4. P2 — 规模或边界（约 21 条，节选）

- **P2-01 ✅已修（`87d080300`）** 任务目录：`limit: 10_000` + `db.select()`（=`SELECT *`，拖 `workflow_snapshot` 等大 JSON 列）
  + 失败任务逐行 N+1（`postgresqlTaskCatalogSources.ts:229` / `postgresqlTaskRouteOperations.ts:466-489`）。
  **即 RFC-357 的那条，PR-3 已落地。**
- **P2-02** 评审待办角标：SQLite 一条带部分索引的 SQL 只投影 `(taskId, reviewNodeId)`
  （`legacySqliteReview.ts:1877+`，RFC-311 显式优化）；PG 转调
  `listPostgresqlReviewSummaries(unbounded:true)` 全量取 pending `doc_versions` + 拉
  `tasks.workflowSnapshot` 逐任务解析，组装完整 `ReviewSummary[]` 后才在 JS 里 filter 计数。
  **每标签页每 15 秒一次**（`InboxFooterButton.tsx` `refetchInterval: 15_000`）。
- **P2-03** 工作流校验每次全表取回 `workflows` 并逐个 JSON.parse + schema 校验 + 迁移
  （`postgresqlWorkflowValidation.ts:94,103-118`）；SQLite 按选择器 BFS 下推、无 call 节点时对
  `workflows` **零查询** ⇒ 编辑器去抖校验延迟随全站工作流数线性增长。
- **P2-04** `/api/clarify` 历史筛选 PG 不下推 limit，全量 `SELECT *`（含
  `questionsJson`/`answersJson`/`draftAnswersJson`）再 `.slice()`。
- **P2-05** webhook 投递筛选项的仓库列表：SQLite 是 `WITH RECURSIVE` loose index scan（O(K·log N)，
  注释明写替代全表重扫，`sqliteWebhookDeliveryQueries.ts:67-81`），PG 是 `selectDistinct`（O(N)）。
  **PG 完全能跑同样的递归 CTE，不是方言限制。**
- **P2-06** node-run 事件分页：SQLite `min(limit ?? 500, 1000)`，PG `max(1, min(limit ?? 1000, 5000))`。
- **P2-07** 四条 human-gate 边的失败分类完全不同，含一处 **404 → 409**（任务不存在时）；
  且 PG 抛的都不是 `ConflictError` 实例 ⇒ 上游按 `instanceof ConflictError` 分流的分支会 rethrow 而非降级。
- **P2-08** ownerless human-gate 分支：SQLite 抛裸 `Error` ⇒ **500**；PG 抛 `TaskExecutionError` ⇒ 409。
- **P2-09** `skills.meta_revision` **只在 PG 侧推进**（四个写点全在 PG 文件；SQLite 侧全仓只读不写），
  而两侧共用的领域计划器 `domain/skillVersionCommit.ts:97-131` 的 `skillPatch` 类型里根本没有该字段
  ——该文件正是为终止「同一判据抄多份必漂」而设的单一事实源。
- **P2-10** 内建宿主工作流快照两侧布局处理不同 ⇒ 代理 / 工作组任务的详情画布在 PG 上退回无坐标网格。
- **P2-11** `GET /api/mcps` 行序：两侧都无 `ORDER BY`，PG 的 UPDATE 写新元组版本会把该行推到列表末尾
  （**高度可疑**，缺真实 PG 验证）。
- 其余：`workflow.deleted` 广播不带受众快照、call 子任务 `workflow_version` 记实时 vs 冻结、
  `skill-md-protected` 409 vs `skill-main-file-protected` 422、工作组 `save()` 错误码形状不同等。

## 5. 负结果（同样重要）

### 5.1 平台底座层零缺陷（13 对，全读）

committed events 的追加序号 / 幂等重放 / `reserveAggregateSequenceTx`、投递的 due 判据 / claim 排序 /
lease-epoch CAS / 退避公式 / dead-letter、投影选取与去重、事件响应规则的匹配五元组、逻辑导出的列投影
与分块、运行时注册表状态机——**逐条同构**。

抽验三处均通过：①PG 用 `ascNullsFirst(nextScanAt)`、SQLite 用裸 `asc`，因 SQLite 视 NULL 最小而**等价**；
②退避公式 `Math.min(30_000, 1_000 * 2 ** Math.max(0, attemptCount - 1))` 两侧逐字节相同；
③`createSqliteLogicalTarget`（371 行）确实零生产调用方（可删的死代码）。

### 5.2 已经守住的两层

- **schema 层单源派生（**但只覆盖表/列/约束/索引**）**：`db/providerSchema.ts` 把同一份 `schema.ts`
  声明机械投影成 pgTable；PG 基线 DDL 由 `scripts/rfc349-postgresql-schema.ts` 从同一契约
  `renderPostgresqlBaselineSql()` **生成**，不是手写。列集 / 默认值 / 约束无漂移空间。
  **更正（第二轮审计发现）**：投影**不含触发器**——`postgresqlSchema.ts:18-22` 的 statement kind
  只有 `bootstrap|table|constraint|index|metadata`，`schemaContract.ts` 全文 grep `TRIGGER` 为零。
  SQLite 侧现有 **9 个触发器，一个都没投影到 PG**。其中 8 条有应用层等价物，唯一没有的是
  `rfc328_node_runs_lineage_after_insert` ⇒ **PG 上每个 node_run 的 `lineage_slot_path_json`
  恒为 null**（`buildNodeRunMintRecord.ts:95-98` 默认 null，全仓无 override 调用点）。同 provider
  内部靠三处兜底自洽，但跨 provider 迁移时 `operationFamilyKey` 的哈希输入随之改变。
- **方言层逐条实测钉死**：三条 parity 守卫各自来自对真 PostgreSQL 的实测——NULL 排序两边默认相反、
  SQLite `LIKE` 对 ASCII 天生大小写不敏感而 PG 敏感（切库后**静默少召回**）、`0/1` 混进布尔表达式在 PG
  上是 `SQLSTATE 42804`。

**方言陷阱是闭集**，可以枚举、可以逐条钉死，仓里也确实钉死了。清单**尚未穷尽但方法有效**——本轮
之后又添两条：P1-28（`LIKE` 的默认转义符 `\`，本审计发现）与「裸 SQL 行不过 drizzle mapper，
普通 int8 列交回字符串」（RFC-357 的**真 PostgreSQL lane** 抓到，`dfbfb3a91`；静态守卫漏了它，
因为守卫只查投影层而游标在 `page.ts` 另读一次裸行）。后者是本审计 §5 论点的直接实证：
**真库 lane 一接上就开始产出静态守卫拿不到的 finding**。两条都已补进 `docs/dev-gotchas.md`。**手写重实现的业务语义是开集**，没有任何判据能枚举它——本轮 55 条全部落在这一层。

### 5.3 「收成一份」这条路走得通

RFC-352 的 memory `canManage` 漂移修法是对的：判据现在统一在 `memory/domain/scopeAuthorization.ts`
一份，两侧只取事实；分页是两侧同一份 keyset，PG 没有全表捞回内存过滤。同类正例还有
`taskExecutionKind`（shared 唯一判据）、`domain/skillVersionCommit.ts`、
`taskListPage/`（RFC-357 正在落的 dialect 参数化页查询）。

## 5.4 第二轮：163 个无配对 PG 面文件（2026-09-04，6 片全覆盖，新增 6 条 P0）

判据换成**装配缺口**（无孪生可 diff）：东西建了没绑、SQLite 装了 PG 没装、有实现零调用方。

**新增 3 条 P0（累计 10 条）**：

- **P0-8 评审决定 / 反问下发 / 快速澄清三条命令端口从未注入**（`cli/postgresqlDaemonApplication.ts:706-710`），
  且 **PG 侧根本不存在这三个实现**（只有 `legacySqliteReviewDecisionComposition` 等）。
  ⇒ `commandContext.ts:161-186` 必抛，**PostgreSQL 上评审无法通过 / 驳回、澄清无法回答，前端拿 500**，
  任务永久卡在人工门。SQLite 侧对应装配在 `cli/start.ts:1842-1852`。
- **P0-9 development mission 的 `agentLauncher` / `scriptLauncher` 从未注入**
  （`cli/postgresqlDaemonApplication.ts:1385-1399`，两者是可选依赖、缺失即静默 undefined）
  ⇒ agent / script 动作恒 `blocked`（`agentActionOrchestrator.ts:274-279`）。
  **影响面已收窄**：新遗留 Mission 两侧都已不可创建，受害的是切换到 PG 时仍在途（draining）的那批。
- **P0-10 驱动释放不清算 effect ⇒ owner 永久卡 `claimed`**
  （`postgresqlTaskDriverLifecycle.ts:106-157` 缺 SQLite 在同位置做的三件事：`child-unkillable` 判定、
  `resolveQuiescedManagedProcesses`、未结清 effect 的 outcome-unknown 兜底）⇒ `releaseAfterStop`
  一进来撞 `unresolvedEffects` 必抛。该次驱动**静默失败**（`taskDriveCoordinator.ts:169` 的
  `void completion.catch()` 吞掉），此后每一次 resume / retry 都被拒，**重启也救不回来**
  （能释放它的 boot recovery 正是那段死码）。触发源最常见的一条：运行时子进程扛过 SIGTERM→SIGKILL。
  根因是**中立端口 `taskExecutionEffectStore.ts:125-150` 压根没声明这两个成员**，PG 侧无从调用。

**新增 P1（节选）**：

- PG boot 完全没有孤儿收割与所有权恢复（`cli/start.ts:2007-2037` 四步全部不可达）。
- PG 从不装配 skill catalog boot 参与者（1,150 行 PG 实现零调用）⇒ 崩溃留下的 `skill_operation_locks`
  主键行永不清理 ⇒ **该技能之后每次编辑 / 发版 / 删除都主键冲突失败且永不自愈**。
- `webhookTaskWorkspaceAutoCleanup` 在 PG 上**完全无效**（策略从未注册，注册表是模块级单例，
  PG 的生命周期写手读同一个它 ⇒ 恒 `{prune:false}`）——设置页显示「已开启」，行为是关。
- PG 从不播种数字员工内置代理模板 ⇒ 内置工具目录整份缺席，职位模板编辑器无内置代理可绑。
- **任务删除认领无任何恢复方**（archive / workspace-gc 都有 owner，只有 delete 没有），
  且残留认领**不需要崩溃**——正常并发下的 `ConflictError` 分支就会把认领留在 `io-complete`
  ⇒ 该任务**永远删不掉**（每次同一个 409），连带归档与工作区回收一起卡死，只能手工改库。
  SQLite 侧 `recoverInterruptedTaskDeletes` 的形参类型是 `LegacySqliteTaskDatabase`，
  **即使修好启动序列也接不上 PG**，是彻底没有 PG 实现。
- PG 的「定时备份」实际产出 `manual` 备份且强制 `includeWorktrees: true`（绑定时把调度器递来的
  `kind` 丢掉）⇒ 三个保留旋钮对 PG 定时备份**完全失效**、与用户手动备份抢 protected 名额、
  每拍都把所有非终态工作树打进 tarball。专门写的 `createPostgresqlScheduledBackupRequester` 零调用方。
- PG 的取消路径绕开唯一生命周期写点 ⇒ 运行时钟不结算（耗时显示错）、终态工作区回收不认领。
- PG 的「重试准备仓库」退化成**阻塞式单次克隆**：无 RFC-287 的退避重试窗口、无进行中的
  `__repo_prep__` 行、不可取消、且阻塞整个 HTTP 请求。

### resource-catalog 片（17 个 PG 独有文件，最后回来、收获最大）

**新增 2 条 P0（累计 12 条）**：

- **P0-11 技能启动屏障从不装配**（`composePostgresqlSkillCatalogBoot` 零生产调用方，
  `postgresqlSkillCatalogBoot.ts` 1,418 行是生产死代码）。两条独立损害：
  ①崩在保存中途 ⇒ `skill_operation_locks` 主键行永不清理（PG 上唯一会清遗留锁的代码就在那个
  从不运行的屏障里）⇒ **该技能永久保存不了**，每次都 `skill-operation-busy`；崩在创建阶段 ⇒ 行以
  `reservationState:'reserving'` 留库，列表看不见（只取 `ready`）却占着 `skills_owner_name_unique`
  ⇒ **重建同名永远 `skill-name-in-use`，死结**。SQLite 上重启一次即由 `recoveryDirection` 回滚/前滚。
  ②`bootReverifyActivated` 恒 false ⇒ `isSkillAvailableThisBoot` 无条件 true ⇒ 磁盘快照损坏的技能
  照常出现在 `/skills` 并被注入任务；`postgresqlTaskExecutionResourceSnapshots.ts:394` 的
  `SkillQuarantinedError` fail-closed 分支在 PG 生产上**不可达**。
- **P0-12 工作组反问在 PostgreSQL 上等于不存在**：`workgroupTurnsDriver.ts:432-439` 的
  `protocolBlock` 是 4 行 stub，不接 `clarifyAllowed`、从不拼 `<workflow-clarify>` 格式块；
  `:551-562` 又把 `clarifyEnabled` 简化成 `hasHumanMember && budget>0`（不查 per-asker 已问次数、
  不查 `stop` 指令）。host run 走 `delegated` 通道时 `prompt.ts:773` 让 `workgroupProtocolBlock`
  **替换**整个尾部协议块 ⇒ 格式块只能来自这个 stub ⇒ **agent 全程不知道可以向人提问，永不发起反问**：
  任务不进 `awaiting_human`、房间无问题卡、反问收件箱恒空，`clarifyBudget` 与「停止反问」成为空设置。

**新增 P1（节选，均确证）**：

- **PG 工作组回合引擎不发任何 `wg.*` WS 帧**（依赖接口根本没有 broadcast 字段）⇒ leader 派卡、成员
  `wg_result` 与聊天消息不推送，要等下一次 `node.status` 帧被动失效（落后整整一轮）或 15s 轮询。
- **意图 apply 与配置包 apply 都不广播 `workflow.created` / `workgroup.created`**（两处 `committed` /
  `afterCommitted` 回调在唯一装配点都没传）——而同一 PG 部署里普通 `/workflows` 路由**是**广播的，
  同库两条路径行为不一致。
- **PG 把 `call-workflow` 悬空目标当硬错误**（SQLite 的 name 域明确「dangling until launch」）
  ⇒ 分两轮增量搭嵌套工作流在 PG 上第一次 apply 就 400。
- **PG 工作流更新对全量引用做可见性校验，丢了「只查新增」的 grandfathering** ⇒ 图里某个早已存在的
  agent 被它 owner 改成 private，用户改这个工作流的**无关部分**也 400，且他既没碰也修不了。
- **PG 工作流更新缺 `rehydratePrivilegedNodes`** ⇒ 没有 `scripts:author` 的普通用户，在 intent 里
  编辑含 script 节点的工作流的**任何**部分（挪个节点都算）必定 403——intent dump 必然把这些字段
  打成 `‹redacted›`、模型原样回抄。SQLite 的「允许」半边有测试逐条锁死，而那个测试只跑 SQLite。
- **PG 技能保存缺「空写短路」** ⇒ 编辑器 autosave 让版本历史凭空多出 v2/v3/v4…（diff 全空），
  且 `contentVersion` 推进使 precondition token 失效 ⇒ 另一个标签页什么都没改却吃 409。
- **`isPostgresqlUniqueViolation` 在真 PG 上恒返回 false**：Bun.SQL 把 SQLSTATE 放在 `errno`、
  `code` 恒为 `ERR_POSTGRES_SERVER_ERROR`。**本仓自己在 `postgresqlSerializationRetry.ts:34-46`
  已按 `errno` 修好 `40001`，这一处漏改** ⇒ 并发同名新建/重命名拿 **500** 而非 409。
  （这是「同一类陷阱修过一次仍漏一处」的样本，见 §5.2 的开集论点。）
- 经典六类 ACL 写不触发 WS revalidation、`workflow.deleted` 广播不带 audience 快照、
  移除最后一个 human 成员时丢被取消反问的 `node.status` 帧——三条都是「回调建了没接上」。

**severity 分歧一处（如实记录）**：该片把「PG 删除工作流 / 代理缺引用守卫」评为 P0，本文件
沿用第一轮的 **P1**（需用户主动执行删除才触发）。两种评法都合理，处置优先级以 RFC-359 W1 为准。

**形状总结**：多数缺陷是同一句话——**PG 适配器写好了、接进 persistence 了，就是没人调**。
`cli/start.ts` 的 PG 分支只覆盖「装配 + 起服务」，把整段 boot 恢复 / 迁移屏障 / 播种
（`:1953–2256`）留在了 SQLite 独占路径上。

**处置**：全部并入 [RFC-359](./RFC-359-database-provider-unification/proposal.md) 的 W1。

## 6. 存疑保留（5 条，未计入确证）

| # | 内容 | 缺什么证据 |
| --- | --- | --- |
| Q1 | 干净恢复未把未消费 replay 授权退回 `requires-actor`（PG 缺 36 行） | 触发数据态未端到端复现 |
| Q2 | 评审派发在某复用状态下 PG 多铸一条 node_run | 构造不出常规路径到达该状态 |
| Q3 | `resume` 的「call 行已收尾」判据 PG 漏 `skipped` | `mark-skipped` 只允许 `pending → skipped`，构造不出「子任务存在且 call 行为 skipped」 |
| Q4 | `settleCodeHostNode` 报错身份不同（404 vs 409） | 缺「该错误是否原样呈到 HTTP 层」的追踪 |
| Q5 | `GET /api/mcps` 行序 | 无序堆输出规范上是 unspecified 而非 guaranteed different，缺真库验证 |

## 7. 未覆盖

- `TaskExecutionRuntimeParticipants` 的 **`workgroupTurns` 两侧是两套独立引擎**（SQLite
  `legacy/workgroup/engine.ts` 839 行 + helper ↔ PG `workgroupTurnsDriver.ts` 2,801 行 +
  `postgresqlWorkgroupTurnsOperations.ts` 561 行），本轮只做入口抽样，**未逐方法对拍**。
  这块分歧面比 task-execution 持久化 31 对加起来还大，**建议单独立一轮**。
- `legacy/workflow.validator.ts` ~2,700 行规则体、`legacy/workgroup/*` 多数文件、
  `McpRuntimeTestPersistence` 部分区段依据 token diff 而非逐行阅读。
- `postgresqlSkillContentLifecycle.ts:559-563` 把 `versionState` 硬编码成 `'snapshot-authoritative'`
  传给 `isSkillAvailableThisBoot`（SQLite 传真实行）——未能构造出可达分歧场景，未记为 finding，
  但值得后续盯。
- 除 P0-1 外，全部结论由源码推导，**未在真实 PostgreSQL 实例上运行验证**（本机无 postgres、
  Docker daemon 未运行）。

## 8. 方法与可复跑

- 分片：按 bounded context 切 7 片并行逐对对读，判据统一为「同一输入两侧答案不同 **且用户可见**，
  两侧各给 `file:line`」；安全 / TOCTOU / 并发竞态 / 结构评论 / 缺测试一律不收。
- 复核：全部 P0 与约 22 条 P1/P2 由主 session 独立复核源码；P0-1 另取得可执行证据（脚本化 PG runtime）。
- 度量脚本与覆盖率原始输出未入库（诊断性质），复跑方式见 §1 口径说明。
