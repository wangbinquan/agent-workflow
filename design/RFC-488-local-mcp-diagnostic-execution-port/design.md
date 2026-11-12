# RFC-488 技术设计

落在 resource-catalog（端口与本机执行体）、task-execution（端口的本机实现，infrastructure + composition）与 bootstrap（绑定）。按
RFC-294 design §3.1，consumer 自有端口由 provider 实现、bootstrap 注入，画成虚线；本 RFC 新增一条。

## 1. 现状（HEAD `15f7a86d4`，源码实读）

**本机执行体**：`modules/resource-catalog/infrastructure/local/mcpDiagnosticsEffects.ts`（425 行）。

- 一族的三条 import：第 12 行 `getRuntimeDriver`（`services/runtime`），第 13 行 `AgentSpawnContext`、`AgentSpawnPlan`、`SpawnPlan` 类型
  （`services/runtime/types`），第 14～18 行 `runSystemAgent` 与 `SystemAgentRunOptions`、`SystemAgentRunResult`（`services/systemAgentRun`）。
- 依赖里两处一族类型：第 46～50 行 `observe` 返回 `SystemAgentRunOptions['observe']`；第 59 行测试夹具 `runFn` 的签名。
- 运行时相关的工作：
  - 第 147 行 `supportsSession`：驱动有没有 `mcpTestSessionReference`；
  - 第 148～149 行 `createNativeSessionId`：驱动的 `createMcpTestNativeSessionId`；
  - 第 196～209 行 `resolveRuntime` 里的支持判定与可执行文件：登记的 `binaryPath`，缺省取驱动的 `defaultBinary(config)[0]`；
  - 第 286～400 行 `runTurn`：`runFn ?? runSystemAgent`。真运行用 `buildCtx` 组装启动上下文（注入只有这一个 MCP、诊断代理的人设、
    运行参数、`configDir` 缺省取 `DEFAULT_CONFIG_DIR_PROFILE`、驱动的 `mcpTestSessionReference`、`nodeRunId` 用轮次号），`wrapPlan` 只包两处
    （轮次结束删 `mcp-config.json`；启动前先过驱动的 `beforeSpawn` 再过闸）；假运行用 `testPlanOverride` 给最小计划。观测与续会话只在
    真运行且给了 `observe` 时带上，续会话还要轮次号大于 1 且会话已有原生会话号；
  - 第 100～131 行启动校验：只对真运行的成功轮次做；按驱动的观测能力取启动清单（文件型运行时惰性读轮次目录下的清单），声明清单缺失时
    报错，再交 `verifyStartup`。
- resource-catalog 自己的工作（不动）：计时器与时钟、工作区目录布局（`<appHome>/mcp-runtime-tests/<会话号>`）与清理、`currentMcpHash`、
  界面事件、按 pid 回收进程树与恢复隔离、启动回执（`captureTurnStart` 在拿到 pid 时调持久化的 `recordSpawn`，被拒则抛错阻止下发提示）、
  运行时行的校验与快照。

**托管形态**：

- resource-catalog 的 `application/ports/mcpDiagnosticExecution.ts` 声明 `McpDiagnosticExecution`，经 `composition/required-ports.ts` 转出；
- task-execution 的 `composition/crewstationMcpDiagnosticRunner.ts` 实现（会话、命名、清理、恢复在
  `infrastructure/crewstation/mcpDiagnosticSessions.ts`），每轮经 task-execution 的 `runSystemAgentCore` 跑；
- `bootstrap/crewstation.ts:311-320` 把它交给 resource-catalog 的 `createCrewStationMcpDiagnostics`；
- `composition/crewstationMcpDiagnostics.ts:45-49`：给了测试夹具 `runFn` 就退回本机装配。

**装配**：

- `bootstrap/daemonModules/observation.ts:57-99` 调部署档案选中的 `mcpDiagnostics`（standalone 是 resource-catalog 的
  `composeLocalMcpDiagnostics`），把测试接缝 `mcpRuntimeTestDependencies`（`runFn`、`now`、`capacity`）原样摊进依赖；
- 测试接缝的类型在 `bootstrap/daemonApplication.ts:192-196`，`runFn` 用一族的类型。

## 2. 机制与落位

**端口（resource-catalog `application/ports/localMcpDiagnosticExecution.ts`）**

