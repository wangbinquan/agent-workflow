# RFC-397 设计：热路径写入的共享 owner 围栏

本文所有 `file:line` 以 `b430c7754` 为准，路径相对 `packages/backend/src/`（另注明者除外）。

## 1. 现状

### 1.1 owner 行与围栏

- `task_execution_owners` 每个任务一行，RFC-328 引入；`revision` 定义为「owner 行每次 fence/heartbeat/state mutation 单调
  推进」（`design/RFC-328-durable-task-execution-ownership-fence/design.md:339`），§8.1「线性化 SQL」给出
  `SET revision = revision + 1 … RETURNING revision`（同文件 `:588-604`）。
- 现行实现 `assertTaskOwnerTx`（`modules/task-execution/infrastructure/ownedTaskExecution.ts:67-96`）：按 task / owner /
  世代 / epoch / `state='claimed'` 条件 UPDATE，`revision + 1` 并改写 `updated_at`；0 行即 `task-execution-stale-owner`。
- 选择规则 `fenceTaskWrite`（同文件 `:118-133`）：显式上下文 > 环境上下文 > 无主围栏（`assertTaskOwnerlessTx`，只在 owner
  仍 `claimed` 时拒绝，不加锁）。
- 代码里给出的理由是**行锁**而不是计数：「行锁已把同一任务的写手串起来」（`ownedTaskExecution.ts:5-6`）；effect 持久化的
  注释也说旧 PG 实现是不加锁的 SELECT、两个写手可以同时穿过（`taskExecutionEffectPersistence.ts:26-27`）。

### 1.2 谁在推进 revision

| 写手                                                                         | 位置                                                                                                                                  | 事务                         | 频率                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| 运行时事件追加 `appendEvents`                                                | `nodeExecutionPersistence.ts:378-425`（围栏在 `fencedTaskId` `:65-88`）                                                               | READ COMMITTED               | **每个 stdout/stderr 冲刷批**（`application/taskAgentRun.ts:984-1018`） |
| 会话回捕事件追加 `appendEvents`                                              | `runtimeSessionCapturePersistence.ts:54-57`                                                                                           | READ COMMITTED               | 每次子会话 transcript 回捕                                              |
| node run `patch` / `upsertOutputs` / `replaceOutputs` / `retagSessionEpochs` | `nodeExecutionPersistence.ts:207, 268, 333, 427`                                                                                      | READ COMMITTED               | 每个 node run 数次                                                      |
| 任务 / node run 状态迁移、merge 状态、铸造、wrapper 进度等                   | `taskLifecycle.ts`、`nodeRunLifecyclePersistence.ts`、`mergeStateLifecyclePersistence.ts:38-48` 等                                    | READ COMMITTED（铸造带重放） | 每个 node run 数次                                                      |
| effect 准备 / 结算 / 进程登记                                                | `taskExecutionEffectPersistence.ts:344-345, 627, 898-899`                                                                             | SERIALIZABLE                 | 每个外部 effect                                                         |
| 运行时会话租约                                                               | `runtimeSessionLeaseOperations.ts:45-48`（用于 `:72, 129, 209, 239, 366, 403, 437`）                                                  | SERIALIZABLE                 | 每次租约操作                                                            |
| 心跳                                                                         | `taskOwnershipPersistence.ts:414-447`                                                                                                 | 自动提交                     | 每任务每 15 秒                                                          |
| claim / 撤权 / 释放 / 关停标记等所有权变更                                   | `taskOwnershipPersistence.ts`、`sourceTerminationTarget.ts`、`childTaskLifecycleParticipant.ts`、`taskExecutionShutdownOperations.ts` | 各异                         | 稀少                                                                    |

第一行是唯一按「agent 输出速率」发生的写手，其余都按 node run / effect / 租约 / 时间发生。

### 1.3 谁读 revision

1. `withOwnedTaskWrite`（`taskOwnershipPersistence.ts:202-234`）把 RETURNING 的 revision 交给 `createOwnedTaskTx`，后者要求
   它大于 token 携带的 claim 时 revision（`domain/ownership.ts:244-248`）。本 RFC 不碰这条路径。
