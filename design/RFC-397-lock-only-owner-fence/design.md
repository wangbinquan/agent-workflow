# RFC-397 设计：数据写围栏只加锁

本文所有 `file:line` 以 `2cb6f20e6` 为准（与 `b430c7754` 只差文档），路径相对 `packages/backend/src/`（另注明者除外）。

## 1. 现状

### 1.1 owner 行与围栏

- `task_execution_owners` 每个任务一行（RFC-328）。RFC-328 把 `revision` 定义为「owner 行每次 fence/heartbeat/state mutation 单调
  推进」，§8.1 给出 `SET revision = revision + 1 … RETURNING revision`（`design/RFC-328-durable-task-execution-ownership-fence/design.md:339, 588-604`）。
- 通用数据写围栏 `assertTaskOwnerTx`（`modules/task-execution/infrastructure/ownedTaskExecution.ts:67-96`）：按 task / owner / 世代 /
  epoch / `state='claimed'` 条件 UPDATE，`revision + 1` 并改写 `updated_at`；0 行即 `task-execution-stale-owner`。不比较 token 的
  revision 与 lease，所以心跳之后旧 token 仍可写（RFC-359 T7 P0-2，`packages/backend/tests/rfc359-t7-owner-fences.test.ts:242`）。
- 选择规则 `fenceTaskWrite`（同文件 `:118-133`）：显式上下文 > 环境上下文 > 无主围栏（`assertTaskOwnerlessTx` `:99-116`，不加锁，
  只在 owner 为 `claimed` 时拒绝，`revoked`、`recovery-required`、`released` 与无 owner 行都放行）。
- 代码给出的理由是**行锁**：「行锁已把同一任务的写手串起来」（`ownedTaskExecution.ts:5-6`）；effect 持久化的注释说明旧 PG 实现是
  不加锁的 SELECT，两个写手可以同时穿过（`taskExecutionEffectPersistence.ts:26-27`）。

### 1.2 改写 owner 行的全部位置

源码中 `.update(taskExecutionOwners)` 共 11 处，**只有一处是数据写围栏**：

| 位置                                     | 作用                                                              | 类别           |
| ---------------------------------------- | ----------------------------------------------------------------- | -------------- |
| `ownedTaskExecution.ts:75`               | `assertTaskOwnerTx`，经 `fenceTaskWrite` 或直接被全部数据写手调用 | **数据写围栏** |
| `taskOwnershipPersistence.ts:212`        | `withOwnedTaskWrite`，任务状态迁移（`setTaskStatus`）             | 任务状态迁移   |
| `taskOwnershipPersistence.ts:156`        | 恢复后释放                                                        | 所有权变更     |
| `taskOwnershipPersistence.ts:255`        | 精确撤权 `revokeExactOwnerInTx`                                   | 所有权变更     |
| `taskOwnershipPersistence.ts:366`        | 已有行的重新 claim                                                | 所有权变更     |
| `taskOwnershipPersistence.ts:419`        | 心跳（推进 revision 与 lease）                                    | 所有权变更     |
| `taskOwnershipPersistence.ts:474`        | 标记需恢复                                                        | 所有权变更     |
| `taskOwnershipPersistence.ts:519`        | 停止后释放                                                        | 所有权变更     |
| `childTaskLifecycleParticipant.ts:817`   | 取消撤权                                                          | 所有权变更     |
| `effectQuiescence.ts:690`                | outcome-unknown 释放                                              | 所有权变更     |
| `taskExecutionShutdownOperations.ts:105` | 关停标记                                                          | 所有权变更     |

数据写手的事务类型：READ COMMITTED（`withTaskExecutionWrite`，不重试）、READ COMMITTED + 重放（`withTaskExecutionAggregateWrite`，
如 node run 铸造），以及 SERIALIZABLE（`withTaskExecutionSerializable`，10 次重试）——effect 准备 / 结算 / 进程登记
（`taskExecutionEffectPersistence.ts:344-345, 627, 898-899`）、运行时会话租约（`runtimeSessionLeaseOperations.ts:45-48`）、托管进程
登记（`modules/task-execution/infrastructure/crewstation/processEffectProjection.ts:41-44`）、工作组主持账本
（`workgroupHostLedgerParticipant.ts:226-232`）。