```ts
type Protocol = McpRuntimeTestSessionRecord['runtimeProtocol']

export interface LocalMcpDiagnosticExecution {
  /** 驱动能否把一个 MCP 诊断会话接到下一轮。 */
  supportsSession(protocol: Protocol): boolean
  /** 需要自己生成原生会话号的协议给一个新号，其余为 null。 */
  createNativeSessionId(protocol: Protocol): string | null
  /** 登记的可执行文件，缺省取协议按配置的默认值；都没有时为 undefined。 */
  executable(
    protocol: Protocol,
    registered: string | null,
    configuration: LocalMcpDiagnosticBinaryConfiguration,
  ): string | undefined
  /** 跑一轮诊断；结果自带启动校验。 */
  run(request: LocalMcpDiagnosticTurnRequest): Promise<McpDiagnosticRunResult>
}
```

- 请求带：
  - 协议、工作区（父目录与会话号）、轮次（号、序号、提示词）、被测 MCP；
  - 诊断代理的人设（名字与系统提示词）与事件上限；
  - 运行参数（可执行文件、模型、variant、temperature、steps、maxSteps、`isSandbox`、`configDir` 两项）与会话已有的原生会话号；
  - 可选的观测与续会话号、时限、中止信号、事件接收端；
  - 两个钩子：`beforeSpawn`（启动前过闸）与 `onSpawned`（拿到 pid 的启动回执）。
- 端口只用 resource-catalog 自己的类型：协议取会话记录的字段类型，观测取托管端口里同形的观测类型，事件接收端与结果是
  `McpDiagnosticEventSink`、`McpDiagnosticRunResult`。不新增指向 runtime-management 的类型边。
- 诊断代理的名字、系统提示词与事件上限仍是 resource-catalog domain 的常量，由本机执行体放进请求；实现方不 import resource-catalog。

**本机执行体（resource-catalog，原文件改写）**

- 依赖增必填的 `execution: LocalMcpDiagnosticExecution`，删 `runFn`；`observe` 的返回类型改为端口的观测类型。
- `supportsSession`、`createNativeSessionId` 直接调端口。`resolveRuntime` 的支持判定与可执行文件改调端口，错误码、文案与次序不变：
  未登记 → 已停用 → 不支持 → 没有可执行文件。
- `runTurn` 组请求、调 `execution.run`。观测在给了 `observe` 时带上；续会话号在给了 `observe`、轮次号大于 1、会话已有原生会话号时
  带上（与此前同一条件）。`onSpawned` 取 `captureTurnStart` 登记的回执。
- 删除本地的启动校验函数，它随运行一起移到实现方。

**本机实现（task-execution `infrastructure/local/mcpDiagnosticRunner.ts`）**

- `createLocalMcpDiagnosticRunner(input: { fixture?: { runFn } })` 结构上实现端口：
  - `supportsSession`、`createNativeSessionId`、`executable` 取驱动，与原第 147～149、196～209 行同式；
  - `run` 用夹具的 `runFn` 或 `runSystemAgent`，选项与原第 287～400 行逐项相同：
    - 真运行：`buildCtx`、`wrapPlan`、观测与续会话；
    - 假运行：`testPlanOverride`；
  - 启动校验与原第 100～131 行同式，只对真运行的成功轮次做。
- `composition/localMcpDiagnosticRunner.ts` 交出它（与 `crewstationMcpDiagnosticRunner.ts` 对称）。task-execution 对一族的 import 是现状
  允许的方向，随 task-execution 那一步改走 runtime-management。

**绑定（bootstrap）**

- `daemonModules/observation.ts` 建出本机实现：测试接缝给了 `runFn` 就作为夹具，其余接缝（`now`、`capacity`）照旧摊进依赖。实现以
  `execution` 交给诊断装配。给了夹具时 bootstrap 直接用 resource-catalog 的本机装配，不论部署档案。
- 测试接缝的类型改取 task-execution composition 交出的夹具类型。
- `createCrewStationMcpDiagnostics` 删去按 `runFn` 退回本机装配的分支：它只做托管形态，选择归 bootstrap。

**登记**：RFC-294 design §3.1 增虚线 `TE -. "implements LocalMcpDiagnosticExecution" .-> RC`，`tests/architecture/rfc294Target.ts` 的
`REQUIRED_CONTEXT_EDGES` 增同一条（`rfc294-design-parity` 两向比对）。

