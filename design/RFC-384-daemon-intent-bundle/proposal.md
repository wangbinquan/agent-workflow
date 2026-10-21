# RFC-384 守护进程模块组第五批：意图（RFC-294 S2b）

- **状态**：In Progress（2026-10-21 落档并派发。用户 2026-10-20「按你推荐继续推进」：由本会话设计、交 Codex 实施并审核，免设计门与
  实现门；规则取舍由本会话按推荐决定，见 §6。RFC-383 提交（`e9fcfc58a`）且主 CI 全绿后派发）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2b）、design §10.2；前置
  [RFC-380](../RFC-380-daemon-module-bundles/proposal.md)～[RFC-383](../RFC-383-daemon-employee-automation-bundles/proposal.md)
- **基线**：HEAD `64a15d085` 加 RFC-383 工作树（RFC-383 已原样提交为 `e9fcfc58a`；行号仅作定位提示，以实施时源码为准）
- **落位**：守护进程装配层。新增 `cli/daemonModules/intent.ts`，入口根改为调用它；intent 模块补出 composition 入口，让模块组与
  入口根不再深入 `application/` 与 `inbound/`

## 1. 背景

意图（Intent）的工厂早已与 provider 无关，但 2026-10-21 的只读研究（基线 HEAD `64a15d085` 加 RFC-383 工作树）确认：

- **SQLite 进程内有两套意图图**：S 构造工作者图（资源目录、持久化、清单、转储辅助、事件发布、工作者族的轮次运行时、排队续跑），
  V 另构造 HTTP 图（应用引擎、路由及其资源目录、持久化、清单、转储辅助、事件发布、HTTP 族的轮次运行时），两者都在生产中生效。
  PostgreSQL 只有一套。
- **SQLite 维护服务经迟绑定读取应用引擎的活动集**（`appComposition.intentApplyActivity`），排队通知先进一个只有 SQLite 才有的收件箱；
  PostgreSQL 先构造意图、再构造维护服务，直接连接。
- **PostgreSQL 在构造时读一次默认运行时**（转储辅助的 `defaultRuntime`），单机是文件读、托管是 SQL，违反「构造无 I/O」；
  SQLite 每次实时读取。轮次本身总是传入有效默认值，所以这只是构造时的 I/O，不影响用户。
- 其余差异只是写法不同：制品生命周期一边显式构造、一边隐式构造；路由收到的身份对象一边是包装对象、一边是核心；
  排队准入失败的日志文字与字段名不同。
- 入口根直接导入 intent 的 `application/` 与 `inbound/`，在 `architecture/commons-debt.json` 中留有 9 条 R1。

研究确认这些重复今天不改变任何功能：进程级状态（`applyLock`、`intentSem`、`liveTurnAborts`）本来就是进程单例，应用引擎只有一个，
排队续跑在启动前会缓冲。

## 2. 目标

- **G1 中立构造函数**：意图组由 `cli/daemonModules/intent.ts` 的一个 provider 中立构造函数产生，两个 provider 的会话组合各调用一次；
  没有真正的 provider 差异，不加适配器表条目。
- **G2 SQLite 进程内去重**：资源目录、持久化、清单、转储辅助、事件发布、应用引擎每会话一个；V 改用注入实例，只在 `??` 回退中调用
  构造函数（直接 `createApp` 的测试）。两个系统 Agent 运行族保留，各自在模块组内只构造一次。
- **G3 统一装配形状**：两边都在维护服务之前构造意图组，维护读取模块组的应用活动；删除 SQLite 的收件箱与迟绑定。
- **G4 无构造时 I/O**：转储辅助的默认运行时改为实时读取。
- **G5 账本减债**：模块组只经 intent 的 composition 入口取用，删除入口根到 intent `application/`、`inbound/` 的 R1。

## 3. 非目标

- 维护 Worker 线程里的意图维护命令（`platform/background/maintenanceWorker.ts`）保持原样。
- 每次调用现建的任务协调器、两个 provider 运行时函数合一（RFC-385）；SQLite HTTP 装配并入中立挂载表、删除测试回退（RFC-386）；
  部署 profile（S2c）。
- 维护快照复用模块组持久化、应用引擎复用资源目录组的 MCP 事务生命周期：都是无状态的写法差异，不在本 RFC 处理。
- 不改 API 路径、事件、schema；不做任何安全相关改动。

## 4. 用户可见变化

无功能变化。可观察的只有：

1. 排队意图准入失败的日志统一为一条中立文字，字段名统一为 `error`（此前 PostgreSQL 文字带「PostgreSQL」、SQLite 字段名为 `err`）。
2. PostgreSQL（尤其托管）组合守护进程时不再读一次默认运行时配置。

## 5. 验收标准

- **AC-1 构造位置**：意图组由一个构造函数产生；S 与 P 各调用恰好一次；`server.ts` 只在 `deps.intentModules ?? <同一构造函数>(...)`
  回退中调用（结构锁）。
- **AC-2 单实例**：SQLite 守护进程内意图资源目录、持久化、清单、转储辅助、事件发布、应用引擎各一个实例；维护读取的应用活动就是
  路由使用的那个引擎（行为测试）；两个运行族各一个。
- **AC-3 装配形状**：两边都在维护服务之前构造意图组；收件箱与 `intentApplyActivity` 迟绑定删除；转储辅助构造时不读配置（用例）。
- **AC-4 旧锁与账本**：受影响的旧锁改指新位置，不放宽断言意图；R1 净减；`architecture/counts.json` 不升。
- **AC-5 CI 全绿**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **构造粒度为每个 provider 会话一次**：同 RFC-380～383。
2. **保留两个系统 Agent 运行族**：工作者族（排队续跑、启动续跑）与 HTTP 族（路由轮次）各自的运行时绑定与保留内容按族隔离，
   HTTP 测试夹具不得进入排队恢复；模块组内各构造一次。
3. **采用 PostgreSQL 的装配形状**：意图组在维护服务之前构造，维护直接读模块组的应用活动；删除收件箱
   （`queuedNotifications.ts`、`composeIntentQueuedNotifications`）与 `SqliteAppComposition.intentApplyActivity`。排队续跑在启动前
   本来就缓冲通知，删除收件箱不丢通知。
4. **转储辅助的默认运行时实时读取**：`composeIntentDumpAuxiliaryQueries` 接收实时配置读取口，替换构造时传入的字符串；删除 SQLite
   两处包装。
5. **制品生命周期在模块组内显式构造**，托管选择经 `adapters` 进入。
6. **路由只收 `{ directAuthority }`**：现行实现只读这一项。
7. **模块组只经 intent 的 composition 入口取用**：intent 补出资源目录绑定（含其 WeakMap）、排队续跑包装、路由依赖类型与挂载再导出；
   删除对应 R1。
8. **V 同时收到注入的模块组与 `intentTestDependencies` 时抛错**：避免测试夹具被静默忽略（RFC-386 删除这条路径）。
9. **P 以 `runtime.intentModules` 取代 `runtime.intentMaintenance` 与 `runtime.resumeIntentSessions`**，S 中的 PostgreSQL 会话从它取排队
   续跑；日志用 P 的模块日志器。
10. **偏离项**：构造函数放在 `cli/daemonModules/`（同 RFC-379～383），S2c 迁入 `bootstrap/`。
