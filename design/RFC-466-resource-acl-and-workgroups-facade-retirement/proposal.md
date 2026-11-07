# RFC-466 退役 resourceAcl 与 workgroups 兼容 facade（RFC-294 W9-D 第十三步）

- **状态**：Done（2026-11-07，落地 `b29152824`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（facade 清仓：consumer 归零后删除）
- **前序**：[RFC-465](../RFC-465-session-capture-port-to-runtime-management/proposal.md)（`R2` 清零）；
  [RFC-345](../RFC-345-resource-catalog-contract-cutover/proposal.md) T9（这两个文件是它留下的 exact compatibility facade）。
- **落位**：collaboration / integration / knowledge-evolution / task-execution 的消费方；resource-catalog `public/queries.ts`；
  task-execution `application/ports/agentLaunchResourceOperations.ts`；intent `domain/sessionAudit.ts`；`packages/backend/tests/helpers/`。

## 1. 背景

`R1`（非模块文件取模块内部）96 条里最大的一处是 `services/resourceAcl.ts`：RFC-345 T9 把它收成 69 行的纯 re-export facade
（resource-catalog 的 composition / application / domain / infrastructure 共 8 个内部入口加 intent 的一个 public 出口），留给各后继波次
按 consumer 逐条切走，现在记 9 条 `R1`。它还剩 6 个生产消费方：

1. collaboration `infrastructure/review.ts` 取 `resolveTaskRole`——同一个评审写路径的参数里已经带着 collaboration 自己的
   `CollaborationTaskRolePolicy` 端口（resource-catalog 用同一个 `resolveTaskRole` 实现它），其余 collaboration 代码都走端口；
2. integration `composition/digitalEmployeeToolConnections.ts` 取 `isVisibleToAudienceSnapshot`（resource-catalog domain 的纯判定）；
3. knowledge-evolution `inbound/fusionRoutes.ts` 取 `hasResourceAclBypass`（resource-catalog `public/types` 已经导出）；
4. task-execution `infrastructure/taskRouteOperations.ts` 取 `canViewResource`（工作流同步预览与同步两处判可见性）；
5. `services/taskLaunchGate.ts` 取 `canViewResource`——只给 `assertWorkflowLaunchable` 用，而它已没有生产调用方（定时任务走同文件的
   `assertWorkflowSnapshotLaunchable`，可见性在 integration 的事务内参与者里判），只剩三个用例在用；
6. task-execution `infrastructure/legacyCallClosure.ts` 取 `isVisibleRow` / `listGrantedResourceIds`——这个文件从生产入口已不可达
   （架构报告的 unreachable-production-files 之一）：新启动经 `TaskExecutionResourceBinding.freezeCallClosure` 冻结，它按 RFC-349 只作为
   历史聚焦用例的行为预言保留。它也是 `services/workgroups.ts`（RFC-345 的另一个兼容 facade，一行 `export *`，记 1 条 `R1`）唯一的生产
   消费方。

## 2. 目标

- **G1 五个活消费方改取 owner 的合同**：collaboration 用自己的 `CollaborationTaskRolePolicy`；integration 取 resource-catalog
  `public/queries`（新增导出纯判定 `isVisibleToAudienceSnapshot`；它的入参带受众 authority 投影，按 RFC-294 W0-R 不经 `public/types`），
  knowledge-evolution 取 `public/types` 已有的 `hasResourceAclBypass`；task-execution 的工作流同步两处改用
  `AgentLaunchResourceOperations.canViewWorkflow`（task-execution 端口新增的方法，由已经取 resource-catalog 可见性判定的
  `infrastructure/agentLaunchResourceOperations.ts` 实现，与 `validateHostWorkflow` 同一条装配路径）。
- **G2 只剩用例在用的两段代码离开生产树**：`legacyCallClosure.ts` 原样迁入 `tests/helpers/`（行为预言不变，两个 facade import 改取
  resource-catalog 定义处）；`assertWorkflowLaunchable` 原样迁入 `tests/helpers/workflowLaunchGate.ts`，`services/taskLaunchGate.ts` 只留
  生产在用的 `assertWorkflowSnapshotLaunchable`。
