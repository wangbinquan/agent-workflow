# RFC-491 技术设计

落在 task-execution（本机调用与准备、本机任务代理族与系统代理运行、MCP 诊断的本机执行体、托管准备、诊断读端与两个 composition）、
runtime-management（public 查询、两个本机实现、本机驱动的选择、材料定义）、shared（声明清单的纯构造）与 bootstrap（绑定）。按 RFC-294
design §3.1：task-execution → runtime-management 在 DAG 上，只经 `public/` 或 task-execution 自有、由 bootstrap 绑定的提供者；
runtime-management 不反向依赖上层业务 context。

## 1. 现状（HEAD `87cd1228f`，源码实读）

**task-execution 取一族的 16 个生产文件**，按用途分五组：

1. **只取类型**（8 个文件）：
   - `infrastructure/crewstation/runtimeEvents.ts:2` 取 `NormalizedEvent`、`NormalizedTokenDelta`（一族从 runtime-management
     `public/participants` 转出）；
   - `infrastructure/runtimeInventoryRead.ts:44` 与 `local/nativeTaskAgentRunOptions.ts:74` 取 `RuntimeKind`（与 runtime-management
     `public/types` 的同名类型同形）；
   - `local/nativeRunFamilyProviders.ts:16-17`、`local/nativeTaskAgentPluginLoadDiagnostics.ts:2`、`local/nativeTaskAgentRunOptions.ts:82-83`
     与 `infrastructure/taskExecutionResources.ts:18` 取 `RuntimePlugin`（一族从 resource-catalog `public/types` 转出）与 `ResolvedSkill`
     （resource-catalog 的 `NativeSkillContent` 加一个可选的版本重读）；
   - `local/agentInvocation.ts:21`、`local/agentInvocationPreparation.ts:10` 取 `SpawnPlan`、`AgentSpawnPlan`（编译出的本机计划）；
   - `local/systemAgentRunFamily.ts:7` 取 `SystemAgentRunOptions`、`SystemAgentRunResult`（`services/systemAgentRun.ts` 的入参与结果，本机
     系统代理族的夹具按它们的形状）。
2. **驱动的静态事实**（3 个文件）：
   - `composition/nodeRunRuntime.ts:1,29` 把 `isKnownRuntimeKind` 交给节点运行的运行时持久化；
   - `composition/agentNodeExecution.ts:255` 以 `getRuntimeDriver(protocol).detectSessionNotFound?.(stderr)` 判断续会话目标不存在；
   - `infrastructure/runtimeInventoryRead.ts:142-143` 按 `isKnownRuntimeKind` 归一种类（NULL 与未知按 opencode），再读
     `getRuntimeDriver(kind).capabilities`；
   - 托管准备 `crewstation/agentInvocationPreparation.ts:262` 也读 `getRuntimeDriver(intent.protocol).capabilities`（见第 3 组）。
3. **声明清单的纯构造**（2 个文件）：`crewstation/agentInvocationPreparation.ts:26,234-262` 用 `emptyDeclaredManifest`、`declareSkills`；
   `crewstation/nativeMaterial.ts:13-16,76-111` 用 `emptyDeclaredManifest`、`partitionMcpsForInjection`、`declareSkills`。这些函数在
   `services/execution/agentInjection.ts`，只依赖 shared 的 `DeclaredInjectionManifest`、`Mcp`；runtime-management 的本机材料
   （`opencodeAgentMaterial.ts`、`claudeAgentMaterial.ts`）与一族自己（`selfCheck.ts`、`claudeCode/config.ts`）也用。
4. **两个本机实现**（2 个文件）：
   - `local/taskRuntimeInventoryContent.ts` 实现 task-execution 自有的 `TaskRuntimeInventoryContent`：按 `runRootFor(taskId, nodeRunId)`
     读 opencode 清单文件（`readSnapshotFromRunDir`）。经 `composition/taskRuntimeInventoryContent.ts` 交出，`bootstrap/standalone.ts:124`
     绑定。
   - `local/nativeTaskAgentPluginLoadDiagnostics.ts`：按 opencode 的插件加载错误格式扫 stderr，经 `pluginFileSpec` 把 `file://` 定位映射回
     插件名。本机任务代理族（`local/taskAgentRunFamily.ts:183`）逐行调用，插件列表在调用时经 resource-catalog 的内容读取现取。
