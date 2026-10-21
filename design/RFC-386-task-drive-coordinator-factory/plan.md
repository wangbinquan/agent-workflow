# RFC-386 实施计划

**前置**：RFC-385 已提交。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-386-T1 | `TE/application/drive/taskDriveCoordinatorFactory.ts`：工厂、驱动画像、统一按世代的失败上报 | design §2.1 |
| RFC-386-T2 | `TE/domain` 的按意图类型重建规则；认领结果带出意图类型并进入 `TaskDriveContext` | design §2.3 |
| RFC-386-T3 | 会话组合构造一次工厂，`session` 即会话协调器；经 provider 运行时交给子任务启动与生命周期参与者 | design §2.4 |
| RFC-386-T4 | 子任务启动（C11）、根续跑与子任务续跑（C12）改经 `coordinatorFor`；删除调用点的协调器构造与 `ensureWorkspaceProfiles` 标志；原因名中立 | design §2.2 |
| RFC-386-T5 | 测试（design §5 第 1～5 项）与旧锁、账本（第 6 项）；RFC-284 T20 处置表与说明更新 | design §5 |
| RFC-386-T6 | 文档：`docs/dev-gotchas.md` 一条：每次调用的驱动一律经工厂画像，子任务配置 = 会话实时配置 + 父可继承键 | — |

**依赖**：T1、T2 → T3 → T4；T5 贯穿。

## 冲突面

`cli/daemonModules/taskExecution.ts`、`TE/composition/providerRuntime.ts`、`TE/infrastructure/{childExecutionLaunchOperations,childTaskLifecycleParticipant}.ts`：
与 RFC-387、RFC-388 串行。

## 验收清单

- [ ] proposal AC-1～AC-4
- [ ] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片）
