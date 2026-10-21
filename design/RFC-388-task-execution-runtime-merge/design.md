# RFC-388 设计：任务执行 provider 运行时函数合一

研究基线 HEAD `9382675a0`（行号以实施时源码为准）。`PR:` = `modules/task-execution/composition/providerRuntime.ts`，`A:` =
`cli/daemonModules/adapters.ts`，`B:` = `cli/daemonModules/taskExecution.ts`，`T/` = `packages/backend/tests/`；其余路径相对 `packages/backend/src/`。

## 1. 逐成员对比（研究结论，I = 相同，DI = 只差输入，G = 真正差异，D = 漂移）

| 成员 | SQLite | PostgreSQL | 结论 |
| --- | --- | --- | --- |
| persistence | PR:301-305 | PR:560-565（另有 `runtime.persistence` 回退） | DI → 必填输入 |
| 执行模块 / 认领 | 进程单例（PR:424、:439）、`claim({ db })` + legacy 连接（A:96-98） | 每会话（PR:566-571）、`claimPersisted`（A:185-186） | G → 执行绑定 |
| 活动 / 停止 | legacy 单例 + 测试钩子（`services/task.ts:327-329`） | 执行模块注册表（PR:583-588、:607） | 生产等价 → 一律取执行模块注册表 |
| taskDagCollaboration | 自建（PR:328，覆盖 B:267） | 用模块组的 | D（无状态） |
| processConcurrencyScope | `db`（PR:329） | 数据库运行时对象（A:197） | G → 适配器条目 |
| leases / memory injection | 必填 | 缺省值（PR:599-603） | DI（模块组总会给） |
| 参与者、运行时组装、调度接缝 | PR:317-355 | PR:589-627 | I |
| Agent / 工作组路由启动 | SQLite 包装（PR:356-359） | 中立（PR:641） | D（`sqliteTaskRouteLaunchOperations.ts:43-128` 只多自建工作区参与者与等价可见性检查） |
| 工作区参与者 | 建 3 次 | 建 1 次（PR:628-632） | D（无状态） |
| 任务路由、取消、触发、续跑、自动续跑、生命周期修复、定时启动 | PR:360-422 | PR:653-708 | I |
| 托管恢复消费者 | — | PR:709-715 | DI（可选，`taskRecoverySelection.ts:7-17` 中立） |
| 后台、归档、投影、概览、读模型 | PR:423-448 | PR:716-742 | I / DI |
| 根工作流启动内核、工作组房间、澄清指令 | PR:459-478 | PR:761-771 | I / DI |
| 修复参与者 | 用 `createPostgresql{Clarify,Review}RepairParticipant` 别名 | 同 | D（`collaboration/composition.ts:15-24` 是中立工厂的别名） |

仓库准备重试、融合、驱动释放收尾、房间续跑在 RFC-387 之后已是中立实现。

## 2. 设计

- `TE/composition/taskExecutionBinding.ts`：`interface TaskExecutionBinding { module; claim(intentId); legacyConnection? }`；
  `composeProcessTaskExecutionBinding(db)`、`composeSessionTaskExecutionBinding({ daemonGeneration, persistence })`。
- `PR`：`composeTaskExecutionProviderRuntime<C>({ db, persistence, execution: TaskExecutionBinding, finalizeWorkspace, log, runtime /* 含
  processConcurrencyScope、taskDagCollaboration、leases、memory injection，均必填 */, routeLaunch, routeWorkspace, routes, rootResumeRuntime,
  lifecycleRepair, fusion, workgroupTaskRoom, drives /* RFC-386 工厂 */, recoverySelection?, archive?, workspaceReads?, schedulerDriver? /* 测试接缝 */ })`，
  内部从执行绑定建生命周期端口、从执行模块注册表取活动 / 停止、按 PostgreSQL 的单工作区形状建路由启动与 launches。返回类型不含 provider 字面量。
- 适配器表：`provider`、`execution(persistence)`、`processConcurrencyScope`；删除 `compose`。模块组直接调用中立函数。
- 删除：两个 provider 命名函数、`sqliteTaskRouteLaunchOperations.ts`（及 `composition/taskRouteLaunch.ts` 的再导出）、修复别名的使用、
  测试专用活动钩子；类型再导出（`composition/taskExecutionRuntime.ts`、P / V 的类型引用）改为中立类型。`T/architecture/rfc359-w5-adapter-production-consumer.test.ts`
  的账本只降不升，所以不能保留无生产调用方的 provider 命名工厂。

## 3. 测试策略

1. 既有双引擎任务执行用例（含 `T/helpers/eachProviderTaskExecution.ts` 等直接构造处改为中立函数）全部通过，不改断言意图。
2. 结构锁：两个 provider 命名函数不存在；适配器表条目集合；模块组直接调用中立函数。
3. 旧锁与账本（研究清单）：`T/architecture/rfc359-w5-same-file-provider-pairs.test.ts:111`（删除该行）、`rfc359-w5-provider-runtime-exercised.test.ts:403`
   （下限随之下降）、`rfc376-structural-guards.test.ts`、`rfc294-review-offered-edge-dag.test.ts`、`T/rfc294-architecture-preflight.test.ts:364-366`、
   `T/rfc328-architecture-guards.test.ts:258`、`T/architecture/rfc380-daemon-module-bundles.test.ts`、`rfc359-w5-t17-provider-file-location.test.ts:146-147,158`、
   `T/rfc359-w8-runtime-participants-conformance.test.ts:528-532,600-628`、`T/rfc349-task-execution-provider-runtime.test.ts`、`T/rfc349-runtime-registry-provider.test.ts`、
   `T/rfc370-*-root-bindings.test.ts`、`T/rfc321-repository-publication-ratchet.test.ts`、`T/rfc244-alert-resolved-boot-wiring.test.ts`、`T/rfc103-launch-config-passthrough.test.ts`、
   使用 `__setActiveTaskForTesting` 的四个测试；`architecture/counts.json` 不升，guard-manifest 随守卫更新。

## 4. 与 RFC-294 目标架构的对齐

task-execution 的组合只剩一个中立函数，provider 差异只经执行绑定与并发作用域进入；同文件 provider 孪生账本减少一项。无偏离项。