5. **本机兼容运行**（3 个文件）：
   - `local/mcpDiagnosticRunner.ts`（RFC-488 迁入）：经 `runSystemAgent` 跑一轮；`localMcpDiagnosticRunOptions` 用驱动的
     `mcpTestSessionReference`，`verifyLocalMcpDiagnosticTurn` 用驱动的 `capabilities` 与 `readInventory`；会话支持、原生会话号与默认
     可执行文件也直接取驱动。`bootstrap/daemonModules/observation.ts:110` 构造，6 个用例直接构造。
   - `local/nativeTaskAgentRun.ts`、`local/nativeTaskAgentRunOptions.ts`：只供 RFC-370 契约用例（`tests/helpers/runner.ts`）；在
     `rfc376-structural-guards` 的不可达生产文件清单里（继任写作「RFC-370 closure」，RFC-370 已 Done）。前者另有一对指向 source-control
     `composition/agentWorkspaceGitControl.ts` 的跨 context 内部文件对。

**一族指回 task-execution 的两条边**（只有这两个文件取 task-execution）：

- `services/systemAgentRun.ts`：`runSystemAgent` 取驱动装配（`buildSpawn`，带 `buildCtx` / `wrapPlan` / `testPlanOverride` 三个缝）、
  材料工作区、`bindNativeAgentProtocol`（runtime-management infrastructure）、运行证据与材料引用，再交给 task-execution 的
  `bindNativeAgentInvocation` 与 application 的 `runSystemAgentCore`。生产里只有 MCP 诊断的本机执行体调用它；另转出一族的
  `releaseSystemAgentScratch`、`assertSafeSeedPath` 与 application 的 `classifyMissingEnvelope`、`emptySystemAgentOutputEvidence`。
  30 个用例文件（含 3 个 helper）import 它，多数只取类型与 `emptySystemAgentOutputEvidence`，2 个调用 `runSystemAgent`。
- `services/runtimeSmoke.ts`：`smokeRuntime` 同样组装后交给 application 的 `runRuntimeSmokeCore`。生产里没有调用方：探测的生产路径是
  RFC-422 起的本机探测族；runtime-management 的 `RuntimeDiagnosticDependencies.smokeRuntime`（`runtimeManagementEffects.ts:15-17`）只是
  夹具缝，取值只来自用例（`tests/helpers/runtimeOpencodeFixture.ts`），runtime-management 只取它的类型 `SmokeOptions`、`SmokeResult`。
  `SmokeResult` 与 runtime-management `public/types` 的 `RuntimeSmokeResult` 同形。

R1（遗留文件取模块内部，`architecture/commons-debt.json`）18 条里 9 条出自这两个文件。

## 2. 机制与落位

### D1 类型

- `NormalizedEvent`、`NormalizedTokenDelta` 改取 runtime-management `public/participants`；`RuntimeKind` 改取 `public/types`；
  `RuntimePlugin` 改取 resource-catalog `public/types`。都是一族原样转出的同一个声明。
- `ResolvedSkill` 改为 resource-catalog 的 `NativeSkillContent`：task-execution 不读版本重读（`readContentVersion` 由 runtime-management 的
  本机编译器自己补），少这一个可选成员的类型可以赋给编译器要的 `ResolvedSkill`。
- 编译出的本机计划由 task-execution 自有（`local/agentInvocation.ts`）：`NativeAgentPlan` 列 task-execution 读到的成员（命令、环境、
  stdin、`beforeSpawn`、`cleanup`、`declaredMcpServers`、`diagnostics`），`NativeAgentCompiledPlan` 另加 `declared`。不放进
  runtime-management 的 public：成员里有函数类型与 `Record<string, unknown>`，类型污染检测会把它们记成新的偏差（design §3.2 要求清单为空）。
