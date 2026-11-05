# RFC-448 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`RC` = `S/modules/resource-catalog`。以 RFC-447 落地后的源码
（`9636d1073`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：resource-catalog 的 `application/mcps`（探测用例、探测记录读写、合同）、`infrastructure`（进程内探测、
  协调器机制）、`composition`（装配、进程级实例）、`public/types`（合同类型）。
- **承担的演进**：W4 B / D 第十四步，import `services/` 的路由 5 → 4；`services/` 文件 216 → 213；模块里 import `services/` 的文件 142 → 141；装配根不再 import 路由里的时钟。
- **不新增** DAG 之外的边：
  - application 文件只 import 共享合同、`@/util/errors`、`@/util/log` 与同模块端口 / public 类型；
  - infrastructure 文件的 import 与原文件相同（`@/util/*`、共享合同）；
  - 路由对 resource-catalog 只经 public；装配根经 `composition` 取实例与装配函数。
- **留下的债**：审计登记 EK-05 的处置（锚点随迁）；其余 4 个路由。
- **偏离项**：无。

## 1. 文件去向

| 原位置                                                                    | 新位置                                              | 说明                                                       |
| ------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `S/services/mcpProbe.ts`                                                  | `RC/infrastructure/mcpProbe.ts`                     | 原样                                                       |
| `S/services/mcpProbeStore.ts`                                             | `RC/application/mcps/probeRecords.ts`               | 原样；`ProbeResult` 改为参与者端口的 `McpProbeMeasurement` |
| `S/services/resourceOperationCoordinator.ts` 的类与 `OperationGeneration` | `RC/infrastructure/resourceOperationCoordinator.ts` | 原样                                                       |
| 同上：`mcpOperationCoordinator`、`pluginOperationCoordinator`             | `RC/composition/resourceOperationCoordinators.ts`   | 两个进程级实例                                             |
| `S/routes/mcps.ts` 三个探测端点的编排                                     | `RC/application/mcps/probeOperations.ts`            | 原样；`actor` 换成调用方给的 authority（见 §2）            |
| `S/routes/mcps.ts` 的 `__setProbeOptionsForTesting`、`mcpRouteNow`        | `RC/composition/mcpProbeOperations.ts`              | 改名 `__setMcpProbeOptionsForTesting`、`mcpProbeNow`       |

## 2. 连接

- **合同**（`RC/application/mcps/ports.ts`）：
  - `McpProbeOperations`：`list(authority)`、`read(authority, id)`、`probe(authority, id, expectedConfigHash)`；
  - `McpProbeCoordinatorPort`：在 `McpOperationCoordinatorPort` 之上加 `runDeduplicatedOperation`、`beginOperation`、`latestGeneration`
    （都是协调器类已有的方法）；
  - `McpProbeOperations` 经 `RC/public/types` 转出。
- **用例**（`probeOperations.ts`）：`createMcpProbeOperations(deps)`，依赖 `queries`、`aclIdentity`、`store`、`coordinator`、`now()`、
  `runProbe(mcp, { startedAt })`、日志。
  - 三个端点的语句按原顺序搬入：`loadVisibleMcp` 改为收 authority；
  - 探测结束后的重验原先再取一次 `authorityFor(actor)`：装配根的 `authorityFor` 是 `directOperationAuthority(directAuthority, actor)`，
    对同一个 actor 每次得到同一份 authority，可见性在查询时现算，所以沿用调用方给的那一份，行为相同。
- **装配**（`RC/composition/mcpProbeOperations.ts`）：`composeMcpProbeOperations({ queries, aclIdentity, store, coordinator, probeRunner })`：
  - `probeRunner` 在（托管）时探测交给它，否则进程内 `probeMcp`（带测试注入的选项与本次 `startedAt`）——与原路由的分支相同；
  - `mcpProbeNow()` 与 `__setMcpProbeOptionsForTesting` 在此文件：前者即原 `mcpRouteNow`（测试选项里的 `now` 优先）。
- **装配根**：
  - `bootstrap/daemonModules/resourceCatalog.ts`：协调器实例改取 `@/modules/resource-catalog/composition`；MCP 写入的
    `nextMutationTimestamp` 改用 `mcpProbeNow()` 与 `probeRecords` 的 `getProbeByMcpId`；
  - `bootstrap/daemonModules/observation.ts`：协调器实例改取同处；
  - `bootstrap/daemonHttpComposition.ts`：`mcps` 路由依赖去掉 `aclIdentity`、`probeStore`、`probeRunner`，加
    `probes: composeMcpProbeOperations({...})`。
- **路由**：`McpRouteDependencies` 同步去掉三项、加 `probes`；三个端点只做参数校验（`McpOperationRequestSchema`）、取 authority、
  返回 JSON；`mcpRouteNow`、`__setProbeOptionsForTesting` 删除。

## 3. 守卫与用例

- **架构报告**：legacy 归属表删去三个 `services/` 文件。
- **账本**：`commons-debt.json` 的 EK-05 锚点改指新文件与行号（处置不在本 RFC）；其余账本、清单与 `counts.json` 不变（计数只降）。
- **改 import 的用例与辅助**：19 个用例与 2 个辅助按新位置取（协调器实例取 composition，类取 infrastructure，探测取 infrastructure，
  记录读写取 application）；`rfc201-mcp-exact-operation` 的测试注入点改取 composition。
- **新用例** `T/rfc448-mcp-probe-into-resource-catalog.test.ts`：
  - **位置与引用**：三个旧文件不存在、新文件就位；源码里没有文件 import 旧路径（census AST，带负对照）；路由不 import `services/`、
    对 resource-catalog 只经 public；application 文件不 import infrastructure / composition / legacy；装配根不 import `@/routes/mcps`；
  - **行为**：用内存存储与假探测驱动 `createMcpProbeOperations`：未探测过的 MCP `read` 抛 `probe-not-found`；`probe` 在配置哈希
    不符时 409 并且不探测、禁用时 422；成功的探测写入记录并带回 `configHashUsed`；同一配置并发两次只探测一次；`list` 只给可见 MCP 的记录；
  - **装配**：有 `probeRunner` 时探测交给它；`mcpProbeNow()` 取测试注入的时钟。
- **行为由既有用例覆盖**：RFC-030 探测（stdio / HTTP 集成、路由、记录）、RFC-201 精确修订操作、协调器、RFC-223 跨租户、
  RFC-271 owner 栅栏、MCP / 插件服务、诊断与运行时测试。

## 4. 失败模式

- **漏改消费者**：`tsc` 全量检查兜底；新用例对旧路径的零引用断言带负对照。
- **编排顺序被改动**：语句原样搬移，只把 `actor` 换成 authority；新用例与 RFC-201 / RFC-030 的路由用例锁定外部行为。
- **协调器实例分叉**：两个实例只在 composition 一处创建，装配根、观测模块与探测用例取同一份；新用例断言实例只声明一次。

## 5. 测试策略

全部实现与用例写完后集中验证一次：静态检查；全量 SQLite（候选导出仓库）；导出仓库接 PostgreSQL 跑全部架构测试与受影响用例；P0 变异 lane。