2. **正常释放路径的停止证明**：`taskDriverRelease.ts:90-100` 在运行时确认停止后读 owner 的 revision 生成证明，随后
   `resolveQuiescedManagedProcesses`（经 `effectQuiescence.ts:174-206` 的 `lockAndAssertOwnerTx`，`FOR UPDATE` 后比对 revision）、
   `closeOutcomeUnknownAndRelease`（`effectQuiescence.ts:720`，事务体 `:570`）或 `releaseAfterStop`（`taskOwnershipPersistence.ts:500-538`）
   都要求 revision 未变。今天证明之后任何围栏写入都会让它失效。
3. 其余 revision CAS（撤权 `taskOwnershipPersistence.ts:238-271`、取消撤权 `childTaskLifecycleParticipant.ts:811-838`、
   `markRecoveryRequired`、关停标记、终态维护、claim、恢复后释放）要么作用于仍 `claimed` 的 owner 且不依赖数据写入推进
   revision（写入在撤权前提交是合法的，撤权后由 `state='claimed'` 条件挡住），要么只在 owner 非 `claimed` 时可达。
4. API、shared schema、前端都不暴露 revision；`updated_at` 只在心跳的 RETURNING 里读到，RFC-328 定义为诊断字段
   （RFC-328 `design.md:342`）。

### 1.4 冲突机制（实测）

PostgreSQL 文档对 REPEATABLE READ / SERIALIZABLE 的规定是：并发事务**实际更新或删除**了该行（而不只是加锁）并提交后，后到
的更新才以 40001 回滚。用一次性 PostgreSQL 17 容器、不经仓库代码的探针（READ COMMITTED 热写入 vs SERIALIZABLE 围栏）实测：

| 场景                                                 | 热写入推进 revision（现状） | 热写入只 `FOR SHARE`（本 RFC）                   |
| ---------------------------------------------------- | --------------------------- | ------------------------------------------------ |
| SERIALIZABLE 先取快照，热写入提交，再执行围栏 UPDATE | 40001                       | 提交成功                                         |
| SERIALIZABLE 围栏等待在途热写入，热写入随后提交      | 40001                       | 提交成功                                         |
| 在途 `FOR SHARE` 持有者 vs 改 owner 行的接管 UPDATE  | —                           | 接管等待持有者提交；之后旧 token 的围栏命中 0 行 |

另：只去掉 `+ 1` 不够——围栏仍改写 `updated_at`，任何改写同一行的 UPDATE 都会造成 40001（同类先例
`packages/backend/tests/rfc349-postgresql-database-client.test.ts:258-263`）。热路径必须**完全不 UPDATE** owner 行。
锁模式也必须是 `FOR SHARE`：`FOR KEY SHARE` 不会挡住只改非键列的 UPDATE（`packages/backend/tests/rfc359-engine-capabilities.test.ts:454`），
撤权 / 释放就能在在途写入提交前落下。

## 2. 设计

### 2.1 新原语：共享围栏

`ownedTaskExecution.ts` 新增，与 `assertTaskOwnerTx` / `fenceTaskWrite` 并列：

```ts
/** 共享围栏：token 命中 `claimed` 的精确 owner 才放行；持有 owner 行共享锁到事务结束，不改写该行。 */
export async function holdTaskOwnerTx(
  tx: TaskExecutionTransaction,
  token: OwnershipToken,
): Promise<void>

/** 与 fenceTaskWrite 同一选择规则；有上下文时用共享围栏，无上下文时仍是无主围栏。 */
export async function holdTaskWrite(
  tx: TaskExecutionTransaction,
  input: { readonly taskId: string; readonly context?: TaskExecutionContextRef | undefined },
): Promise<void>
```

- 条件与 `assertTaskOwnerTx` 逐项相同（task / owner / 世代 / epoch / `state='claimed'`），形如
  `SELECT 1 FROM task_execution_owners WHERE … ${engineOf(tx).stableReadLockClause()} LIMIT 1`；
  能力矩阵已有的 `stableReadLockClause` 在 PostgreSQL 渲染 `for share`、在 SQLite 为空（`platform/persistence/capabilities.ts:142-143, 359, 476`）。
- 0 行时抛与 `assertTaskOwnerTx` 同码同形的 `TaskExecutionError('task-execution-stale-owner', …)`，调用方的错误处理不变。
- 不改写 owner 行：`revision` 与 `updated_at` 都不动。
- 无上下文分支直接复用 `assertTaskOwnerlessTx`，语义一字不变。

### 2.2 选用范围：只给只追加的遥测写入

