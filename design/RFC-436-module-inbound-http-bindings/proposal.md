# RFC-436 事件中心与数字员工的 HTTP 绑定归入各自模块（RFC-294 W4 E9）

- **状态**：Done（2026-11-03；`3cb987341`，exact SHA 主 CI run 41754866058：attempt 1 的 macOS e2e 分片 3/4 已跑 106/140 全过，在慢 runner 上撞到作业 20 分钟时限被取消（基础设施），重跑 attempt 2 70/70 全绿）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、设计、
  实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 余项 E9（路由到模块合同），同时是 W4 B / D 第二步的一部分
- **前序**：[RFC-434](../RFC-434-inbound-adapter-public-contracts/proposal.md)、[RFC-435](../RFC-435-task-catalog-typed-queries/proposal.md)
- **落位**：event-center 与 digital-employee 模块新增 `inbound/http`；两个模块的 `application/ports` 接收路由句柄合同；
  digital-employee `application` 接收案例访问判据；development-automation 新增 `inbound/http`，接收原先挂在数字员工路由里的活动操作。

## 1. 背景

RFC-435 之后，`routes/` 里还有 6 个文件深引模块内部。其中两个属于 E9：

- `routes/eventCenter.ts` 为拿到路由句柄 `EventCenterModule` 深引 `event-center/composition`；
- `routes/digitalEmployees.ts` 为拿到路由句柄 `DigitalEmployeeModule` 深引 `digital-employee/composition`。

两个句柄是各自模块的管理面：自定义事件源、响应规则、提交事件投递、观察者推进，以及数字员工的类型、工具、岗位模版、员工、案例与输入上传。
它们只有一个生产消费者，就是本模块自己的 HTTP 绑定。

RFC-294 对这类代码给出的目标是：

- `routes/` 逐步变成各模块 `inbound/` 的薄绑定，见 design §2；
- 没有生产消费者的符号不进 public，见 design §3.3。

把这两个句柄改造成 public 合同，等于把约五十个只给 HTTP 用的管理方法公开给所有模块。按 public 面规则，还要先把其中的 `unknown` 请求体、
函数类型和平台类型全部收窄。这个方向与目标架构相反。

数字员工路由另有三处偏离：

- **托管了 development-automation 的路由**：图驱动研发的设计路由（`graph.mountRoutes`）和活动操作 `POST /api/employee-cases/worker/run-one`。
  context DAG 只允许 development-automation 依赖 digital-employee，反向不允许，所以这两组路由不能随数字员工绑定进入 digital-employee。
- **案例访问判据放在 `services/employeeCaseMembers.ts`**：可见、操作、管理成员三条判据。它们是数字员工自己的规则，却放在 legacy 层，
  并深引 resource-catalog 的 domain。路由里还另有一份逐字相同的 `requireCaseOwner`。
- **内置工具只读判据来自 `services/systemResources.ts`**：工具只读规则借用的是 `assertNotBuiltin`。平台目录工具是数字员工自有的概念。

## 2. 目标

- **G1 事件中心绑定入模块**：
  - 路由移到 `modules/event-center/inbound/http/eventCenterRoutes.ts`；
  - 路由句柄合同 `EventCenterModule` 移到 `application/ports`；
  - `composition.ts` 转出类型与挂载函数，`server.ts` 经 composition 挂载。
- **G2 数字员工绑定入模块**：
  - 路由移到 `modules/digital-employee/inbound/http/digitalEmployeeRoutes.ts`；
  - 句柄合同（命令、查询、视图、`DigitalEmployeeModule`）移到 `application/ports`；
  - 路由所需的资源 ACL 端口 `DigitalEmployeeRoutePersistence` 随绑定迁移，仍由 bootstrap 提供。