## 3. 账本与计数

- RFC-487 用例 ① 的例外清单收到空：四个 context 对一族都是零。
- 跨 context import：
  - resource-catalog 删去指向一族的三条（两条值、一条类型）；
  - task-execution 的新实现指向一族；
  - bootstrap 指向 task-execution composition；
  - 本机执行体改指 resource-catalog 自己的端口（context 内）。

  越 DAG 的值边与 offered 文件对不升（端口不 import runtime-management）。

- consumer 自有端口增 1（`LocalMcpDiagnosticExecution`）；public surface 不增（端口在 `application/ports`，只经 `required-ports` 转出）。
- `counts.json` 60 项不升，触及的收紧到实测（C13）。

## 4. 用例

`rfc488-local-mcp-diagnostic-execution-boundary`（AST，带负对照）：

1. resource-catalog 的全部生产文件（语料下限 350）不 import 一族。相对路径、`@/` 别名、re-export 与动态 import 都认。
2. 本机执行体只经端口做运行时相关的工作：
   - 文件里不出现 `getRuntimeDriver`、`runSystemAgent`、`buildCtx`、`wrapPlan`、`testPlanOverride`、`observationForVerification`；
   - 依赖收 `execution`、不收 `runFn`；
   - 端口只在 resource-catalog 的 `application/ports` 声明一次，经 `required-ports` 转出。
3. 本机实现在 task-execution 的 `infrastructure/local`，经 composition 交出；bootstrap 的观测模块用它绑定；CrewStation 的诊断装配不再
   出现 `runFn`。
4. 行为对拍（本机实现的单元用例）：
   - 真运行时交给 `runSystemAgent` 的启动上下文与包裹逐字段等于此前的组装；
   - 假运行给最小计划并过闸；
   - 观测与续会话的条件；
   - 启动校验：成功才校验、声明清单缺失报错、假运行不校验；
   - `executable` 的登记优先与缺省。

RFC-487 用例 ① 的例外清单改为空。既有用例按新装配改指（本机诊断的服务用例、配置用例、家族用例、HTTP 与守护进程身份用例、两条
rfc359-w29、rfc364、`providerHttpApplication`），断言意图不变。

## 5. 失败模式

- 遗漏：resource-catalog 仍取一族 → 第 1 条与 RFC-487 ① 红。
- 行为偏移：启动上下文或包裹少字段、观测或续会话条件变了 → 第 4 条与本机诊断服务用例红。
- 装配漏传：`execution` 是必填，`tsc` 报缺。夹具没接上 → 用夹具的服务用例走真运行，在找不到可执行文件处红。

## 6. 取舍（可推翻）

- **一个端口收下全部运行时相关的工作，由 task-execution 实现**：与托管形态对称（托管的执行由 task-execution 实现）。跨轮会话支持、原生
  会话号与可执行文件也是驱动知识，本可由 runtime-management 另给一个端口；但本机实现本来就要取驱动来组装启动上下文与做启动校验，分成
  两个端口只多一次绑定。task-execution 取驱动的地方随 task-execution 那一步统一改走 runtime-management。
- **夹具随实现走**：夹具的参数就是一族的运行选项，resource-catalog 声明不了它；放进实现的输入，测试与 bootstrap 建实现时带上。
- **按夹具选本机装配的决定归 bootstrap**：CrewStation 的诊断装配原来按 `runFn` 退回本机装配，现在 resource-catalog 已经看不到 `runFn`。
  选择本来就是装配者的事。
- **`services/systemAgentRun.ts` 留在原处**：本 RFC 后它只剩 task-execution 一个值使用方，去向随整族迁入一并定。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：
  - 端口在 resource-catalog 的 `application/ports`；
  - 运行时相关的执行在 task-execution 的 `infrastructure/local`，由 composition 交出；
  - 选择与绑定在 bootstrap；
  - resource-catalog 的本机执行体只做 resource-catalog 自己的工作。
- **C11**：public surface 不增；consumer 自有端口增 1，登记虚线。
- **C12**：RFC-488 用例覆盖 resource-catalog 全部生产文件（≥350）、本机执行体、实现与 bootstrap 的绑定点，以及本机实现的行为。
- **C13**：触及的减速带收紧到实测。
