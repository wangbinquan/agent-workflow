# RFC-436 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`EC` = `S/modules/event-center`，`DE` = `S/modules/digital-employee`，
`DA` = `S/modules/development-automation`。以 RFC-435 收尾后的源码（`8e2f39721`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：
  - event-center：`inbound/http`（新）与 `application/ports`；
  - digital-employee：`inbound/http`（新）、`application/ports` 与 `application`；
  - development-automation：`inbound/http`（新）；
  - `server.ts` 与 bootstrap 只改挂载与连接。
- **承担的演进**：W4 E9 的路由部分，同时是 W4 B / D 第二步：
  - 深引模块内部的路由 6 → 4；
  - import `services/` 的路由 29 → 28；
  - `R1` 201 → 198。
- **不新增**跨 context 依赖；不扩 public 面；context DAG 不新增反向边。
- **留下的债**：
  - 两个句柄合同的形状（`unknown` 请求体、JSON 字符串返回值、`ReturnType<Service[...]>`）原样搬迁。它们现在只对本模块绑定可见，后续收窄不涉及跨模块合同。
  - `DigitalEmployeeRoutePersistence` 仍由 bootstrap 用遗留 `Actor` 实现。
  - development-automation 的图设计 HTTP 适配器 `DA/infrastructure/http/graphDesignRoutes.ts` 仍在 infrastructure（RFC-294 层矩阵里
    infrastructure 禁 route）。它依赖 composition 内的 `GraphDevelopment` 句柄类型，归入 `inbound/http` 要先把该类型移到
    `application/ports`，留给后续。

## 1. 事件中心

| 位置                                                                       | 改动                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `EC/application/ports/eventCenterModule.ts`（新）                          | `EventCenterModule` 接口原样搬来，依赖本模块 application 服务类型、public 端口与 platform 提交事件类型 |
| `EC/composition.ts`                                                        | 删去接口定义，`export type { EventCenterModule }` 转出；转出 `mountEventCenterRoutes`                  |
| `EC/inbound/http/eventCenterRoutes.ts`（新，自 `S/routes/eventCenter.ts`） | 内容不变，只改句柄类型的导入路径                                                                       |
| `S/server.ts`                                                              | 自 `@/modules/event-center/composition` 导入 `mountEventCenterRoutes`                                  |

`deferEventCenterModule` 是装配逻辑，留在 composition。integration 与 bootstrap 仍经 composition 拿到 `EventCenterModule` 类型，导入路径不变。

## 2. 数字员工

### 2.1 句柄合同

`DE/application/ports/digitalEmployeeModule.ts`（新）原样接收 composition 里的以下声明：

- `ToolRegistrationView`、`ToolAuthoringView`、`JobTemplateView`、`EmployeeDefinitionView`、`ExecutionPolicyView`；
- `DigitalEmployeeCommands`、`DigitalEmployeeQueries`、`DigitalEmployeeModule`、`DigitalEmployeeModuleWithRuntime`。

`DigitalEmployeeMigrationStatus` 从 `composition/writerCutover.ts` 移到 `application/ports/writerCutoverPersistence.ts`，原文件转出。
否则 application 会 import composition，触发 `application-composition-import`。composition 转出上述全部类型，现有导入方不变。

### 2.2 案例访问（G4）

`DE/application/caseAccess.ts`（新，自 `S/services/employeeCaseMembers.ts`）：

```ts
/** The caller a case rule decides for: its user id and effective permissions. */
export interface EmployeeCaseViewer {
  readonly user: Readonly<{ id: string }>
  readonly permissions: ReadonlySet<Permission>
}
export function canViewCase(viewer, row, role): boolean // bypass ∪ tasks:read:all ∪ owner ∪ member
export function canOperateCase(viewer, row, role): boolean // bypass ∪ owner ∪ collaborator
export function canManageCaseMembers(viewer, row): boolean // bypass ∪ owner
export async function loadVisibleCase(runtime, viewer, caseId): Promise<CaseAclRow> // 404 同形
export async function requireCaseOperator(runtime, viewer, caseId): Promise<CaseAclRow> // 403 observer-read-only
export async function requireCaseOwner(runtime, viewer, caseId): Promise<CaseAclRow> // 403 forbidden
export function employeeCaseRouteAccess(runtime): EmployeeCaseRouteAccess // { authorize(viewer, caseId, edit) }
```

