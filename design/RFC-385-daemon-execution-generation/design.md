# RFC-385 设计：执行世代按进程划分

研究基线 HEAD `9382675a0`（行号以实施时源码为准）。路径相对 `packages/backend/src/`，`T/` = `packages/backend/tests/`。

## 1. 现状

| 用途 | SQLite | PostgreSQL（单机） | PostgreSQL（托管） |
| --- | --- | --- | --- |
| 执行模块给 owner 打的世代 | `DAEMON_GENERATION`（`modules/task-execution/composition.ts:183`） | 数据库世代号（`cli/daemonModules/adapters.ts` PostgreSQL 条目：`createProviderTaskExecutionModule({ daemonGeneration: runtime.generationId })`，以及条目的 `daemonGeneration`） | 同单机 |
| 启动恢复的锁证明世代 | `DAEMON_GENERATION`（`cli/start.ts` 的 `readDaemonStartupRecoveryAuthority(lock, DAEMON_GENERATION)`） | 数据库世代号（`cli/postgresqlDaemonApplication.ts:1728-1740`） | 启动租约的实例 id（`modules/task-execution/composition/crewstationExecution.ts:177-184`） |
| 数据库写围栏 | — | 数据库世代号（`platform/persistence/postgresqlDatabaseClient.ts` 的 `generationId`） | 同单机 |

启动恢复 `prepare` 只回收 `state = 'claimed'` 且世代不等于证明世代的 owner；`finalize` 只处理 `revoked` / `recovery-required` 且世代
不等于证明世代的 owner（`modules/task-execution/infrastructure/taskExecutionRecovery.ts:83-129`）。单机 PostgreSQL 两者相等，所以上一
进程的 owner 永远不会进入恢复。

## 2. 修复

1. **执行世代唯一来源**：执行世代一律取 `DAEMON_GENERATION`。PostgreSQL 的任务执行适配器条目、执行模块、融合与其他把
   `runtime.generationId` 当执行世代传递的位置（实施时逐一检索 `generationId` 的用途，按「执行归属 / 运行配置」与「数据库写围栏」
   分开）都改为它；数据库写围栏不变。
2. **单机锁证明**：`createDaemonLockProof` 的 `daemonGeneration` 改为 `DAEMON_GENERATION`；托管分支（`readDaemonStartupRecoveryAuthority`
   与启动租约）不变。
3. 若适配器条目的 `daemonGeneration` 因此两边相同，删除该条目（RFC-382 为它留的 provider 差异不再存在）。

不改恢复算法本身；复现若显示还有别的缺口（例如收割器对无主围栏的错误分类），在报告中列出，不在本 RFC 扩大处理。

## 3. 测试策略

1. **「旧接线」对照（双 provider harness，在真实 PostgreSQL 上确认）**：跑真实的启动恢复（prepare、孤儿收割、finalize），执行世代与锁证明
   世代相同（修复前的单机接线）：
   - 崩溃路径：上一进程留下的 `claimed` owner 与运行中的任务；断言修复前的结果（owner 未回收、任务状态、恢复步骤是否抛错）；
   - 正常关停路径：关停预算内未退出、被标为 `recovery-required` 的任务；断言修复前 `finalize` 跳过它。
   修复后的接线（按进程的执行世代）两条路径都通过：owner 被回收与释放，任务按既有语义成为可续跑的中断任务，恢复完成。
2. SQLite 与托管的既有恢复用例保持通过（`T/rfc359-w3-t4-boot-recovery.test.ts` 等）。
3. 结构锁：入口根与适配器不把数据库世代号作为执行世代传递（文本锁），单机锁证明使用 `DAEMON_GENERATION`。

## 4. 与 RFC-294 目标架构的对齐

执行归属属于 task-execution 的 domain / infrastructure；世代来源由 bootstrap 装配给出。本 RFC 删除一项 provider 差异
（适配器条目的 `daemonGeneration`），不新增跨模块耦合。无偏离项。