### 1.3 谁读 revision

1. `withOwnedTaskWrite` 把 RETURNING 的 revision 交给 `createOwnedTaskTx`，后者要求它大于 token 当前携带的 revision
   （`domain/ownership.ts:244-248`；token 的 revision 可能已被心跳刷新）。本 RFC 不改这条路径。
2. 带预期 revision 的 CAS：
   - **停止证明**：`taskDriverRelease.ts:90-100` 在运行时确认停止后读 owner 的 revision 生成证明；随后
     `resolveQuiescedManagedProcesses`（`effectQuiescence.ts:174-206` 的 `lockAndAssertOwnerTx`，owner 行 `FOR UPDATE` 后比对）、
     `closeOutcomeUnknownAndRelease`（`effectQuiescence.ts:720`，事务体 `:570`）或 `releaseAfterStop`（`taskOwnershipPersistence.ts:500-538`）
     都要求 revision 未变。
   - **撤权**：`revokeExactOwnerInTx`（`taskOwnershipPersistence.ts:238-271`），调用方为源终止（`sourceTerminationTarget.ts:130-140`，
     SERIALIZABLE）与旧 daemon 撤权（`taskExecutionRecovery.ts:89-105`）；取消撤权（`childTaskLifecycleParticipant.ts:811-838`，失配即
     `task-cancel-raced`，最多重试 8 次 `:748-766`）。
   - **标记需恢复**（`taskOwnershipPersistence.ts:472-492`，由 `taskDriverRelease.ts:142-148` 调用）、**关停标记**
     （`taskExecutionShutdownOperations.ts:89-121`，不检查 UPDATE 结果）。
   - 只在 owner 非 `claimed` 时可达的 CAS（恢复后释放、claim、后继 daemon 的静默、终态维护快照
     `terminalMaintenancePersistence.ts:199-213, 305-313`）：其间不可能有数据写入，不受影响。
3. API、shared schema、前端都不暴露 revision；`updated_at` 只是诊断字段（RFC-328 `design.md:342`），心跳的 RETURNING 只取
   `revision` 与 `leaseUntil`。

### 1.4 冲突机制

PostgreSQL 对 REPEATABLE READ / SERIALIZABLE 的规定是：并发事务**实际更新或删除**了该行（而不只是加锁）并提交后，后到的更新或加锁
才以 40001 回滚。独立探针（一次性 PostgreSQL 17，不经仓库代码）：

| 场景                                            | 热写入改写 owner 行 | 热写入只对 owner 行加锁                      |
| ----------------------------------------------- | ------------------- | -------------------------------------------- |
| SERIALIZABLE 先取快照，热写入提交，再执行围栏   | 40001               | 提交成功                                     |
| SERIALIZABLE 围栏等待在途热写入，热写入随后提交 | 40001               | 提交成功                                     |
| 改写 owner 行的接管 vs 在途加锁者               | —                   | 接管等待其提交；之后旧 token 的围栏命中 0 行 |

用例 B 的语句日志归因、失败点与两项实验见 proposal §1.2–§1.3。

## 2. 设计

### 2.1 `assertTaskOwnerTx` 改为只加锁

```ts
/** owner 围栏：token 命中 `claimed` 的精确 owner（id + 世代 + epoch）才放行；持 owner 行排他锁到事务结束，不改写该行。 */
export async function assertTaskOwnerTx(
  tx: TaskExecutionTransaction,
  token: OwnershipToken,
  _now: number,
): Promise<void> {
  assertOwnershipToken(token)
  const { taskExecutionOwners } = tablesOf(tx)
  await engineOf(tx).lockAggregateRoot(
    tx,
    taskExecutionOwners,
    taskExecutionOwners.taskId,
    token.taskId,
  )
  const rows = await tx
    .select({ taskId: taskExecutionOwners.taskId })
    .from(taskExecutionOwners)
    .where(and(/* 与今天相同的五项条件 */))
    .limit(1)
  if (rows[0] === undefined) {
    throw new TaskExecutionError(
      'task-execution-stale-owner',
      `task '${token.taskId}' mutation was fenced`,
    )
  }
}
```