- 越权写作 `viewer.permissions.has('resource-acl:bypass')`，与 resource-catalog 的 `hasResourceAclBypass` 同义，但不 import resource-catalog
  （DE → RC 不在 DAG 里）。
- 错误码与文案逐字保持；`CaseAclRow`、`CaseMemberRole`、`CaseMemberRow`、`EmployeeCaseRuntime` 原样搬来。
- `employeeCaseRouteAccess` 给出图设计路由所需的 `authorize`：`edit` 为真走 `requireCaseOperator`，否则走 `loadVisibleCase`，
  与原先数字员工路由里的闭包相同。
- composition 转出 `canManageCaseMembers` 与 `employeeCaseRouteAccess`，供 bootstrap 使用；原服务文件删除。

### 2.3 平台工具只读（G5）

工具判据与案例判据分开，新增 `DE/application/toolAccess.ts`：

```ts
/** Platform-catalog tools have no owner row; every write is refused with the shared read-only code. */
export function assertEmployeeToolWritable(row: { readonly builtin: boolean }): void
// throw new ForbiddenError('builtin-readonly', 'this employee_tool is a built-in framework resource and is read-only')
```

文案与 `assertNotBuiltin('employee_tool', row)` 的输出逐字相同。

### 2.4 绑定

`DE/inbound/http/digitalEmployeeRoutes.ts`（新，自 `S/routes/digitalEmployees.ts`）：

- 句柄类型来自 `../../application/ports/digitalEmployeeModule`；案例判据来自 `../../application/caseAccess`；工具判据来自 `../../application/toolAccess`。
- 路由内重复的 `requireCaseOwner` 删除，改用 `caseAccess` 的同名函数（错误码与文案相同）。
- 挂载签名收窄为 `mountDigitalEmployeeRoutes(app, persistence, module)`：
  - 去掉 `activityOperations`、`contexts`、`graph` 三个参数；
  - 删去 `graph?.mountRoutes(...)` 与活动操作的注册，以及随之不再需要的 development-automation、identity-access、`operationRoute`、`operationAuthority` 导入。
- `DigitalEmployeeRoutePersistence` 与 `DigitalEmployeeAclResourceType` 随绑定迁移，由 composition 转出给 bootstrap。

## 3. development-automation 的案例范围路由（G3）

- `DA/inbound/http/employeeCaseRoutes.ts`（新）：

```ts
/** Visible-case (read) or operator (edit) authorization for one employee case. */
export interface EmployeeCaseRouteAccess {
  authorize(actor: Actor, caseId: string, edit: boolean): Promise<unknown>
}
export interface DevelopmentCaseRoutes {
  readonly graph: { mountRoutes(app: Hono, access: EmployeeCaseRouteAccess): void }
  readonly caseAccess: EmployeeCaseRouteAccess
  readonly activity: {
    readonly operations: DevelopmentActivityOperations
    readonly contexts: DirectAuthorityBinding
  }
}
export function mountDevelopmentCaseRoutes(app: Hono, routes: DevelopmentCaseRoutes): void
// routes.graph.mountRoutes(app, routes.caseAccess)，再注册 POST /api/employee-cases/worker/run-one
```

- 活动操作的描述、执行组、令牌访问与 decode / context / encode 和原注册逐字相同；
- `EmployeeCaseRouteAccess` 与图设计路由现有参数同形，在 DA 侧按结构声明，DA 不 import digital-employee 内部；
- `DA/composition.ts` 只转出 `mountDevelopmentCaseRoutes` 与 `DevelopmentCaseRoutes`，不放实现。
- `S/server.ts`：
  - `AppApiRouteMounts` 新增 `developmentCases`，`mountApiRoutes` 在 `digitalEmployees` 之后调用；
  - `ProviderDigitalDevelopmentRouteComposition` 新增 `developmentCases: DevelopmentCaseRoutes`；
  - `digitalEmployees` 只剩 `persistence` 与 `module`。
- `S/bootstrap/daemonHttpComposition.ts` 组装 `developmentCases`：
  - `graph`：`digitalEmployeeModules.graph`；
  - `caseAccess`：`employeeCaseRouteAccess(digitalEmployee.runtime)`（DE composition 转出）；
  - `activity`：活动操作与 `identityAccess.directAuthority`。
    原先这两组路由只在 `module.runtime !== null` 时挂载；生产装配的模块是 `DigitalEmployeeModuleWithRuntime`，运行时恒在，条件等价。