- 系统代理运行的入参与结果随运行器迁入 task-execution（D5），本机系统代理族改取同目录的声明；bootstrap 经 task-execution 的 composition
  取类型。

### D2 驱动的静态事实：runtime-management 的 public 查询

runtime-management 新增 `infrastructure/runtimeProtocolFacts.ts`，经 `public/queries` 交出三个纯查询（与既有的
`isRuntimeMcpTestEligible` 同一做法）：

- `isKnownRuntimeKind(value)`：种类注册表的判定（一族同名函数）；
- `runtimeDriverCapabilities(kind)`：驱动的静态能力（`getRuntimeDriver(kind).capabilities`）；
- `detectRuntimeSessionNotFound(kind, stderrTail)`：`getRuntimeDriver(kind).detectSessionNotFound?.(stderrTail)`，接收者仍是驱动。

都不碰 IO，读的是 runtime-management 自己的种类注册表与驱动的静态表态（design §3.4 runtime-management 对外的「inventory / status /
probe 视图」）；未知种类时与原来一样由 `getRuntimeDriver` 抛错，读取时点不变。节点运行的运行时持久化、`agentNodeExecution` 的续会话判据、
诊断读端与托管准备改取它们。

### D3 声明清单的纯构造：shared

shared 新增 `declaredInjection.ts`：`emptyDeclaredManifest`、`partitionMcpsForInjection`（含 `McpInjectionPartition` 与它抛的
`AgentInjectionError`）、`managedSkillsOf`、`declareSkills`，原样迁自 `services/execution/agentInjection.ts`。它们只依赖 shared 的类型，与
RFC-463 迁入 shared 的启动核验（`startupVerification.ts`）用同一份清单类型。`agentInjection.ts` 自己的渲染改从 shared 取；一族、
runtime-management 与用例的导入改指 shared，不留转出。`declarePlugins` 等依赖 resource-catalog 类型的留在原处。

### D4 两个本机实现归 runtime-management

- **启动清单读取**：`local/taskRuntimeInventoryContent.ts` 原样迁到 runtime-management `infrastructure/local/`，经新的
  `composition/taskRuntimeInventoryContent.ts` 交出（不 import task-execution 的端口类型，返回类型按端口结构写出）；`bootstrap/standalone.ts`
  改从 runtime-management 取，绑给 task-execution 自有的 `TaskRuntimeInventoryContent`。task-execution 的 composition 转出删除。design §3.1
  增一条虚线（runtime-management 实现 task-execution 的 `TaskRuntimeInventoryContent`）。运行根的布局（`<appHome>/runs/<task>/<nodeRun>`，
  runtime-management 的材料工作区同一规则）与 opencode 清单文件的读法都是 runtime-management 的知识。
- **插件加载失败识别**：`local/nativeTaskAgentPluginLoadDiagnostics.ts` 原样迁为 runtime-management 的
  `infrastructure/local/pluginLoadDiagnostics.ts`（opencode 的 stderr 格式与插件定位的投影），经 `composition/localAgentMaterial.ts` 交出。
  本机任务代理族的提供者增 `pluginLoadFailures`（task-execution 自有类型），bootstrap 绑定；每一行仍在调用时经 resource-catalog 的内容读取
  现取插件列表。与原来一样不分协议。

### D5 本机系统代理运行归 task-execution

- `services/systemAgentRun.ts` 迁为 task-execution `infrastructure/local/nativeSystemAgentRun.ts`。按 proposal C10：用例核心早已在
  application（`runSystemAgentCore`），这个文件是本机装配与绑定的适配器，落 infrastructure。
- `createNativeSystemAgentRun(providers)` 返回原来的 `runSystemAgent(opts)`，提供者（task-execution 自有类型，`local/nativeRunFamilyProviders.ts`）：
  - `drivers`：本机驱动窗口 `NativeRuntimeDriver`，只列用到的成员——`capabilities`、`buildSpawn`、`defaultBinary`、`readInventory`、
    `createMcpTestNativeSessionId`、`mcpTestSessionReference`。装配的入参 `NativeSpawnRequest` 只列本机系统代理运行与 MCP 诊断写的字段，
    可以赋给驱动的 `AgentSpawnContext`。runtime-management 经 `composition/localAgentMaterial.ts` 交出 `selectNativeRuntimeDriver`；
  - `materialWorkspaces`：材料工作区的请求增 `system` 一种（父目录、特性名、scratch 名、种子文件），交回的位置增 `root`；
  - `materialDefinitions`：协议、运行证据与材料引用。材料引用增可选的来源计划（`materialReference(plan, sourcePlan?)`，即
    `bindNativeAgentMaterialReference` 的两参形式），包裹后的计划沿用原计划的引用。
