# RFC-387 实施计划

**前置**：RFC-386 已提交。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-387-T1 | 驱动释放收尾：两边 `finalizeClaimedWorkspace`，`taskDriverRelease.ts` 捕获并保留认领；SQLite `nudgeWorkspacePrune` 改形 | design §2.5 |
| RFC-387-T2 | 模块组输出 `gateContinuation` 与中立 `roomContinuation`；两边人工门 worker 改用；删除适配器的 `roomContinuation` | design §2.1、§2.2 |
| RFC-387-T3 | 中立 `createRepositoryPreparationRetryCommand`；删除 SQLite 重试闭包、`legacyLaunch`、PostgreSQL 同步实现；启动自动续跑只提交 | design §2.3 |
| RFC-387-T4 | 中立 `createFusionEngineTaskOperations`；删除两版旧适配器、`fusion.startDeps`、`fusionRunConfiguration` 与无消费方的 `runConfiguration` | design §2.4 |
| RFC-387-T5 | 删除 `createTaskDriveCoordinator`；四个旧测试入口改为基于工厂的仅测试包装 | design §2.6 |
| RFC-387-T6 | 测试（design §3 第 1～6 项）与旧锁、账本（第 7 项） | design §3 |
| RFC-387-T7 | 文档：`docs/dev-gotchas.md` 一条：续跑 / 重试 / 融合一律经会话驱动设施，`createTaskDriveCoordinator` 已删除 | — |

**依赖**：T1 → T2 → T3 → T4 → T5；T6 贯穿。

## 冲突面

`services/task.ts`、`cli/daemonModules/{taskExecution,adapters,fusion}.ts`、`TE/composition/providerRuntime.ts`、`TE/infrastructure/*FusionEngineTaskOperations.ts`：
与 RFC-388 串行。

## 验收清单

- [ ] proposal AC-1～AC-4
- [ ] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片）