挂载先后：两组路由原先夹在数字员工路由中间，现在整体在其后。逐条核对过路径：

- 活动操作 `POST /api/employee-cases/worker/run-one` 与数字员工的 `POST /api/employee-cases/:id/{resume,terminate,policy-upgrade-preview}`
  第二段字面量不同；
- 图设计路由在 `/api/employee-cases/:caseId/design`、`/api/development-designs/**`、`/api/content-links/:id` 下，与数字员工路由无同方法同形路径。

因此匹配结果与先后无关。API 文档按路径排序，输出不变。

## 4. 账本与计数（实测为准）

- `architecture/commons-debt.json`：删去 `routes/eventCenter.ts`、`routes/digitalEmployees.ts` 与 `services/employeeCaseMembers.ts` 的三条 R1 边，
  `inboundEdges` 201 → 198。
- RFC-305 identity-access 消费者账本：
  - 删去 `routes/digitalEmployees.ts -> identity-access/public/participants`；
  - 新增 `DA/inbound/http/employeeCaseRoutes.ts` 的同名边（DA → identity-access 在 DAG 内）。
- `tests/architecture/architectureReport.ts` 的 legacy 文件归属表删去三个已删文件。
- RFC-310 OS 清单（`design/RFC-310-rule-driven-development-digital-employee/os-architecture-manifest.json`）：
  - digital-employee 与 event-center 的顶层条目加 `inbound`；
  - 外部依赖删去两个旧路由文件，两者都加 `server.ts -> composition`，digital-employee 另加
    `bootstrap/daemonHttpComposition.ts -> composition`（案例访问）。
- development-automation 架构锁（`T/rfc310-architecture-lock.test.ts`）：
  - 顶层闭集加入 RFC-294 design §2 的可选 `inbound/`，同时加 inbound 层禁边（不碰 `@/db` 与本模块 infrastructure）；
  - composition 消费者账本加 `server.ts`。
- RFC-349 provider 边界扫描：两个模块的扫描层加 `inbound/`，删去两个已删文件。
- 引用旧路径的源码锁改指新位置；`counts.json` 只降不升；guard-manifest 刷新行数。

## 5. 失败模式

- **挂载缺失或重复**：用例按方法与路径断言每条受影响路由恰好注册一次，且仍需原权限。
- **判据漂移**：案例与工具判据整段搬迁，错误码、文案与分支不变。RFC-330 的 404 / 403 矩阵与工具 / 岗位模版 ACL 矩阵复跑。
- **DAG 反向边**：数字员工绑定若残留 development-automation 或 identity-access 导入，context 值级 SCC 与 DAG 外 offered 边会报出。
  本 RFC 另加源码锁。

## 6. 测试策略

- **新用例** `T/rfc436-module-inbound-http-bindings.test.ts`：
  - 旧文件不存在，两个绑定位于模块 `inbound/http`；
  - 数字员工绑定不 import development-automation、identity-access、`@/services/`、`@/routes/operation*`；
  - 事件中心绑定只 import 本模块与传输工具；
  - `server.ts` 在 `digitalEmployees` 之后调用 `developmentCases`；
  - 生产应用里活动操作与 `/api/employee-cases/:caseId/design` 各注册一次，无 token 时 401；
  - 案例判据矩阵（owner / collaborator / observer / `tasks:read:all` / bypass / 陌生人）直接对 `caseAccess` 断言；
  - 平台工具只读判据的错误码与文案。
- **改指的用例**：
  - RFC-330 案例访问（判据导入路径）；
  - RFC-341、RFC-317 员工定义 ACL、RFC-330 工具 / 模版 ACL（读路由源码的路径）；
  - RFC-344 / 317 / 305 / 359 的源码锁与账本；
  - RFC-310 OS 清单与 development-automation 架构锁、RFC-349 provider 边界扫描（见 §4）。
- **回归**：
  - 事件中心、数字员工创作、案例、工具 / 岗位模版 ACL 的 HTTP 用例；
  - 图设计与活动操作用例；
  - API 合同覆盖；
  - 全部架构测试。
- **集中验证**：全部实现与用例写完后一次进行：
  - 静态检查；
  - 全量 SQLite；
  - 受影响用例的 PostgreSQL lane；
  - 导出仓库按已提交源码出报告的用例；
  - P0 变异 lane。