- `lockAggregateRoot` 是能力矩阵已有的聚合根行锁：PostgreSQL 渲染 `select 1 from … where task_id = $1 for update`，SQLite 为 no-op
  （`platform/persistence/capabilities.ts:119-124, 352, 469-471`）。锁住之后再按五项条件读：READ COMMITTED 下第二条语句看到的是加锁
  之后的最新提交版本，且锁持有期间没人能改它；SERIALIZABLE 下若该行在快照之后被改写，加锁那一步就会 40001，否则读到的就是当前版本。
- 错误码、错误信息、调用签名都不变；所有调用方（`fenceTaskWrite` 及直接调用的 effect / 租约 / 进程登记 / 工作组账本）无需改动。
- `now` 不再写入。形参保留并改名 `_now`，避免同时改动 30 余处调用点与钉住调用文本的源码锁、变异夹具（`rfc359-t7-owner-fences.test.ts`、
  `fixtures/rfc359-p0-mutations.ts` 的 P0-2 锚点）；去掉它留作后续清理。
- 多一次往返（加锁 + 条件读，原先一条 UPDATE … RETURNING）。

### 2.2 不变的部分

- 所有权变更与任务状态迁移（§1.2 其余 10 处）照旧 UPDATE owner 行、推进 revision。
- `fenceTaskWrite` 的选择规则与无主围栏一字不变。
- 锁序不变：owner 行（排他锁，同今天）→ 任务根 → 下级行 → node run（`TASK_AGGREGATE_LOCK_ORDER`，
  `modules/task-execution/application/ports/taskAggregateWrite.ts:9`）。锁模式仍是排他，在同一事务里先持锁再 UPDATE 该行（例如数据
  写入之后同事务的任务状态迁移）没有升级问题，也不产生 MultiXact。

### 2.3 语义对照

| 保证                                                      | 现状                         | 改后               |
| --------------------------------------------------------- | ---------------------------- | ------------------ |
| 过期 token（owner / 世代 / epoch / 状态不符）被拒，错误码 | `task-execution-stale-owner` | 相同               |
| 心跳之后旧 token 仍可写                                   | 是                           | 是                 |
| 无上下文时只有 `claimed` 拒绝                             | 是                           | 是                 |
| 同一任务的数据写入在 owner 行上串行                       | 是（UPDATE 的行锁）          | 是（`FOR UPDATE`） |
| 改写 owner 行的路径等在途数据写入提交                     | 是                           | 是                 |
| 数据写入推进 revision、改写 `updated_at`                  | 是                           | **否**             |
| 同任务 SERIALIZABLE 写入因数据写入得到 40001              | 是                           | **否**             |
| 所有权变更、任务状态迁移推进 revision                     | 是                           | 是                 |

### 2.4 依赖 revision 的 CAS：变化与理由

改后 revision 只记录所有权变更与任务状态迁移。§1.3.2 的每个 CAS 都不再因「仍持有所有权的 owner 自己的数据写入」而失配：

| CAS                        | 今天因数据写入失配的后果           | 改后     | 理由                                                                                                                                                                               |
| -------------------------- | ---------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 停止证明 → 静默结算 / 释放 | 释放失败，转恢复路径               | 照常释放 | 证明在运行时确认停止后才生成；effect 集合在 closure 事务里另行复核（`effectQuiescence.ts:578-590`）；释放仍等在途写入提交，之后旧 token 被拒。任务状态迁移与所有权变更仍让证明失效 |
| 源终止 / 旧 daemon 撤权    | 失配，调用方重试或失败             | 照常撤权 | 撤权前提交的写入合法，撤权后由 `state` 条件挡住                                                                                                                                    |
| 取消撤权                   | `task-cancel-raced`，最多重试 8 次 | 少见失配 | 同上                                                                                                                                                                               |
| 标记需恢复                 | 失配                               | 照常标记 | 同上                                                                                                                                                                               |
| 关停标记                   | 静默失手（结果不检查）             | 照常标记 | 同上                                                                                                                                                                               |