| 写手                                                                              | 改后                                                                                                |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `DrizzleNodeExecutionPersistence.appendEvents`                                    | `holdTaskWrite`：`fencedTaskId` 增加围栏方式参数，`appendEvents` 传共享方式，其余四个写手保持推进式 |
| `runtimeSessionCapturePersistence.appendEvents`                                   | `holdTaskWrite`                                                                                     |
| 其余所有调用 `fenceTaskWrite` / `assertTaskOwnerTx` / `withOwnedTaskWrite` 的写手 | 不变                                                                                                |

只选这两处的理由：

- 它们按 agent 输出速率发生，是 §1.2 里唯一的高频写手；
- 它们只追加事件行，不改任务、node run、产出或 effect 的状态，不参与任何依赖 revision 的不变量（§1.3 的 1、3）；
- 会改状态的写手继续推进 revision，停止证明对它们的漂移检测原样保留（§2.4）。

锁序不变：owner 行（改为共享锁）→ 任务根（`FOR UPDATE`）→ node run 行（`FOR UPDATE`），与 RFC-395 规定的
`TASK_AGGREGATE_LOCK_ORDER`（`modules/task-execution/application/ports/taskAggregateWrite.ts:5-15`）一致。同一任务的追加之间、
追加与其它写手之间仍由任务根的 `FOR UPDATE` 串行；任务根上的 `FOR UPDATE` 只加锁不产生新行版本，不会让 SERIALIZABLE
写手得到 40001。

### 2.3 语义对照

| 保证                                                                         | 现状                         | 改后（两处追加）                       |
| ---------------------------------------------------------------------------- | ---------------------------- | -------------------------------------- |
| 过期 token（owner / 世代 / epoch / 状态不符）被拒，错误码                    | `task-execution-stale-owner` | 相同                                   |
| 无上下文、owner 仍 `claimed` 时拒绝；无 owner 行或已释放时放行               | 是                           | 相同                                   |
| 改 owner 行的写手（接管、撤权、释放、心跳、SERIALIZABLE 围栏）等在途追加提交 | 是（行排他锁）               | 是（`FOR SHARE` 挡 UPDATE，§1.4 实测） |
| 同一任务的写入串行                                                           | 是（owner 行 + 任务根）      | 是（任务根）                           |
| 追加推进 revision                                                            | 是                           | **否**                                 |
| 同任务的 SERIALIZABLE 写入因追加得到 40001                                   | 是                           | **否**（§1.4 实测）                    |

### 2.4 唯一的语义放宽：停止证明不再被事件追加作废

`transferOwnerRow`（`taskDriverRelease.ts:80-150`）只在运行时停止已被核实（`stopResult.kind === 'released'`）后才读 revision
生成证明。改后，在「读 revision」与「释放」之间提交的**事件追加**不再让证明失效，释放照常完成；释放之后的追加因 owner
不再 `claimed` 被拒。会改状态的写入（`patch`、产出、状态迁移、merge 状态等）仍推进 revision，在这段窗口里落下仍会让证明
失效，与今天相同。

取舍理由：事件是运行时输出的只追加记录，证明要保证的是 owner 与 effect 集合在释放时未漂移，追加不改变两者；而运行时
已核实停止，这段窗口里出现的追加只可能是停止前已排队的最后一批输出，让它作废证明只会把正常的释放推向恢复路径。
**这一条需要用户确认。**

### 2.5 SQLite

`stableReadLockClause` 为空，`BEGIN IMMEDIATE` 本已全库独占，共享围栏退化为同一条件的读校验；与今天相比唯一差别是追加
不再推进 revision。两种 provider 跑同一套用例（RFC-294 G7）。

## 3. 测试策略

新增 `packages/backend/tests/rfc397-hot-path-owner-share-fence.test.ts`，文件头写明来由（CI run 41052627131、§1.4 机制），
两种 provider 都跑的部分用 `describeEachProvider`：

1. `holdTaskOwnerTx`：精确 token 放行；owner / 世代 / epoch / 状态四种不符各自被拒且错误码相同；`revision` 与 `updated_at`
   都不变。
2. `holdTaskWrite` 的选择规则与 `fenceTaskWrite` 一致：显式上下文、环境上下文、无上下文（claimed 拒绝；released 与无 owner
   行放行）。
3. 两处 `appendEvents` 之后 revision 不变、事件落库；同一文件里另外四个写手之后 revision 仍 +1。