- **G3 删除两个 facade**：`services/resourceAcl.ts`、`services/workgroups.ts`；用例改取 resource-catalog 定义处。
- **G4 账本下降**：`R1` 96 → 86；`services/` 75 → 73；`legacy-thin-facades`、`export-star-barrels`、不可达生产文件按实测下降；不新增
  目标 DAG 之外的边、跨 context 内部文件对、off-DAG offered 文件对与 `module-layer-violations`；public surface 偏差不升。
- **G5 失去模块外消费方的 public 符号当场收回**（RFC-294 design §3.3「无 consumer 不公开」）：facade 删除后，intent
  `public/operations.ts` 的 `canAuditIntentSessions`（原先只由 facade 转出，其余调用方都是 intent 自己的两个文件）落 intent
  `domain/sessionAudit.ts`；该文件其余四个类型转出本来就没有 importer，整个文件删除；resource-catalog `application/resourceDefaults.ts`
  里无人引用的同名副本删除；`callEdgeKey`（唯一的模块外读者 `legacyCallClosure` 已迁入用例树）退出 resource-catalog `public/queries`。

## 3. 非目标

- `services/taskLaunchGate.ts` 余下的 `assertWorkflowSnapshotLaunchable`（仍取 `services/workflow.validator`，随 E1 归位）。
- 其余 RFC-345 facade 与 `services/` 实现文件。
- 行为预言本身是否还该保留（本 RFC 只把它们挪出生产树，用例与断言不动）。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/resourceAcl.ts`、`services/workgroups.ts` 不在，src / 用例 / 脚本零引用；六个消费方按 G1 / G2 改取；生产树里不再有
  `legacyCallClosure` 与 `assertWorkflowLaunchable`；intent `public/operations.ts` 不在、零 import，`callEdgeKey` 不在 resource-catalog public（G5）。
- **AC-2**：架构计数按实测：`R1` 96 → 86（账本逐条相等）；越界类计数不升；public surface 偏差不升；未被消费的 public 符号不升。
- **AC-3**：受影响用例（资源 ACL、评审、数字员工工具连接、融合路由、工作流同步、启动门、调用闭包、intent 会话审计）全部通过；新增
  RFC-466 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **工作流可见性挂在 `AgentLaunchResourceOperations` 上**：task-execution 取 resource-catalog 可见性判定的那条装配路径已经存在
   （`agentLaunchResourceOperations.ts` → resource-catalog `composition/resourceAcl`，登记过的跨 context 内部文件对），同步路由的
   `validateHostWorkflow` 也从这里来；另起端口或让 resource-catalog public 导出带数据库句柄的函数，都会新增越界对或 public surface 偏差。
2. **只剩用例在用的生产代码迁入 `tests/helpers/`，不删**：`legacyCallClosure` 是 RFC-349 有意保留的行为预言、`assertWorkflowLaunchable`
   是三个用例钉住的启动门组合；挪进用例树后断言与覆盖逐字不变，生产树只剩可达代码。是否退役预言本身留给它们各自的后继 RFC。
3. **受众可见性判定经 `public/queries` 转出，不经 `public/types`**：它的入参 `ResourceAclAudienceAuthority` 命中 RFC-294 W0-R 的
   capability 名称规则（`…Authority` 类型不得穿过 `public/types` / `public/events`）；`public/queries` 已经是 resource-catalog 转出纯判定的
   出口（RFC-454 的调用闭包编解码、RFC-455 的操作摘要），改名或另立端口都不如放回这里。
4. **失去消费方的 public 符号当场收回，不留债**：它们失去消费方正是本 RFC 删 facade、迁预言造成的；按 §3.3 收回只动 intent 两个调用方的
   import 与两个用例的断言。intent 的审计判定落 domain，入参用与原先等价的结构类型（`ReadonlySet<Permission>`），不再取 identity-access。
