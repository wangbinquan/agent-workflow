# RFC-538 技术设计

## 1. 现状（HEAD `c06e6adab`，源码实读）

- **探测接缝**（`modules/resource-catalog/composition/mcpProbeOperations.ts`）：模块级 `let probeOptionsOverride: ProbeOptions | undefined`，
  `__setMcpProbeOptionsForTesting(opts)` 覆盖它；`mcpProbeNow()` 取 `probeOptionsOverride?.now ?? Date.now`；`createInProcessMcpProbeRunner()`
  每次探测把 `{ ...probeOptionsOverride, startedAt }` 交给 `probeMcp`；`composeMcpProbeOperations({ …, probeRunner })` 的探测开始时间取
  `mcpProbeNow`。`ProbeOptions`（`infrastructure/mcpProbe.ts`）只有用例会给：客户端工厂 `openClient`、时钟 `now`、总时限 `totalTimeoutMs`。
- **三处读者**：
  - 进程内探测执行器：单机的 MCP 诊断（`composition/mcpDiagnostics.ts` 的 `bindMcpDiagnosticsRuntime`）交出
    `probeRunner: createInProcessMcpProbeRunner()`；托管部署（`crewstationMcpDiagnostics.ts`）换成 `createHostedMcpProbe(…)`，不读选项。
  - 探测用例：daemon 的 HTTP 组装（`bootstrap/daemonHttpComposition.ts`）以 `composeMcpProbeOperations({ …, probeRunner: mcpRuntimeTests.probeRunner })`
    建探测用例。
  - MCP 写入时钟：daemon 的资源目录模块（`bootstrap/daemonModules/resourceCatalog.ts`）的 `nextMutationTimestamp` 以 `mcpProbeNow()` 为当前时刻
    推出下一个因果时间戳——探测与写入共用一条时间线。
- **组合根**：`bootstrap/daemonApplication.ts` 先组 observation 模块（MCP 诊断在其中，经 `input.adapters.mcpDiagnostics(…)` 取部署的选择），
  再组资源目录模块，HTTP 组装收这两组模块；用例的测试接缝经 `DaemonApplicationTestSeams`（`testSeams`）交进来（同类的
  `mcpRuntimeTestDependencies` 已走这条路）。
- **用例**：`routes/mcps-probe`、`rfc201-mcp-exact-operation`、`rfc223-pr9-cross-tenant-adversarial` 在应用建好后调
  `__setMcpProbeOptionsForTesting(…)` 换客户端工厂与时钟，`afterEach` 清空；`rfc448-mcp-probe-into-resource-catalog` 在组合层直接测
  `mcpProbeNow()` 与 `composeMcpProbeOperations`。`rfc370-hosted-mcp-probe` 与 `rfc525-resource-catalog-required-selections-boundary` 钉着
  `createInProcessMcpProbeRunner()` 与 `{ ...probeOptionsOverride, startedAt }` 的原文。

## 2. 机制与落位

落在 resource-catalog 的 composition 层（探测环境与执行器）与 bootstrap（组合根建一份、往下交）；不新增跨上下文依赖。

### D1 探测环境

- `mcpProbeOperations.ts` 删去模块级变量、`__setMcpProbeOptionsForTesting` 与 `mcpProbeNow`，改为：
  - `McpProbeEnvironment`（只读：`now(): number`、`options(): ProbeOptions | undefined`）与
    `createMcpProbeEnvironment(options?: () => ProbeOptions | undefined)`——`now()` 取选项里的时钟、否则 `Date.now`，选项每次调用时读取；
  - `createInProcessMcpProbeRunner(environment)`——每次探测把 `{ ...environment.options(), startedAt }` 交给 `probeMcp`（与此前每次读接缝同义）；
  - `composeMcpProbeOperations({ …, now })`——探测开始时间取交进来的时钟。
- `composition.ts` 的转出随改：删去两个名字，转出 `createMcpProbeEnvironment` 与 `McpProbeEnvironment`。

### D2 组合根建一份、往下交