只在 PostgreSQL 上跑的部分：

4. **回归（确定性）**：SERIALIZABLE 事务先取快照，同任务的 `appendEvents` 在另一连接提交，再在该事务里执行
   `assertTaskOwnerTx` 并提交——改后成功。变异检查：把 `appendEvents` 换回推进式围栏，该用例以 40001 失败。
5. 接管等待：在一个事务里调用 `holdTaskWrite` 后挂起，另一连接对 owner 行做撤权 UPDATE，断言它在挂起期间未完成；提交后
   撤权完成，旧 token 的下一次 `appendEvents` 得到 `task-execution-stale-owner`。

既有用例与账本：

- `rfc349-task-aggregate-transaction.test.ts:189-213` 的源码锁扩展到共享方式：`fencedTaskId` 两种方式都必须先围栏再锁根，
  `withTaskExecutionWrite(this.db` 计数不变。
- `packages/backend/tests/fixtures/rfc395-serialized-insert-source-locks.json` 中 `nodeExecutionPersistence.ts` 与依赖
  `ownedTaskExecution.ts` 的 sha256 按其 policy 重新审阅后更新；`replaceOutputs` 的串行理由（owner 围栏 → 任务根 → node-run
  锁）不受影响，原文保留。
- 钉住 revision 推进的既有用例（`rfc359-w8-node-run-lifecycle-neutral-transaction`、`rfc359-w4-b1-batch2c/2d-adapters`、
  `rfc395-task-aggregate-races`、`rfc359-w8-effect-persistence-conformance`）断言的都不是这两处追加，预期不变；实现后集中跑一遍确认。

压测证据（本机一次性 PostgreSQL 容器，8 路并行 × 8 次只跑扇出写分片用例）：现状 4/64 失败、服务端 2316 次 40001；改后
目标 0/64，并记录 40001 次数。数字写回本节。

## 4. 与 RFC-294 目标架构的对齐

- **落位**：`task-execution` 限界上下文的 infrastructure 层（`ownedTaskExecution.ts`、`nodeExecutionPersistence.ts`、
  `runtimeSessionCapturePersistence.ts`）；行锁表达复用 `platform/persistence` 能力矩阵已有的 `stableReadLockClause`，platform
  不新增 API、不依赖任何模块。
- **演进**：G4 要求 lease / outbox / projection 这类机械写入走 owner 定义的窄 claim / fence。事件追加正是这类写入，本 RFC
  让它从「所有权变更级」的推进式围栏退回窄的共享围栏。
- **G7**：两种 provider 同一算法，差异只在能力矩阵渲染。
- **偏离项**：无。不新增 facade、不新增跨模块 import。

## 5. 风险

1. **MultiXact**：同一 owner 行同时有两个以上共享锁持有者时，PostgreSQL 会生成 MultiXact。同一任务的追加在任务根上串行，
   重叠只发生在「一个持锁、一个刚拿到共享锁正等根锁」的瞬间；外键检查一直在这样使用共享锁，按默认配置可接受。
2. **§2.4 的语义放宽**：见上，需用户确认。
3. **锁序**：本 RFC 不改锁序。调研中注意到源终止先锁任务根再撤 owner（`taskDefinitionWriteParticipant.ts:166`、
   `sourceTerminationTarget.ts:154`），与规定锁序相反；它与推进式围栏、共享围栏的冲突形态相同，本 RFC 不变好也不变坏，
   记入 §6。
4. **其余写手仍会让 SERIALIZABLE 冲突**：按 node run / effect / 租约频率发生，由现有 10 次重试吸收；压测数字验证这一判断。

## 6. 调研中另见、不在本 RFC 内

- 本机压测另见两种低频失败：一次任务 `failed` 而无 WARN；一次任务 `done` 后在 `effectQuiescence.ts:298` 抛
  `recovered generation regressed below retained watermark`。需另行归因。
- 关停标记 `taskExecutionShutdownOperations.ts:89-121` 不检查 UPDATE 结果，并发写入可让它静默失手。
- 源终止的反向锁序（§5.3）。
- 失败日志只含 Drizzle 的「Failed query」、不含 SQLSTATE：`describeEffectError`（`modules/task-execution/domain/effectErrorDescription.ts`）
  只取最外层 message。domain 层不应认识数据库错误形状，改法另议。
