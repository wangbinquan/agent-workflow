# RFC-502 集成的开发适配器配置、代码托管交付、审批网关与工具连接目录迁出 composition（RFC-294 S10 第九步）

- **状态**：Done（2026-11-17，落地 `7953576df`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294
  总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话
  按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  S10 的范围列“integration、resource-catalog、system-operations、intent、runtime-management、digital-employee 的余项”，退出门要求组合层
  “无循环与 switch，`try` 与 `throw` 只出现在登记清单内”，各模块 `composition/` 的分支计数不高于经确认的上限。
- **前序**：[RFC-501](../RFC-501-integration-webhook-admission-out-of-composition/proposal.md)（S10 第八步，Done，`1ac43b89b`）。
  S10 与 S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只动 integration 的四个组合文件
  （`developmentAdapterConfigOperations.ts`、`codeHostEffects.ts`、`approvalGateway.ts`、`digitalEmployeeToolConnections.ts`）、
  `infrastructure/developmentToolConnectionStore.ts` 的一个接口声明、取这些名字的用例与 development-automation 里两处提到旧名字的注释，
  不碰 bootstrap 与 `taskImage*` / `crewstation*`。

## 1. 背景

RFC-501 之后，integration 的组合层控制流（F13 口径）实测 57 行。除 RFC-370 余项的 `taskImageDevelopmentAdapter.ts`（13 行）与
`crewstationDevelopmentAdapters.ts`（3 行）外，余下 41 行里 40 行在四个文件里，它们都是“用例写在 composition、装配只有一两行”的形状：

- `developmentAdapterConfigOperations.ts`（12 行）：开发适配器配置的六个操作（列表、读取、创建、修订、发布、归档），读取时按技术权限与
  显式授权分档、写时按编辑 / 治理授权，返回 development-automation 结构消费的配置合同；装配只是按 `PersistenceDb` 建 store、取时钟。
- `codeHostEffects.ts`（11 行）：开发交付的代码托管桥——按仓库远端选代码托管连接的绑定、MR 的确保 / 回复 / 观察、MR 原始事实与仓库认领
  键；装配只是 `composeDevelopmentCodeHostDelivery` 把四者接在同一个绑定上。
- `approvalGateway.ts`（10 行）：审批网关的回执投影（绑定引用、意图摘要、提交 / 按幂等键查询 / 观察三条回执），同一段 66 行在文件里
  逐字出现两遍——旧的按进程环境取密钥的装配一份、按选定绑定的装配一份。
- `digitalEmployeeToolConnections.ts`（7 行）：数字员工的工具连接目录——按精确修订解析连接的可用性与可见性、按用途自动挑选候选；
  装配只是按 `PersistenceDb` 建 store。它用的 store 接口声明在 infrastructure 里。

## 2. 目标

- **G1 用例归 application**：四组用例原样迁入 integration 的 application——`developmentAdapterConfigOperations.ts`（配置操作）、
  `developmentCodeHostDelivery.ts`（代码托管桥）、`developmentApprovalGateway.ts`（审批回执投影）、
  `developmentToolConnectionCatalog.ts`（工具连接目录），工厂按同层惯例命名为 `create…`；工具连接目录用的 store 接口迁入
  `application/ports/developmentToolConnectionStore.ts`，infrastructure 改取它。
- **G2 composition 只装配**：四个组合文件只留 bootstrap 与用例在用的装配入口（`composeDevelopmentAdapterConfigOperationsFor`、
  `composeDevelopmentCodeHostDelivery`、`composeApprovalGatewayRunnerFor`、`composeSelectedApprovalGatewayRunnerFor`、
  `composeDevelopmentToolConnectionCatalog`），名字、参数与返回形状不变；审批的两份投影合为 application 的同一个函数。四个文件里没有
  F13 口径的控制流。
- **G3 账本与锁**：取被迁名字的用例改取新位置；按路径读这些文件的锁改读新文件；`composition-control-flow-integration` 按实测收紧；新增
  RFC-502 用例。

## 3. 非目标

- integration 的其余组合文件（`webhookIngress.ts` 的一行可用性判断、`webhookDispatch.ts` 等）与其他模块；`taskImage*` / `crewstation*`
  一族（RFC-370 余项，逐个避让）。
- 删除旧的审批装配 `composeApprovalGatewayRunnerFor`（bootstrap 已不用，系统 mock E2E 与组合根用例仍取它，见 design §8）；`process.env` 的
  读取位置；S12 的回落写法。
- 改写任何判据、拆分函数；任何行为变化、接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的新文件声明；四个组合文件只声明清单允许的装配入口，没有 F13 口径的控制流；改名前的四个
  `compose…` 名字与两份私有投影、私有目录函数没有声明；`DevelopmentToolConnectionStore` 只在 application 的端口文件声明。
- **AC-2**：同样输入下四组用例的结果、错误码与对端口的调用次序和参数与此前一致（迁移逐字，现有用例对拍）；bootstrap 取到的装配入口与
  此前同名、同参数、同返回形状；审批的两条装配拿到的是同一份投影实现。
- **AC-3**：新文件只取 shared、`@/util/errors`、`@/util/hash`、`@/auth/actor` 的类型、resource-catalog 的 `public` 与本模块 domain /
  application，不取 infrastructure、composition 与 IO 包，不用进程全局；跨 context 边、public surface 不升；
  `composition-control-flow-integration` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
