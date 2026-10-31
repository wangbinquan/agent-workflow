# RFC-397 实施计划

单提交交付（`fix(task-execution): RFC-397 …`）。按仓规先完成全部实现与用例，再集中验证。

## 任务

| 编号       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 依赖  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| RFC-397-T1 | 会话租约（design §3.1）：七个事务换 `withTaskExecutionAggregateWrite`；`preclaimResume` 谓词、`confirmResume` 锁下重读、`rotate` 精确删除、`markResetPending` 提前返回四处加固；`constraintViolation` 只映射租约主键；`nodeRunWriteProtocol.ts:340-341` 注释更新                                                                                                                                                                                                                                                        | —     |
| RFC-397-T2 | effect 账本（design §3.2）：`prepareAndAcquire`、结算一族、`recordProcessSpawn` 与 EQ 四个入口（`resolveQuiescedManagedProcesses`、`closeOutcomeUnknownAndRelease`、`closeRecoveredOutcomeUnknownAndRelease`、`resolveQuiescedCodeHostMutations`）换原语；EQ 在 owner 校验后补任务根锁；family advisory 锁按完整键去重排序、在首次 attempt / effect 修改与 fence 释放前取得（含 `retry-authorized` 分支）；`settleCodeHostNode` / `settleWorkspacePreparation` 补投影任务校验                                           | —     |
| RFC-397-T3 | 托管 `recordSpawnReceipt`（design §3.3）：换原语，attempt UPDATE 改为 `state` / `epoch` CAS，命中 0 行整笔回滚                                                                                                                                                                                                                                                                                                                                                                                                          | —     |
| RFC-397-T4 | 测试辅助：`tests/helpers/eachProvider.ts` 的 SQL 记录器增加派发时记录（含失败语句与 SQLSTATE、`BEGIN`），既有成功语句视图不变；新用例 `rfc397-owner-fenced-writes-read-committed.test.ts`（design §4 第 1、1a、2–7 项）：数据写入的 barrier 回归、EQ 加锁读取契约与触发器注入 40P01（首个与第二个 attempt UPDATE 两个注入点，一次性计数用事务外 sequence）、family 竞争（advisory / fence 阻塞点）、租约「去掉即失败」交错、托管零行 CAS 触发器（PostgreSQL `RETURN NULL`、SQLite `RAISE(IGNORE)`）、错误映射、隔离级别 | T1–T3 |
| RFC-397-T5 | 既有用例、架构守卫、变异夹具与账本按 design §4 清单更新并注明 RFC-397                                                                                                                                                                                                                                                                                                                                                                                                                                                   | T1–T3 |
| RFC-397-T6 | 文档：`docs/dev-gotchas.md`（热行 + SERIALIZABLE 的 40001 风暴；SERIALIZABLE 锁后不刷新快照；READ COMMITTED 写手不进 SSI；语句日志按事务归因的做法）；design §4 写回压测数字；`design/plan.md` 索引与 `STATE.md`                                                                                                                                                                                                                                                                                                        | T1–T3 |
| RFC-397-T7 | 集中验证：受影响后端用例两种 provider（本机一次性 PostgreSQL 容器）；8 路 × 8 次用例 B 压测与 40001 计数；变异检查（换回 SERIALIZABLE → §4.1 红）；Codex 实现门（只审功能）；主 CI 全绿                                                                                                                                                                                                                                                                                                                                 | T4–T6 |

v0.19.3 在 T7 完成后发布（用户 2026-10-30 决定），不属于本 RFC 的任务。

## 冲突面

- `runtimeSessionLeaseOperations.ts`、`taskExecutionEffectPersistence.ts`、`effectQuiescence.ts`、`crewstation/processEffectProjection.ts`、
  `nodeRunWriteProtocol.ts` 是 RFC-359 / 370 / 395 的高频文件；开工前查看工作树与 `origin/main` 有无并发改动，有则先合入再动手，按路径提交。
- 既有用例与守卫分布在多个 RFC 的测试文件中，只改与隔离级别、SQL 形状和过时说明直接相关的断言。
- 不改 `ownedTaskExecution.ts` 的围栏与 `postgresqlSerializationRetry.ts`。

## 验收清单

- [x] proposal §5.1：转换后的事务在 PostgreSQL 上为 READ COMMITTED，SQLite 为 `BEGIN IMMEDIATE`。
- [x] proposal §5.2：原故障确定性回归首次尝试完成；变异检查红。
- [x] proposal §5.3：两个交错的行为符合 design §3.1。
- [x] proposal §5.4：family 竞争无裸 `23505`、watermark 单调、无挂起。
- [x] proposal §5.5：租约四处加固各有负对照；错误映射收窄。
- [x] proposal §5.6：8×8 压测 0/64，40001 计数写入 design §4。
- [ ] proposal §5.7：既有用例、守卫、夹具与账本已更新并说明（已完成）；主 CI 全绿（待实现提交的主 CI）。
