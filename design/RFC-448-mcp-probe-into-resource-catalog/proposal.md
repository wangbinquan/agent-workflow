# RFC-448 MCP 探测用例与资源操作协调器归 resource-catalog（RFC-294 W4 B / D 第十四步）

- **状态**：Done（2026-11-05；`df2cb6e26`，exact SHA 主 CI run 42008858737 与 windows-platform run 42008858797 首轮全绿）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D
- **前序**：[RFC-447](../RFC-447-repository-groups-into-source-control/proposal.md)（仓库组用例归 source-control）
- **落位**：resource-catalog 的 `application/mcps`（探测的三个用例与探测记录读写）、`infrastructure`（进程内 MCP 探测、资源操作协调器）、
  `composition`（装配、两个进程级协调器实例）；路由只经 `public/types` 的 `McpProbeOperations`。

## 1. 背景

RFC-447 之后 5 个路由仍 import `services/`。resource-catalog 的 `routes/mcps.ts` 有三个：

- `services/mcpProbe.ts`（664 行）：进程内连上 MCP 服务器完成握手、列出工具与资源（stdio 起子进程 / HTTP 连接）；
- `services/mcpProbeStore.ts`（96 行）：探测记录经 resource-catalog 的 `McpProbeStore` 端口读写，并把存储行还原成线上形状；
- `services/resourceOperationCoordinator.ts`（137 行）：按资源 id 串行化写入与长操作的进程内协调器，及 MCP、插件两个进程级实例。
  resource-catalog 的 application 已用端口（`McpOperationCoordinatorPort`、`PluginOperationCoordinatorPort`）接收它们，实例由装配根注入。

探测的三个端点（列表、读、探测）的编排——加锁、按配置哈希去重、代际、探测前后的可见性与配置重验、超代丢弃——整段写在路由里。
装配根还从路由取测试时钟 `mcpRouteNow`（MCP 写入的因果时间戳要与探测共用同一个时钟）。

## 2. 目标

- **G1 探测用例归 application**：三个端点的编排原样迁入 `application/mcps/probeOperations.ts`，合同 `McpProbeOperations`
  （`list` / `read` / `probe`）在 `application/mcps/ports.ts`，经 `public/types` 转出；探测记录的三个读写函数原样迁入
  `application/mcps/probeRecords.ts`。
- **G2 探测与协调器归 infrastructure**：`mcpProbe.ts` 与协调器类原样迁入 resource-catalog `infrastructure/`；两个进程级实例
  移到 `composition/resourceOperationCoordinators.ts`，经 `composition` 转出给装配根。
- **G3 装配**：`composeMcpProbeOperations` 选择探测方式（托管的 `McpProbeRunner` 或进程内探测），并持有原路由里的测试注入点与
  时钟；装配根的 MCP 写入时钟改取它。
- **G4 路由变薄**：`routes/mcps.ts` 不再 import `services/`，三个端点只做 HTTP（参数校验、取 authority、序列化）。
- **G5 行为不变**：三个端点的权限、响应、错误码与先后顺序（404 区分、禁用 422、配置变化 409、超代 409、探测抛错的日志）不变；
  协调器语义、两个实例的进程级共享不变。
- **G6 不留 facade**：三个 `services/` 文件删除。

## 3. 非目标

- MCP 运行时诊断、MCP 写入的其余用例；插件操作；
- 审计登记 EK-05（探测经 SDK 起子进程、不在全仓 spawn 棘轮内）的处置——锚点随文件迁移改指新位置，处置不在本 RFC；
- 其余 4 个路由；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：三个 `services/` 文件不再存在，源码里没有对它们的 import；`routes/mcps.ts` 不 import `services/`，对 resource-catalog
  只经 public；application 文件不 import infrastructure、composition 与 legacy；装配根不再从路由取时钟。
- **AC-2**：计数按实测更新：import `services/` 的路由 5 → 4；`services/` 文件 216 → 213；模块里 import `services/` 的文件 142 → 141（task-image 探测改取模块内文件）；其余结构门不回退。
- **AC-3**：以下用例全部通过：MCP 探测（进程内 stdio / HTTP、路由、记录读写）、精确修订操作与去重、协调器、跨租户与 ACL、
  MCP / 插件服务、诊断与运行时测试。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **编排进 application，而不是把协调器经 public 给路由**：协调器的方法收函数参数，经 public 转出会成为新的 public 面偏差；
   编排本来就是用例（加锁、重验、去重、代际），路由只该做 HTTP。
2. **协调器类进 infrastructure、实例进 composition**：application 只认端口；类是进程内机制，实例是进程级共享状态，归装配层持有，
   与既有的注入方式一致。
3. **探测记录用参与者端口已有的 `McpProbeMeasurement` 类型**：原文件取 `services/mcpProbe` 的 `ProbeResult`，迁入后 application
   不能取 infrastructure 的类型；两者形状相同，托管的 `McpProbeRunner` 本来就返回 `McpProbeMeasurement`。
4. **测试注入点与时钟随装配走**：它们服务于「选择哪种探测」与「探测和写入共用的时钟」，属于装配；装配根不再反向依赖路由。