- 与原来逐项相同：驱动在运行开始时取（未知协议同样在那里抛错），材料定义随后选；装配、包裹、夹具计划与声明清单的取法不变；协议即
  `bindNativeAgentProtocol(driver)`，运行证据即 `createLocalAgentMaterialEvidence({ hooks: driver, scope })`，材料引用读同一张
  WeakMap。
- MCP 诊断的本机执行体改为 `createLocalMcpDiagnosticRunner(input, providers)`：没有夹具时跑 `createNativeSystemAgentRun(providers)`；
  `localMcpDiagnosticRunOptions` 与 `verifyLocalMcpDiagnosticTurn` 另收 `drivers`；会话支持、原生会话号与默认可执行文件经窗口。bootstrap 在
  `runFamilyProviders.ts` 声明本机系统代理运行的提供者与 MCP 诊断的选择，`daemonModules/observation.ts` 取它。
- 不再经它转出：一族的 `releaseSystemAgentScratch`、`assertSafeSeedPath` 与 application 的 `classifyMissingEnvelope`、
  `emptySystemAgentOutputEvidence`，用例改取各自的出处。

### D6 只供用例的运行器移出生产

- `services/runtimeSmoke.ts` 迁为 `tests/helpers/nativeRuntimeSmoke.ts`，内容不变。runtime-management 的探测夹具缝改用自己的类型：入参
  `RuntimeSmokeFixtureOptions`（协议、可执行文件或命令头、配置、模型、额外参数、兼容标记，与它构造的字段一致），结果即 public 的
  `RuntimeSmokeResult`。`MODEL_FAIL_SIGNATURES` 的用例改取 application。
- `local/nativeTaskAgentRun.ts`、`local/nativeTaskAgentRunOptions.ts` 迁入 `tests/helpers/`，内容不变（相对导入改为别名）。RFC-375
  留下它们是因为 RFC-370 的契约用例在用；契约用例照用，只是不再算生产文件。

## 3. 账本与计数

- 跨 context 内部文件对 22 → 21：`nativeTaskAgentRun.ts` → source-control 的一对随文件移出生产，`rfc328-architecture-guards`、
  `rfc376-structural-guards`、`rfc294-architecture-preflight` 三份精确账本各销一对；`counts.json` 收紧。
- R1 18 → 9：`commons-debt.json` 删去两个文件的 9 条。
- 不可达生产文件 18 → 16：`rfc376` 的清单与继任表删去两个文件；`counts.json` 收紧。
- `legacy-horizontal-files`、`legacy-service-implementations`、`composition-control-flow-task-execution` 等触及的计数收紧到实测；public 类型
  污染（57）与未消费 public 符号不升（三个新查询都有 task-execution 消费）。
- design §3.1 与 `rfc294Target.ts` 增一条虚线（目标边 104 → 105），`rfc294-design-parity` 随之。本机驱动窗口、插件加载失败识别、
  系统工作区与来源计划都在既有的「runtime-management 实现 `NativeRunFamilyProviders`」虚线之内。
- `architectureReport.ts` 的遗留路径目标表删去两个已不存在的文件。
- `windows-platform.yml`、`integration-opencode.yml` 的路径过滤改指新位置；按 `git ls-files` 扫全仓旧路径。

## 4. 用例

新增 `rfc491-te-runtime-family-decoupling-boundary`（AST，带负对照，登记 guard-manifest）：

