# RFC-379 实施计划

**前置**：RFC-374 已提交（两者都改启动恢复接线与 `TaskExecutionPersistence`）。派发 Codex 实施、本会话审核；单批次交付，先完成
全部实现与用例，再集中验证一次（CLAUDE.md 文首硬规则）。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-379-T1 | `cli/daemonLifecycleProgram.ts`：四份声明、`composeDaemonLifecycle` 构建与校验、阶段执行器、回执与 `lifecycle step` 日志 | design §2 |
| RFC-379-T2 | 底座：作业 `dependsOn` 校验、`ready` / `health`、`state()` 回执、`daemon-shutdown` 有界停止；轮询与 managed worker 适配器转出健康 | design §5 |
| RFC-379-T3 | 组合无副作用：维护服务构造 / 启动拆分与启动快照、MR 终止定时器移到作业启动、MCP 运行时测试两个 provider 惰性绑定、事件目录登记拆出、authoring 显式初始化、内置工具目录持有者 + `load()`、删除 V:2020 的第二次对账 | design §4 |
| RFC-379-T4 | SQLite 会话组合：构造与启动步骤分离，按 §3.1 交出实现记录与作业记录，删除手写清单 | design §3 |
| RFC-379-T5 | PostgreSQL 会话组合与 `composePostgresqlApplication`：组合期不再执行启动步骤（去掉 `phase.kind === 'daemon'` 守卫下的执行；待应用恢复留在 provider core 组合之后，design §3.2），`initializeExecution` 改由程序的 `execution-recovery` 阶段提供，托管附加作业走 profile 槽位，`executionAuthority.start()` 移到 `prepare` 之后 | design §2.3、§3 |
| RFC-379-T6 | 关停：`task-execution` 作业的有界停止、宽限收尾作用于本 provider 模块、分离步骤的关闭等待 | design §6 |
| RFC-379-T7 | 删除 `startMemoryDistillLoop`、`startSubmoduleRefreshLoop`、`defineBackgroundJob` 及只测它们的用例（先以当时源码复核零生产调用方） | proposal G7 |
| RFC-379-T8 | 新守卫 `rfc379-daemon-lifecycle-guard` 与 G12 行为测试；登记 guard-manifest | design §8.1 |
| RFC-379-T9 | 旧锁处置（design §8.2 表）与 RFC-376 门基线重算（只减） | design §8.2 |
| RFC-379-T10 | 测试（design §9 第 1～9 项），含 §3.3 每个缺陷的回归用例与真实守护进程的顺序断言 | design §9 |
| RFC-379-T11 | 文档：`docs/dev-gotchas.md` 记一条「新启动步骤 / 后台作业只在程序声明里加，组合不得有副作用」；RFC-294 plan S2 注 | — |

依赖：T1 → T2；T3 与 T1 可并行；T4、T5 依赖 T1～T3；T6 依赖 T2；T8、T9 依赖 T4、T5；T10 贯穿。

## 冲突面

- 入口根 `cli/start.ts`、`cli/postgresqlDaemonApplication.ts`、`server.ts` 与 `cli/daemonProvider*`：本 RFC 独占。
- `platform/background/maintenanceService.ts`、`modules/integration/application/mrTerminalControlWorker.ts`、
  `modules/resource-catalog/application/mcps/runtimeDiagnostics.ts`、`modules/event-center/composition.ts`、
  `modules/digital-employee/application/authoringService.ts`、`modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog.ts`、
  `modules/task-execution/composition/providerBackground.ts`、`services/shutdown.ts`。
- 与 S2b / S2c / S5 / S6 串行（RFC-294 plan §6）。

## 验收清单

- [ ] proposal AC-1～AC-9
- [ ] design §8.2 旧锁逐条处置
- [ ] 推送后 exact SHA CI 全绿（含 PostgreSQL 分片与真实守护进程启动用例）
