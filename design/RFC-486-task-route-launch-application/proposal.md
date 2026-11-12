# RFC-486 任务启动用例归 task-execution 的 application：`taskRouteLaunchOperations.ts` 按内容分层（RFC-294 W4-E1 余项）

- **状态**：In Progress（2026-11-11）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §7，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §5.6（`infrastructure/` 的路由操作文件是用例，按
  §3 常驻规则 10 属于 application，`taskRouteLaunchOperations.ts` 随 W4-E1）与 plan §4.7（W4-E1 余下这一个文件，另立）。
- **前序**：[RFC-478](../RFC-478-task-service-retirement/proposal.md)（Done，`0133385a8`）把 `services/task.ts` 按内容分层归 task-execution，
  W4-E1 只剩本文件；[RFC-483](../RFC-483-human-gate-badge-read-model/proposal.md)（Done，`8f7463f57`）收口 S9 的 task-execution ↔
  collaboration 一对，本文件不再与 S9 在制文件冲突。

## 1. 背景

`modules/task-execution/infrastructure/taskRouteLaunchOperations.ts`（1,457 行）是任务启动的用例：根启动内核（准入前检、工作区准备、上传
落地、准入事务、提交后发布与交给驱动）、单代理与工作组两条启动臂、路由层的启动操作、定时 / webhook / 子任务走的启动参与者。它把准入
规则、编排与持久化写在一起：准入事务直接建任务行、成员行、执行意图与工作组状态，另有两处直接查库；依赖里收裸 `db` 与配置文件路径。
RFC-294 design §3 常驻规则 10 与 proposal C10 要求用例编排与规则判定进 application / domain、持久化与外部 effect 进 infrastructure。

## 2. 目标

- **G1 编排进 application**：根启动内核、两条启动臂、路由启动操作与启动参与者迁入 `application/launch/`，依赖只收 application 端口与其他
  context 的 public 合同，不再收裸 `db` 与配置文件路径，不 import 本模块或他模块的 `infrastructure/**`。
- **G2 纯规则进 domain**：任务仓库挂载的编解码、存储仓库面投影、工作组运行时配置的构建与直接启动人的推导是纯函数，迁入 `domain/`。
- **G3 持久化留在 infrastructure、经端口交入**：准入事务（同一个可串行化事务里的全部语句，次序不变）、活跃成员与自动化回执两条查询、
  上传上限的配置文件读取、任务授权查询各由 infrastructure 适配器实现 application 端口，composition 装配。
- **G4 启动守卫由 task-execution 声明**：启动用到的 MR 守卫成员（取消信号、终止快照、两道提交前复核与四个生命周期回调）收成
  task-execution 自有的 `TaskLaunchGuard` 端口，从 `public/types` 交出；integration 的 `ProtectedMrLaunchGuard` 改为扩展它。task-execution
  不再取 integration 的类型，这条越 DAG 的 offered 文件对销账（RFC-294 S9 第 5 项，与 RFC-481 同一做法）。
- **G5 锁与账本**：新增 RFC-486 用例；文件搬迁带着的两条表归属债按 `CONTENT_DEBT_SUCCESSORS` 改到新文件，不新增债；减速带收紧到实测。

## 3. 非目标

- `task_collaborators` 与 `users` 的表归属（task-execution 有 9 个文件读写前者、4 个读后者，属于成员表一族，另立）。
- 启动的语义、SQL、事务边界、语句次序、事件与提交次序；路由层与 `public/commands` 的合同。
- `taskRouteOperations.ts`、`taskRouteRepairOperations.ts`（design §5.6：随功能 RFC 触及时归位）；运行时驱动一族；任何行为变化。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`infrastructure/taskRouteLaunchOperations.ts` 删除；启动编排在 `application/launch/`，不 import `infrastructure/**`、不收裸 `db`，
  模块分层门不新增债。
- **AC-2**：准入事务由一个 infrastructure 适配器实现，事务里的语句与次序与此前逐条相同；两条表归属债按后继身份改到新文件，账本条数不变。
- **AC-3**：越 DAG 的 offered 文件对 47 → 46（task-execution → integration 这一对）；减速带 60 项不升、触及的收紧到实测；
  `application-direct-effect-files` 与跨 context 内部文件对不升；task-execution 的 public 只增 `TaskLaunchGuard` 一个类型（integration 消费）。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