两种 provider 一致（SQLite 上 revision 也不再因数据写入推进）。

### 2.5 SQLite

`lockAggregateRoot` 为 no-op，`BEGIN IMMEDIATE` 本已全库独占：只加锁的围栏退化为同一条件的读校验。与今天相比唯一差别是数据写入不再
推进 revision、不再改写 `updated_at`。

## 3. 测试策略

新增 `packages/backend/tests/rfc397-lock-only-owner-fence.test.ts`，文件头写明来由（CI run 41052627131、proposal §1.2 的归因、§1.4 机制）。

两种 provider（`describeEachProvider`）：

1. 精确 token 放行；owner / 世代 / epoch / 状态四种不符各自被拒且错误码相同；`revision`、`updated_at` 都不变。
2. 选择规则：显式上下文与环境上下文同时存在时以显式为准；无上下文时 `claimed` 拒绝，`revoked`、`recovery-required`、`released` 与无
   owner 行放行。
3. 代表性数据写手（node run `patch` 与 `appendEvents`、会话回捕追加、effect 准备与结算、会话租约）之后 revision 不变；心跳、撤权、
   `withOwnedTaskWrite` 之后 revision 照旧推进。
4. 停止证明：按 `transferOwnerRow` 的顺序形成证明，随后同任务的数据写入提交，`resolveQuiescedManagedProcesses` 与 `releaseAfterStop`
   成功；负对照——证明之后发生心跳或任务状态迁移，旧证明照旧被拒。

只在 PostgreSQL 上：

5. **首次尝试即成功（确定性回归）**：直接用底层客户端开 SERIALIZABLE 事务（不经 `serializable()` 的重试循环），先取快照，另一连接里
   同任务的数据写入（经真实适配器）提交，再在该事务里执行 `assertTaskOwnerTx` 并提交——成功。变异检查：围栏换回改写式，该用例以 40001
   失败。
6. **真实写手的锁持有**：参数化 `appendEvents`、`patch`、会话回捕追加——在外层事务帧里调用真实适配器（`databaseSessionFor(db).transaction`
   复用外层帧，围栏锁持有到外层提交）后挂起；另一连接的撤权 UPDATE 在挂起期间不完成，提交后完成；撤权后旧 token 的下一次写入得到
   `task-execution-stale-owner`。

既有用例与账本（按新语义逐条更新并在改动处注明 RFC-397）：

- 断言「围栏写入后 revision +1」：`rfc359-w8-node-run-lifecycle-neutral-transaction.test.ts`（`:163/182`、`:223/243`）、
  `rfc359-w4-b1-batch2c-adapters.test.ts`（`:146/151`、`:192/226`）、`rfc359-w4-b1-batch2d-adapters.test.ts`（`:269/298`）、
  `rfc395-task-aggregate-races.test.ts`（`:232/315`）、`rfc359-w8-effect-persistence-conformance.test.ts`（`:977/994/1009`）。
- 以「revision 未变」探测回滚的断言（`rfc359-w8-node-run-lifecycle-neutral-transaction.test.ts:185/202, 246/263`）改为探测被回滚的
  数据行本身，避免空过。
- SQL 形状断言：`rfc395-run-write-atomicity.test.ts:714-729`、`rfc369-workgroup-mint-receipt.test.ts:210` 改为寻找 owner 行的加锁语句，
  并保留「先 owner 后任务根」的顺序断言。
