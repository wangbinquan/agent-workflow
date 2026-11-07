# RFC-466 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`RC/` = `S/modules/resource-catalog/`，
`TE/` = `S/modules/task-execution/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：facade 清仓——consumer 归零后删除。`services/resourceAcl.ts` 与 `services/workgroups.ts` 是 RFC-345 T9
  留下的 exact compatibility facade；本 RFC 把它们的消费方按 owner 合同切走后删除。
- 每个消费方都改取目标 DAG 已经给的边与合同：collaboration 用自己的端口（resource-catalog → collaboration 的
  `CollaborationTaskRolePolicy` 是 RFC-399 登记的 required 边）；integration / knowledge-evolution → resource-catalog 是 offered 边，分别经
  `public/queries`（入参带受众 authority 投影的纯判定，按 RFC-294 W0-R 不经 `public/types`）与 `public/types`；task-execution 经自己的 `AgentLaunchResourceOperations` 端口，实现处复用登记过的 `agentLaunchResourceOperations.ts →
RC/composition/resourceAcl.ts` 那一对。不新增任何 context 边或跨 context 内部文件对。

## 1. 五个活消费方

| 消费方                                                                         | 原来取                                       | 改为                                                                                                                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| collaboration `infrastructure/review.ts` 的 `assertActingMember`               | `resolveTaskRole`                            | 参数里已有的 `taskRolePolicy.resolveTaskRole`（resource-catalog 以同一个 `resolveTaskRole` 实现该端口，`RC/composition.ts`）                         |
| integration `composition/digitalEmployeeToolConnections.ts`                    | `isVisibleToAudienceSnapshot`                | `RC/public/queries`（新增 re-export，与 RFC-454 / RFC-455 的纯判定同处；入参带 `ResourceAclAudienceAuthority`，按 RFC-294 W0-R 不进 `public/types`） |
| knowledge-evolution `inbound/fusionRoutes.ts`                                  | `hasResourceAclBypass`                       | `RC/public/types`（已有）                                                                                                                            |
| task-execution `infrastructure/taskRouteOperations.ts`（同步预览、同步前置门） | `canViewResource(db, actor, 'workflow', wf)` | `dependencies.canViewWorkflow(actor, wf)`                                                                                                            |
| `services/taskLaunchGate.ts` 的 `assertWorkflowLaunchable`                     | `canViewResource`                            | 整个函数迁入用例 helper（§2）                                                                                                                        |

`AgentLaunchResourceOperations`（`TE/application/ports/agentLaunchResourceOperations.ts`）新增
`canViewWorkflow(actor, workflow: AgentLaunchWorkflowAclRow): Promise<boolean>`（行形状是 RFC-099 判定读的四个字段，结构类型，不点名
resource-catalog 的 `AclRow`）；实现 `TE/infrastructure/agentLaunchResourceOperations.ts` 转交它已经 import 的 `canViewResource(db, actor,
'workflow', workflow)`。路由依赖 `TaskRouteOperationsDependencies`、同步依赖 `TaskWorkflowSyncDependencies`、预览与前置门两个函数的内联依赖
各加 `canViewWorkflow`；`TE/composition/providerRuntime.ts` 与 `validateHostWorkflow` 同样从 `taskRouteLaunchDependencies.agent.resources`
取（并登记进 `ProviderRouteOperationsAssembled`，bootstrap 的 `routes()` 不必提供）。判定与原来逐字同一条（同一个 `canViewResource`、同一个库句柄）。

## 2. 只剩用例在用的两段代码

- `TE/infrastructure/legacyCallClosure.ts` → `T/helpers/legacyCallClosure.ts`：生产入口不可达（新启动经
  `TaskExecutionResourceBinding.freezeCallClosure`），RFC-349 把它留作历史聚焦用例的行为预言。原样迁移，只改三个 import：
  `isVisibleRow` 取 `RC/domain/resourceAccess`、`listGrantedResourceIds` 取 `RC/infrastructure/sqliteResourceGrantRepository`、
  `getWorkgroupById` 取 `RC/infrastructure/legacy/workgroups`（都是 facade 原先转出的定义处）。`rfc243-call-workflow`、
  `rfc291-closure-call-edges` 改从 helper 取，`rfc282-d3-ref-codec-production` 与 `rfc454` 改读 helper 的源码。
- `services/taskLaunchGate.ts#assertWorkflowLaunchable` → `T/helpers/workflowLaunchGate.ts`：它没有生产调用方（integration 定时任务端口的同名方法由
  bootstrap 用同文件的 `assertWorkflowSnapshotLaunchable` 实现），原样迁移，可见性取 `RC/composition/resourceAcl`。
  `rfc228-agent-resource-integrity`、`task-launch-gate`、`rfc251-product-boundary` 改从 helper 取；`services/taskLaunchGate.ts` 只留快照校验
  （不再取 `services/workflow`）。

## 3. 删除与改指

- 删除 `services/resourceAcl.ts`、`services/workgroups.ts`。11 + 12 个用例与 `T/helpers/intentResourceCatalogBinding.ts` 改取定义处
  （resource-catalog 的 composition / application / domain / infrastructure 与 intent `public/operations`）。