- `daemonApplication.ts` 每份应用建一份环境：`createMcpProbeEnvironment(input.testSeams?.mcpProbeOptions)`（`DaemonApplicationTestSeams` 多一项
  `mcpProbeOptions`；生产没有测试接缝，得到默认客户端与 `Date.now`），交给：
  - observation 模块 → MCP 诊断选择的输入多一项 `probe`，`bindMcpDiagnosticsRuntime` 以它建进程内执行器；托管部署仍选自己的执行器；
  - 资源目录模块 → `nextMutationTimestamp` 取 `mcpProbe.now()`；资源目录模块把同一份环境交出（`mcpProbe`）；
  - HTTP 组装 → `composeMcpProbeOperations({ …, now: resourceCatalog.mcpProbe.now })`。

### D3 用例与锁

- 新增 `tests/rfc538-mcp-probe-environment-boundary.test.ts`，登记 guard-manifest：① `mcpProbeOperations.ts` 顶层没有 `let` 与集合、架构报告的
  模块级可变单例判据为空；生产代码不再引用删去的名字；`createMcpProbeEnvironment(` 在生产里只在 `daemonApplication.ts` 调一次，
  `createInProcessMcpProbeRunner(` 每处调用都带环境实参（语料下限 3,000）；② 行为：两份环境各用各的选项与时钟、选项每次探测时读取、
  没有选项时取 `Date.now`；探测用例的开始时间取交进来的时钟；③ 带负对照。
- 读旧形状的用例随改：provider HTTP 测试助手的选项多一项 `mcpProbeOptions`，经 `testSeams` 交给应用；三个 HTTP 用例把选项放在用例自己的
  作用域里交给应用、每个用例后清空；`rfc448` 改为直接给环境与时钟；`rfc370-hosted-mcp-probe`、`rfc525` 的锁改钉新的原文与实参。

## 3. 清单（退出门）

| 名字                                                                      | 之后                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------- |
| `probeOptionsOverride` / `__setMcpProbeOptionsForTesting` / `mcpProbeNow` | 删去；`createMcpProbeEnvironment(options?)`       |
| `createInProcessMcpProbeRunner()`                                         | 改为 `createInProcessMcpProbeRunner(environment)` |
| `composeMcpProbeOperations({ …, probeRunner })`                           | 多一项 `now`                                      |

## 4. 用例

- ① ～ ③ 见 D3；既有用例覆盖探测的路由、精确操作、跨租户隔离与托管执行器的选择。

## 5. 失败模式

- **三处拿到的不是同一份环境**：探测的开始时间与写入的因果时间戳落到两条时间线上，新鲜度判断可能把旧结果当新。RFC-538 用例钉组合根只建
  一份，并按源码核对三处都取这一份；既有的精确操作用例（时钟注入后探测与写入的先后）兜底。
- **用例忘了清空选项**：选项随应用走，应用随用例关闭，残留只影响同一份应用里后续的用例；三个 HTTP 用例照旧在每个用例后清空。

## 6. 取舍（可推翻）

1. **环境由组合根建、经 `testSeams` 交选项，而不是让用例改执行器**：选项同时影响执行器与时钟，两者要同一份；`testSeams` 是应用接受用例替身的
   既有入口（`mcpRuntimeTestDependencies` 同路）。
2. **选项是读取函数而不是一次性的值**：用例在应用建好后、每个用例里换客户端工厂，读取函数让它们不必重建应用（与此前每次探测读接缝同义）。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层只把依赖往下交（组合根建环境）。**C11**：各模块 public 不变（resource-catalog 的组合转出换名）。**C12**：RFC-538 用例覆盖。
  **C13**：计数不升，模块级可变单例 56 → 55。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第六步（MCP 探测的测试接缝，1 条）。
- **留下**：其余 55 条（可迁移的登记与绑定 19 条；凭据 / 访问 / 完整性相邻的 9 条；进程级缓存与计数器 27 条须经用户确认是否保留并修订
  §14 口径）。
