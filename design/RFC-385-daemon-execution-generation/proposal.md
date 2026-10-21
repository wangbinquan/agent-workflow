# RFC-385 执行世代按进程划分：单机 PostgreSQL 重启后的执行恢复

- **状态**：Done（2026-10-21：`f495e8e76`，主 CI `39545680585` success。「旧接线」对照在真实 PostgreSQL 上确认：崩溃后启动恢复在
  finalize 之前抛 `task-execution-stale-owner`（单机 PostgreSQL 无法启动）；关停超时的 `recovery-required` owner 被跳过、任务无法续跑。
  用户 2026-10-20「按你推荐继续推进」：由本会话设计、交 Codex 实施并审核，免设计门与实现门；规则取舍见 §6）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2b）；2026-10-21 RFC-385 研究中发现，
  先于其余 S2b 工作单独处理（RFC-382 §6 曾把它列为待查问题）
- **基线**：HEAD `9382675a0`（行号仅作定位提示，以实施时源码为准）
- **落位**：task-execution 的执行归属（ownership）与启动恢复；守护进程装配层只改世代号的来源

## 1. 背景

任务执行时，守护进程给执行 owner 行打上「执行世代」（`daemonGeneration`）；重启后的启动恢复用本次的锁证明世代与之比较，
**只回收世代不同的旧 owner**（`modules/task-execution/infrastructure/taskExecutionRecovery.ts:83-106` 的 `prepare`，
`:113-129` 的 `finalize`）。

- **SQLite** 用每进程一个的 `DAEMON_GENERATION`（`services/daemonGeneration.ts:22-23`），每次重启都不同，旧 owner 总能被回收。
- **单机 PostgreSQL** 用数据库世代号（`dbg_pg_<operation>`，只在迁移或恢复时变化，`databaseMigrationRunner.ts:116-118`）：执行模块
  （`cli/daemonModules/adapters.ts` 的 PostgreSQL 条目）与锁证明（`cli/postgresqlDaemonApplication.ts:1728-1740`，
  `createDaemonLockProof({ daemonGeneration: input.provider.runtime.generationId })`）用的是同一个值。**重启前后世代相同**，所以：
  - 崩溃后，上一进程仍为 `claimed` 的 owner 不会被回收；没有任何地方比较 `leaseUntil`，`claimPendingIntent` 拒绝非空 owner
    （`taskOwnershipPersistence.ts:336-346`、`domain/ownership.ts:374-377`），这些任务的续跑与重试从此被拒；
  - 正常关停时没能在关停预算内退出的任务，其 owner 被标为 `recovery-required`（`services/shutdown.ts:56-60`），同样被 `finalize` 跳过；
  - 研究推断：孤儿收割随后遇到无主围栏（`ownedTaskExecution.ts:83-97`），抛出的 `TaskExecutionError` 不是冲突错误，会穿过
    `trySetWithGuard`（`taskRuntimeLifecyclePersistence.ts:94-105`），可能让 fail-closed 的启动步骤失败，即守护进程起不来。
    **需复现测试确认**。
- **托管（CrewStation）不受影响**：锁证明用实例 id（`crewstationExecution.ts:177-184`），与 owner 世代永不相等，旧 owner 全部回收。
- PostgreSQL 的人工门与提交事件 worker 已经使用 `DAEMON_GENERATION`；`rfc359-w3-t4-boot-recovery.test.ts:255` 也假设世代按进程划分。

## 2. 目标

- **G1**：两个 provider 的执行世代都按进程划分（`DAEMON_GENERATION`）：执行模块给 owner 打的世代、单机锁证明的世代都用它。
- **G2**：数据库世代号只用于数据库写围栏（迁移切换），不再兼作执行世代；托管的锁证明不变。
- **G3**：单机 PostgreSQL 崩溃或正常重启后，旧 owner 被回收、任务回到可续跑状态，守护进程正常启动。

## 3. 非目标

- 租约过期（`leaseUntil`）的消费、多实例并发执行：不在本 RFC。
- 托管的启动租约与实例 id 证明：不变。
- 其余 S2b 工作（协调器工厂、续跑语义、运行时函数合一、SQLite HTTP 挂载表）：后继 RFC-386～389。
- 不改 API、事件、schema；不做任何安全相关改动。

## 4. 用户可见变化

单机 PostgreSQL：守护进程崩溃或正常重启后，原来运行中的任务被正常恢复（与 SQLite 相同：标为中断、可自动或手动续跑），
不再卡住，守护进程也不会因此启动失败（若复现确认存在）。SQLite 与托管无变化。

## 5. 验收标准

- **AC-1 对照**：写「旧接线」对照用例（执行世代与锁证明相同的单机接线，跑真实的启动恢复），在真实 PostgreSQL 上确认修复前的行为
  （崩溃与正常关停两条路径：旧 owner 是否被回收、恢复步骤是否抛错）；若与 §1 推断不同，按实际记录并调整修复范围。
- **AC-2 修复**：同一用例在修复后通过：旧 owner 被回收并释放，任务可续跑，启动成功；SQLite 与托管的既有恢复用例不变。
- **AC-3 世代来源唯一**：执行世代只有一个来源（结构锁：入口根与适配器不再把数据库世代号传作执行世代）。
- **AC-4 CI 全绿**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **按进程而不是按会话**：单机一个进程只有一个会话；只有将来出现「运行中切换 provider 并复制 claimed owner」时才需要按会话，届时再议。
2. **数据库世代号保留给写围栏**：它表示数据库的迁移代际，与执行归属是两件事。
3. **先对照、后修复**：同 RFC-382 / RFC-383 的「旧接线」对照用例做法。