- 精确清单：RFC-345 facade 退役用例（两个 facade 进 `RETIRED_FACADES`、它们的 8 条边销账，含 `services/workflow` → `taskLaunchGate`；
  读 facade 源码的断言改为「facade 不在」）、RFC-345 合同用例与 classic facade 用例的同类断言、RFC-454 的余下转出（5 个）与
  `services/workflow` 消费方、RFC-376 结构守卫（`export-star-barrels` 与不可达生产文件基线、后继登记）、RFC-349 provider cutover 的两条
  facade 边、RFC-359 W4-D6c 的读文件清单、RFC-395 表归属债务夹具（`legacyCallClosure` 那条）、架构报告的 legacy owner 表。
- 公共内核清单 `resourceacl-ts` 的文件改指 resource-catalog 里持有这些单一来源的四个文件（`application/resourceDefaults`、
  `composition/resourceAcl`、`domain/resourceAccess`、`infrastructure/resourceVisibility`）。
- 账本：`commons-debt.json` 的 `R1` 10 条按实测销账（96 → 86）；guard-manifest 按实测刷新改到的守卫文件行数。

## 3a. 失去模块外消费方的 public 符号（G5）

facade 删除、调用闭包预言迁出后，架构报告的未被消费 public 符号会多出两个（集中验证实测 323 → 325）：intent
`public/operations#canAuditIntentSessions`（原先只有 `services/resourceAcl.ts` 转出）与 resource-catalog `public/queries#callEdgeKey`
（原先只有 `legacyCallClosure` 取）。按 RFC-294 design §3.3 当场收回：

- `canAuditIntentSessions` 落 intent `domain/sessionAudit.ts`：判定与说明逐字不变，入参由 `Pick<AuthenticatedAuthoritySnapshot, 'permissions'>`
  换成等价的结构类型 `{ readonly permissions: ReadonlySet<Permission> }`（domain 不取 identity-access）；intent 自己的两个调用方
  （`application/session.ts`、`inbound/intentSessionRoutes.ts`）改取它。`public/operations.ts` 余下的四个类型转出（`IntentApply*`）在
  src / 用例 / 脚本里都没有 importer，留着只会变成不可达生产文件，整个文件删除；RFC-305 的 identity-access 消费方清单随之少一条。
- resource-catalog `application/resourceDefaults.ts` 里同名的 `canAuditIntentSessions` 副本无人引用（facade 转出的是 intent 那份），删除。
- `callEdgeKey` 退出 `public/queries` 的 RFC-454 编解码出口（resource-catalog 自己的 validator 从 domain 取）；用例 helper 改从 domain
  取，RFC-454 用例的同一性断言改为「不在 public」。

## 4. 用例

- **新用例** `T/rfc466-resource-acl-and-workgroups-facade-retirement.test.ts`：两个 facade 不在、src / 用例 / 脚本零 import（census AST，
  带负对照）；五个消费方的源码锚点；`public/queries` / `public/types` 的两个判定与 domain 是同一个函数对象、受众可见性判定不经 `public/types`；两段代码不在 src、在 `T/helpers/`；
  §3a 的收回（intent `public/operations.ts` 不在且零 import、审计判定在 domain 且两个调用方取它、resource-catalog 副本不在，`callEdgeKey`
  不在 `public/queries`）。
- RFC-359 W58 的源码兜底改锁注入的 `await dependencies.canViewWorkflow(actor, workflow)` 与实现处同一条
  `canViewResource(db, actor, 'workflow', workflow)`（两处合起来等价于原先那一条）；RFC-454 用例的 `callEdgeKey` 同一性改为不在 public；
  RFC-305 的 identity-access 消费方清单少 intent `public/operations.ts` 那条。
- 改到的路由与同步用例（`rfc359-w7` / `rfc359-w8` 路由对拍、`rfc395-a2` 两个用例）的 `canViewWorkflow` 用生产实现
  `composeAgentLaunchResourceOperations({ db }).canViewWorkflow`；PostgreSQL 启动适配用例的手写 `AgentLaunchResourceOperations` 加一个
  调到即失败的 `canViewWorkflow`（启动不经这里判可见性）。

## 5. 留下的债

- `services/taskLaunchGate.ts` 的快照校验仍取 `services/workflow.validator`（随 E1）；`taskRouteOperations` 仍取 `services/workflow` 的 `getWorkflow`。
- 两个行为预言是否退役，留给各自的后继 RFC（它们的覆盖是否已由活实现的用例承担，要逐条核对）。
- `commons-debt.json` 里几条 P3 登记仍以旧 `services/resourceAcl.ts` 的行号为锚点（RFC-345 收缩 facade 时就已过期，本 RFC 不处理）。
- `ws/registry.ts` 的 intent-sessions 帧门仍自写 `intent:audit` 判定（注释称单一来源是 `canAuditIntentSessions`）：legacy ws 层，随 ws
  归位的后继 RFC 改取 intent 的判定。

## 6. 测试策略

受影响用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §4；P0 变异 lane 两引擎各 17 阶段。