- **G3 development-automation 自己挂载案例范围的路由**：
  - 活动操作的注册与图设计路由的挂载移到 `modules/development-automation/inbound/http/employeeCaseRoutes.ts`；
  - `server.ts` 新增路由组 `developmentCases`，紧随 `digitalEmployees` 挂载图设计路由与活动操作；
  - 案例授权来自 digital-employee 的案例访问（bootstrap 连接）。
  - 数字员工绑定不再依赖 development-automation、identity-access 与操作路由助手。
- **G4 案例访问判据归 digital-employee**：
  - `services/employeeCaseMembers.ts` 移到 `modules/digital-employee/application/caseAccess.ts`，原文件删除；
  - 判据接 digital-employee 自有的 `EmployeeCaseViewer`（用户 id 与权限集合），以 `resource-acl:bypass` 权限点表述越权；
  - 路由里重复的 `requireCaseOwner` 删除。
- **G5 平台工具只读判据归 digital-employee**：
  - 以本模块的判据给出同一个 403 `builtin-readonly` 与同一段文案；
  - 数字员工绑定不再 import `services/`。
- **G6 行为不变**：
  - 路由、方法、权限点、令牌访问、请求解析、响应字节与错误码全部不变。
  - development-automation 的两组路由改在数字员工路由之后挂载。它们与数字员工的路由没有重叠匹配，API 文档按路径排序，挂载先后不可见。

## 3. 非目标

- Webhook 投递路由：重放逻辑要先成为 integration 的应用用例，并随 `services/webhook/*` 迁入 integration，另立 RFC；
- 定时任务、stage 合同与能力模板（E8）路由；
- execution-contract 对 legacy agent / workflow / scriptRun 的兼容 seam；
- 句柄合同的语义收窄（`unknown` 请求体、JSON 字符串返回值等），本 RFC 只移动位置，不改形状；
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`routes/eventCenter.ts`、`routes/digitalEmployees.ts`、`services/employeeCaseMembers.ts` 不再存在；两个绑定位于各自模块的 `inbound/http`，
  只依赖本模块与传输工具，不依赖其他模块内部；数字员工绑定不依赖 development-automation、identity-access 与 `services/`。
- **AC-2**：
  - 活动操作与图设计路由由 development-automation 挂载，案例授权来自 digital-employee 的案例访问；
  - 每条路由只注册一次，方法与路径不变；
  - context DAG 不新增反向边。
- **AC-3**：账本按实测更新：
  - `R1-inbound-module-internals` 201 → 198（两条路由深引，加上 `services/employeeCaseMembers` 指向 resource-catalog domain 的一条）；
  - 深引模块内部的路由 6 → 4，import `services/` 的路由 29 → 28；
  - 其余结构门不回退。
- **AC-4**：事件中心、数字员工、案例访问、工具 / 岗位模版 ACL、图设计与活动操作的用例全部通过。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **入模块绑定，不扩 public**：管理句柄只服务本模块的 HTTP 绑定。按 RFC-294 design §2 与 §3.3，绑定随模块，句柄留在 `application/ports`。
   仓内已有同形先例：intent、knowledge-evolution、run-observability、integration、identity-access 都有本模块的 `inbound/`。
2. **development-automation 的路由单列路由组**：数字员工绑定若继续托管它们，就要么反向依赖 development-automation（DAG 不允许），
   要么开一个回调插槽让别的 context 往数字员工的路由里塞东西。单列路由组让每个 context 只挂自己的路由，案例授权由 bootstrap 连接。
3. **平台工具只读判据由数字员工自己给出**：resource-catalog 对内置工作流也各自给出 `builtin-readonly`（`workflowCatalogPredicate`、
   `intentApplyResourcePorts`）。错误码是共享词汇，判据归资源的 owner。文案逐字保持。
4. **案例判据接自有的查看者类型**：只读用户 id 与权限集合。请求 actor 在结构上满足它，digital-employee 不需要为此依赖 identity-access 或
   resource-catalog（两者都不在它的 DAG 出边里）。
