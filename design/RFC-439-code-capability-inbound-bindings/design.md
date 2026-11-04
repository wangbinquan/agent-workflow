# RFC-439 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`CC` = `S/modules/code-capability`。以 RFC-438 收尾后的源码（`0bf8272c2`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：code-capability（E8 兼容岛）的 `inbound/http`（两个绑定）与 `composition/routes.ts`（只转出挂载）；
  `server.ts` 只改 import，挂载调用不变。
- **承担的演进**：W4 B / D 第五步：
  - 深引模块内部的路由 2 → 0，B / D 退出门「入站适配器不再深引模块内部」在 `routes/` 上达成；
  - `R1-inbound-module-internals` 176 → 170；
  - 兼容岛的入站适配器全部在模块内，E8 吸收时整块迁移。
- **不新增** DAG 之外的边与 R2 边：绑定只 import 本模块与 HTTP 传输工具；`server.ts` 指向 composition 属 bootstrap 例外。
- **留下的债**：
  - E8 整体吸收（proposal §3）；
  - 绑定仍用 `routes/registry`、`routes/resourceAcl` 两个 HTTP 传输工具，与其他模块的绑定相同，随传输工具归位 platform 另立；
  - `services/demoSeed.ts` 指向 `CC/composition/demoSeed` 的 R1 边。
- **偏离项**：无。composition 只转出；inbound 不碰 db、infrastructure 与他域内部。

## 1. 文件去向

| 原文件                            | 新位置                                        | 说明                                                                                                                                    |
| --------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `S/routes/code.ts`                | `CC/inbound/http/codeRoutes.ts`               | 原样搬迁；本模块 import 改相对路径；`CodeHistoryRouteQueries` 的投递链改用 `CodeDeliveryChainQuery`，删去「为避开 R1 而复制」的结构副本 |
| `S/routes/capabilityTemplates.ts` | `CC/inbound/http/capabilityTemplateRoutes.ts` | 原样搬迁；本模块 import 改相对路径                                                                                                      |
| —                                 | `CC/composition/routes.ts`                    | 转出 `mountCodeRoutes`、`mountCapabilityTemplateRoutes` 与两个依赖类型                                                                  |

## 2. 连接

- `server.ts`：两条 import 合为一条，取 `@/modules/code-capability/composition/routes`。`ProviderCodeRouteComposition`、
  `mountCodeRoutes(app, input.code.history)` 与 `mountCapabilityTemplateRoutes(app, input.code.capabilityTemplates)` 不变，
  挂载先后（`routes.code(app)`、`routes.capabilityTemplates(app)`）不变。
- bootstrap（`daemonHttpComposition.ts`）不变：`composeCodeHistoryQueries` 的返回值正是 `CodeHistoryRouteQueries` 的形状，
  由类型检查在连接处核对。

## 3. 守卫与用例

- **RFC-317 ACL 写门守卫**（`T/architecture/rfc317-acl-write-gate-guard.test.ts`）：
  - 语料从 `routes/**` 扩为 `routes/**` 加各模块 `inbound/**`；
  - `CAPABILITY_TEMPLATE_ROUTE` 改指新位置，「语料非空」断言补上「含能力模板绑定、含模块 inbound 绑定」；
  - 扩展前实测：模块 `inbound/` 下没有挂 `/acl` 或调用 `canViewResource` 的文件，规则的结论不变。
- **RFC-349 provider 边界**：候选从两个路由文件改为 `CC/inbound/**`；模板传输断言读新位置。
- **RFC-349 历史组合**：`CODE_ROUTE_SOURCE` 改指新位置。
- **改 import 的用例**：`rfc304-code-metrics`、`rfc309-template-upstream-wiring`、`rfc349-code-history-composition`、
  `rfc349-code-matrix-postgresql-adapter`、`rfc395-history-response-parity`，改从 `composition/routes` 取挂载函数。
- **架构报告**：legacy 归属表删去两个已删文件。
- **新用例** `T/rfc439-code-capability-inbound-bindings.test.ts`：
  - 原文件不存在，绑定与挂载入口就位；`composition/routes.ts` 只转出两个绑定，`composition.ts` 只转出 schema；`server.ts` 经 composition 挂载；
  - `routes/` 下没有文件深引模块内部，判据与 R1 账本同一（`inboundBoundaryEdges`），带一条负对照；
  - 两个绑定的依赖白名单：本模块相对路径（不进 `infrastructure`）加框架、共享合同与 HTTP 传输工具；
  - 生产应用（两个引擎）里路由元数据不变，未登录 401，能力目录与未知能力的图投影照常应答，模板列表 200。

## 4. 账本与计数（实测为准）

- `architecture/commons-debt.json`：删去两个路由的 6 条 R1 边，`inboundEdges` 176 → 170。
- `architecture/guard-manifest.json`：改动的两个登记守卫刷新 `lines`。
- `architecture/counts.json`：`legacy-horizontal-files` 只降不升，不改。
- 路由错误码棘轮与 API 合同覆盖的语料本就含 `modules/*/inbound/**`，搬迁后错误码仍在语料内。

## 5. 失败模式

- **挂载漂移**：`server.ts` 的挂载调用与顺序不变；新用例断言生产应用里的路由元数据与应答。
- **类型收紧**：投递链类型从 `unknown[]` 收紧为 `DeliveryRow[]`，运行时不变，由静态检查覆盖。
- **守卫失去对象**：ACL 守卫与 provider 边界守卫的语料跟着文件走，新断言确认语料含新位置。

## 6. 测试策略

全部实现与用例写完后集中验证一次：

- 静态检查（`tsc`、eslint 两套配置、prettier）；
- 全量 SQLite；
- 导出仓库（含 PostgreSQL 真库）跑受影响用例、路由错误码棘轮与 API 合同覆盖；
- P0 变异 lane。