- 变异夹具 `fixtures/rfc359-p0-mutations.ts`：P0-1（`:393`）、P0-4（`:368`）锚点不受影响；P0-2（`:427` 起）以历史谓词替换
  `assertTaskOwnerTx`，实现后核对其锚点与负对照仍成立。
- 源码账本 `fixtures/rfc395-serialized-insert-source-locks.json`：以 `ownedTaskExecution.ts` 为依赖的条目按其 policy 重新审阅后更新
  sha256；若有条目的 `sites[].line` 因改动漂移，一并更新。
- 未列出的受影响用例在集中验证时逐个归因后处理。

压测证据（本机一次性 PostgreSQL 容器，8 路 × 8 次只跑用例 B）：基线 4/64、2316 次 40001；原型 0/64、0 次 40001。实现后重测，数字
写回本节。

## 4. 与 RFC-294 目标架构的对齐

- **落位**：`task-execution` 限界上下文 infrastructure 层的围栏原语 `ownedTaskExecution.ts`；复用 `platform/persistence` 能力矩阵已有
  的 `lockAggregateRoot`，platform 不新增 API。
- **演进**：G4 要求机械写入走 owner 定义的窄 fence；本 RFC 让数据写入的围栏只表达「owner 仍有效 + 串行」，不再兼任计数。
- **G7**：两种 provider 同一算法，差异只在能力矩阵渲染。
- **偏离项**：无。

## 5. 风险

1. **§2.4 的 CAS 语义放宽**：已逐项说明；证明与撤权仍对所有权变更、任务状态迁移敏感。
2. **revision 计数含义变化**：RFC-328 文档中「每次 fence 推进」的表述由本 RFC 修订；实现时在 RFC-328 design §8.1 旁加注指向本 RFC。
3. **多一次往返**：每笔数据写入多一条加锁语句；事件追加等热路径本来就有多条语句，影响有限。
4. **任务状态迁移仍改写 owner 行**：SERIALIZABLE 写入与它、与心跳（每 15 秒）仍可能冲突，由现有重试吸收；压测数字验证。

## 6. 第 1 轮设计门的处置

第 1 轮（只审功能，Codex，2026-10-30）结论 FAIL，六条意见的处置：

1. 归因未证实（major）：已用语句日志按事务归因（proposal §1.2），据此扩大范围；原型压测 0/64。
2. 既有用例与账本清单不全（major）：§3 已补全（SQL 形状断言、变异夹具、账本行号）。
3. 测试证明力不足（major）：§3 第 4–6 项（首次尝试即成功、真实写手的锁持有、停止证明正反对照、选择规则优先级）。
4. 行为变化描述不准（minor）：§2.3–§2.4 逐项列出 CAS 变化；心跳不使旧 token 失效、心跳 RETURNING 的列、`createOwnedTaskTx` 比较的是
   token 当前 revision，均已更正。
5. 版本起点错误（minor）：已更正，机制自 v0.19.2 即存在（proposal §1.1）。
6. 共享锁风险（minor）：改用排他的 `FOR UPDATE`，共享锁的升级死锁与 MultiXact 问题不再适用。

## 7. 调研中另见、不在本 RFC 内

- 本机压测另见两种低频失败：一次任务 `failed` 而无 WARN；一次任务 `done` 后在 `effectQuiescence.ts:298` 抛
  `recovered generation regressed below retained watermark`。需另行归因。
- 关停标记不检查 UPDATE 结果（`taskExecutionShutdownOperations.ts:89-121`）。
- 源终止先锁任务根再撤 owner（`taskDefinitionWriteParticipant.ts:166`、`sourceTerminationTarget.ts:154`），与规定锁序相反。
- 失败日志只含 Drizzle 的「Failed query」、不含 SQLSTATE：`describeEffectError`（`modules/task-execution/domain/effectErrorDescription.ts`）
  只取最外层 message；domain 层不应认识数据库错误形状，改法另议。
- `assertTaskOwnerTx` / `fenceTaskWrite` 的 `now` 参数已无用途，连同调用点与源码锁的清理另行处理。