- ① task-execution 的全部生产文件不 import 一族（相对路径、`@/` 别名、re-export、动态 import、type-only 都认，负对照）；
- ② 一族的全部文件不 import task-execution；`services/runtimeSmoke.ts`、`services/systemAgentRun.ts` 与两个本机任务运行文件不在 `src/`；
- ③ 三个静态事实只在 runtime-management 声明、经 `public/queries` 交出，task-execution 的四个使用方取它们；
- ④ 声明清单的四个构造只在 shared 声明一次，`agentInjection.ts` 不再声明；
- ⑤ 两个本机实现在 runtime-management，bootstrap 绑定；task-execution 的 composition 转出删除；
- ⑥ 本机系统代理运行在 task-execution `infrastructure/local/`、不 import runtime-management 内部；MCP 诊断收提供者；bootstrap 声明
  提供者与选择；两份 Windows 路径过滤登记新位置；
- ⑦ 行为对拍：三个查询与驱动直取一致（两种协议与未知种类）；材料引用的来源计划形式与 `bindNativeAgentMaterialReference` 一致；
  插件加载失败识别、启动清单读取与原实现一致。

既有用例：import 改指新出处；构造 MCP 诊断执行体与调用 `runSystemAgent` 的用例改取 bootstrap 的提供者；本机任务代理族的假提供者补
`pluginLoadFailures`；RFC-487、RFC-488 用例里对两个已迁走文件的引用改指新位置。

## 5. 失败模式

- 提供者漏传：都是必填，`tsc` 保证每个装配点都传了（bootstrap、用例各处）。
- 结构类型不兼容：task-execution 的计划、装配入参与驱动窗口按驱动的声明逐字段写出，bootstrap 的绑定点由 `tsc` 校验。
- 漏改的旧路径：集中验证按 `git ls-files` 扫全仓（含 workflow 的 `paths:` 与账本锚点）。

## 6. 取舍（可推翻）

1. **静态事实走 public 查询，不另立端口**：task-execution → runtime-management 在 DAG 上；三个读取是 runtime-management 的种类注册表与
   驱动静态表态的纯函数，正是 public 查询的形态（`isRuntimeMcpTestEligible` 先例）。另立 task-execution 自有端口要穿过节点执行、节点运行
   持久化、诊断读端与托管准备四条装配链，换来的只是同一个纯读取。
2. **本机计划与驱动窗口由 task-execution 自有**：编译出的计划与驱动的装配入参带函数成员，进 runtime-management 的 public 会新增类型污染；
   task-execution 只列自己读写的成员，结构上由 bootstrap 的绑定校验。
3. **声明清单的构造归 shared，不归 runtime-management**：托管准备与本机材料都用，函数只依赖 shared 的类型；放进 runtime-management 要么
   再开 public，要么让托管准备另走提供者。与 RFC-463 的启动核验同包。
4. **对 RFC-294 plan §4.7 表的偏离**：表把 `runtimeSmoke.ts` 列在一族里归 runtime-management，`systemAgentRun.ts` 列为随一族。两者都取
   task-execution 的本机调用与 application，而 runtime-management 不反向依赖上层 context（design §3.1）：前者只剩用例在用，迁入
   `tests/helpers/`；后者是 task-execution 的本机运行器，归 task-execution。`architectureReport.ts` 的遗留路径目标表本就把
   `systemAgentRun.ts` 记为 task-execution。
5. **只供用例的运行器移出生产，不改经提供者**：它们没有生产调用方（架构门的不可达清单与夹具缝的取值都印证），改经提供者只会给不可达的
   生产文件加装配；迁入 `tests/helpers/` 后契约用例照用（RFC-466、RFC-467 同一做法）。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁入的本机系统代理运行是适配器（用例核心在 application），落 infrastructure；不新增用例入口。
- **C11**：public 只增三个纯查询，不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-491 用例覆盖 task-execution 全部生产文件与一族全部文件（下限在 guard-manifest 写明）、指定的 runtime-management、shared、
  bootstrap 与 workflow 文件；只对这些范围宣告退出门。
- **C13**：触及的计数收紧到实测。
- **§14 / §4.7**：之后 task-execution 与一族互不 import；一族之外只有 runtime-management 与 bootstrap 用它，整族迁入另立。
