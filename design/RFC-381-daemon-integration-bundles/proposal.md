# RFC-381 守护进程模块组：集成、定时任务与融合（RFC-294 S2b 第二批）

- **状态**：In Progress（2026-10-20 落档并派发。用户 2026-10-20「按你推荐继续推进」：由本会话设计、交 Codex 实施并审核，免设计门与实现门；
  规则取舍由本会话按推荐决定，见 §6。在 RFC-380 提交后派发）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2b）、design §10.2；前置
  [RFC-380](../RFC-380-daemon-module-bundles/proposal.md)（S2b 第一批）
- **基线**：HEAD `d8bb1a672`（研究基线；RFC-380 提交后行号会移动，以实施时源码为准）
- **落位**：守护进程装配层 `cli/daemonModules/`（新增 `integration.ts`、`scheduledTasks.ts`、`fusion.ts`）；入口根改为调用它们；
  task-execution 的源终止参与者与融合引擎适配器、source-control 的工作区维护只做接线层面的最小调整

## 1. 背景

RFC-380 之后仍由两个 provider 各装配一份、SQLite 进程内又在 `server.ts` 重复构造的，是集成、定时任务与融合三组。2026-10-20 的只读研究
（基线 `d8bb1a672`）确认它们的构造大多同构，但有四处行为差异，合并前必须先定：

1. **融合的启动配置**：SQLite 会话里的融合引擎适配器用组合时的配置快照（`cli/start.ts` 的 `fusionStartDeps`），HTTP 侧的融合栈
   每次启动重读配置；今天所有融合启动都走 HTTP 侧，若直接合并到会话实例，约十项启动设置会冻结到重启（CFG-45 同类缺陷）。单机
   PostgreSQL 的融合启动则从未传入这些设置。
2. **MR 终止后的工作区清理**：SQLite 用只处理 webhook-terminal 认领、失败只记日志的 SQLite 专属函数；PostgreSQL 用通用的
   `finalizeClaimedWorkspace`，失败即抛出，MR 终止作业无限重试并阻塞同一 MR 流上的后续处理。
3. **MR 终止时找不到 PostgreSQL 的运行驱动**：源终止参与者默认用进程全局的运行注册表，而 PostgreSQL 的驱动注册在 provider 模块的
   私有注册表里。结果：MR 关闭 / 合入后界面已显示任务取消，Agent 仍继续运行到下一次心跳（最多约 15 秒）才停，工作区清理也随之推迟。
4. **定时任务的可启动性校验**：SQLite 用 `services/taskLaunchGate.ts`（识别被校验的工作流、报告全部问题、422），PostgreSQL 用组合里
   内联的校验（409、只报第一条错误、不识别子工作流的接线问题、误拒内置 Agent 引用）。

## 2. 目标

- **G1** 集成（MR 终止控制、Webhook 投递 / 分发 / 入站、端点与触发器服务、投递运行时、事件中心、事件自动化、审批网关、开发工具
  连接）、定时任务运行时、融合三组各由 `cli/daemonModules/` 中一个中立构造函数产生，两个 provider 的会话组合各调用一次。
- **G2** SQLite 进程内这些模块每会话只构造一次；`server.ts` 的回退调用同一函数；删除 `server.ts` 中生产无人使用或不可达的实例。
- **G3** 按 §6 统一四处行为差异。

## 3. 非目标

- 任务执行运行时与驱动协调器、数字员工、开发自动化、意图（RFC-382）；SQLite HTTP 装配并入中立挂载表与删除测试回退（RFC-383）；
  部署 profile（S2c）。
- 不改 API 路径、事件、schema；不做任何安全相关改动。

## 4. 用户可见变化

单机 SQLite：无。

PostgreSQL（单机与托管）：

1. MR / PR 关闭或合入后，正在运行的 Webhook 任务立即停止（此前最多再运行约 15 秒）。
2. MR 终止后的工作区清理失败不再阻塞同一 MR 流上的后续处理；清理认领保留，由维护恢复重试。
3. 定时任务与 Webhook 触发器保存时，工作流不可启动的错误由 409 改为 422（`workflow-invalid`），消息为「failed static validation
   (N errors)」，`details.issues` 含警告；子工作流的接线问题在保存时即被拒绝（此前保存成功、每次启动失败直至自动停用）；引用内置
   Agent 不再被误拒；Webhook 投递遇到不可启动的工作流记为 `launch-failed` 并更新触发器卡片（此前记为 `skipped-owner-invalid`）。
4. 单机 PostgreSQL 的融合任务开始遵守实时的子 Agent 实时捕获、合并 Agent 设置与并发池设置（托管已如此）。

## 5. 验收标准

- **AC-1** 三组各由一个构造函数产生；S 与 P 各调用恰好一次；`server.ts` 只在回退中调用（结构锁）。
- **AC-2** SQLite 守护进程内三组成员各一个实例；`server.ts` 中无人使用的事件自动化实例与不可达的事件中心回退删除。
- **AC-3** §1 四处差异按 §6 统一，各有双引擎回归用例：PostgreSQL 上 MR 关闭立即停止运行中的任务；清理失败不阻塞 MR 流；
  定时任务 / 触发器保存 422 且识别子工作流接线问题；融合启动读取组合之后修改的设置。
- **AC-4** 被收进构造函数的底层工厂不再在根中直接调用；受影响的旧锁改指新位置，不放宽意图。
- **AC-5** 推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **融合启动设置实时读取**：共享融合栈每次启动读取当前配置（SQLite 用启动配置的实时读取口，PostgreSQL 每次启动经 `start()` 投影），
   不沿用组合时快照。
2. **工作区清理统一为 `finalizeClaimedWorkspace`，且不抛给 MR 终止作业**：失败记日志、保留认领，交由维护恢复与清理 nudge 重试。
3. **源终止参与者使用本 provider 模块的运行注册表**：与 2 同批落地（否则清理失败会重新阻塞 MR 流）。
4. **定时任务校验统一为 SQLite 语义**：识别被校验的工作流、报告全部问题、422；启动路径与保存路径用同一份校验。
5. **事件中心消费者按能力门控的一种写法**：两个 provider 在生产中等价，统一为 PostgreSQL 现行写法；SQLite 测试回退补齐第 5 个事件类型包。
6. **偏离项**：构造函数放 `cli/daemonModules/`（同 RFC-379 / RFC-380），S2c 迁入 `bootstrap/`。
