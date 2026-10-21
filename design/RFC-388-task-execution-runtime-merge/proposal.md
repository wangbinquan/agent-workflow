# RFC-388 任务执行 provider 运行时函数合一（RFC-294 S2b）

- **状态**：In Progress（2026-10-21 落档；RFC-387 提交（`684972dbb`）后派发 Codex 实施。用户 2026-10-20「按你推荐继续推进」：由本会话
  设计、交 Codex 实施并审核，免设计门与实现门；规则取舍由本会话按推荐决定，见 §6）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2b）；前置
  [RFC-382](../RFC-382-daemon-task-execution-bundle/proposal.md)、[RFC-387](../RFC-387-task-continuation-semantics/proposal.md)
- **基线**：HEAD `9382675a0` 的 `modules/task-execution/composition/providerRuntime.ts`（研究基线；行号仅作定位提示，以实施时源码为准）
- **落位**：task-execution `composition`（一个中立的运行时组合函数与执行绑定工厂）；守护进程装配层的适配器表收缩

## 1. 背景

`providerRuntime.ts` 里有两个运行时组合函数：`composeSqliteTaskExecutionProviderRuntime`（:294-481）与
`composePostgresqlTaskExecutionProviderRuntime`（:555-774），由 `cli/daemonModules/adapters.ts` 的任务执行适配器表分别调用。2026-10-21 的
只读研究逐成员对比后确认：

- 参与者、运行时组装、任务路由、取消、触发、续跑、自动续跑、生命周期修复、定时启动、归档、投影、概览、读模型、根工作流启动内核、
  工作组房间、澄清指令路由**逐字相同或只差输入**；
- 真正的 provider 差异只有**执行绑定**（SQLite 用进程单例执行模块、`claim({ db })` 与 legacy 连接——后者只在 SQLite 上启用隔离清理回执；
  PostgreSQL 每会话一个执行模块、`claimPersisted`）与**进程并发作用域对象**（必须与配置热应用使用的键一致：SQLite 是数据库客户端，
  PostgreSQL 是数据库运行时对象）；
- 其余差异是漂移：SQLite 自建一份任务 DAG 协作操作覆盖模块组给的那份；SQLite 用一个只多了「自建工作区参与者」与另一个等价可见性
  检查的路由启动包装（`sqliteTaskRouteLaunchOperations.ts`，两者都报 `task-not-found`）；工作区参与者 SQLite 建 3 次、PostgreSQL 建 1 次；
  两边都用 provider 命名的修复参与者别名（`createPostgresql{Clarify,Review}RepairParticipant`，其实是中立工厂的别名）；SQLite 的活动参与者
  为测试保留了 `__setActiveTaskForTesting` 钩子。

RFC-387 已经把仓库准备重试、融合适配器、驱动释放收尾与房间续跑变成中立实现，剩下的差异都可以作为输入进入一个函数。

## 2. 目标

- **G1**：一个中立的 `composeTaskExecutionProviderRuntime`，以执行绑定（执行模块、认领、可选 legacy 连接）与并发作用域为输入；删除两个
  provider 命名的运行时函数。
- **G2**：执行绑定工厂按部署形态命名（进程级 / 会话级），适配器表只保留执行绑定与并发作用域（及 `provider` 标签）。
- **G3**：删除漂移：SQLite 路由启动包装、重复的任务 DAG 协作操作与工作区参与者、provider 命名的修复别名的使用、测试专用的活动钩子
  （相关测试改用执行模块的运行注册表）。

## 3. 非目标

- 任何行为变化（本 RFC 是纯重构）；并发作用域统一为同一个键（保留为适配器条目，日后再议）；legacy 连接改为显式的隔离回执能力。
- SQLite HTTP 装配并入中立挂载表、删除测试回退：RFC-390～392（中立 HTTP 绑定、中立应用图、删除测试回退）。
- 不改 API、事件、schema；不做任何安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：后端没有 `composeSqliteTaskExecutionProviderRuntime` / `composePostgresqlTaskExecutionProviderRuntime`；适配器表的任务执行条目只剩
  `provider`、执行绑定与并发作用域（结构锁）。
- **AC-2**：既有双引擎任务执行用例全部通过，不改断言意图；同文件 provider 孪生、provider 运行时覆盖等架构账本随之收缩。
- **AC-3**：`architecture/counts.json` 不升；guard-manifest 随守卫更新。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **执行绑定按部署形态命名**：`composeProcessTaskExecutionBinding(db)`（进程单例，SQLite 单机）与
   `composeSessionTaskExecutionBinding({ daemonGeneration, persistence })`（每会话，PostgreSQL），不出现 provider 名。
2. **并发作用域保留为适配器条目**：统一为会话数据库客户端需要同时移动 PostgreSQL 的热应用键，风险不在本 RFC 承担。
3. **legacy 连接留在执行绑定里**：日后以显式的隔离回执能力取代。
4. **测试专用活动钩子删除**：使用它的四个测试改用执行模块的运行注册表。
5. **偏离项**：无。
