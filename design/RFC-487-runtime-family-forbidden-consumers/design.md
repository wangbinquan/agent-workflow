# RFC-487 技术设计

本 RFC 落在 RFC-294 design §3.1 的 context DAG 上：memory、resource-catalog、source-control、system-operations 四个 context 不消费
runtime-management，它们对运行时驱动一族的四处使用改到各自 owner 的合同上。路径相对 `packages/backend/src/`。

## 1. 现状（HEAD `f74014135`，源码实读）

**memory**：`modules/memory/infrastructure/memoryDistillRuntimeResolver.ts`（85 行）。

- `:5` 取 `RUNTIME_KINDS`（`services/runtime/index.ts:63`，由驱动注册表派生的「有哪些运行时」唯一来源，RFC-143）。
- `:35` `DrizzleMemoryDistillRuntimeResolver` 实现 memory 自有端口 `NativeMemoryDistillRuntimeResolver`
  （`application/ports/distillWorkStore.ts:263`）。次序：运行时名字 → 已弃用的模型（opencode 加该模型）→ 全局默认（再缺省 opencode）。
  按名字解析时 `:62-77` 直接查 runtime-management 的 `runtimes` 表，取协议、二进制、模型、`isSandbox` 与观测身份（`id`、`probeFence`、
  `name`）；查不到时 `:57` 用 `RUNTIME_KINDS` 判内建协议名，否则回落 opencode。
- 唯一的生产构造点是 `composition.ts:159`，外面再包一层 `systemAgentBinding.bindRuntime`（只转发声明过的业务字段）。
- runtime-management 公开同样的解析：`public/queries.ts:66-80` 的 `RuntimeExecutionQueries.resolveInternalAgentRuntime`，实现在
  `application/runtimeRegistry.ts:259-282`（RFC-117 写明它服务蒸馏器、提交与合并这类内部代理）。逐步对照：
  - 次序相同；
  - 按名字查到行时观测身份同取 `id`、`probeFence`、`name`，`runtimeProfileOf(row)` 给出模型与 `isSandbox`；
  - 内建名字（`BUILTIN_NAMES`，同样由驱动注册表派生）回到该协议、二进制为空、参数为空；
  - 未知名字回落 opencode。

  差别只有两处：runtime-management 对未知名字多记一条 `runtime-name-unknown-fallback-opencode` 警告；它的返回值是超集（另有 `name`、
  `configDir` 与其余参数字段），`bindRuntime` 只转发声明的字段。

- 表归属账本 `tests/fixtures/rfc395-module-table-ownership-debt.json:638` 记着这一条（memory 读 `runtimes`，「memory →
  runtime-management 不在 OFFERED_CONTEXT_EDGES」）。
- bootstrap：`daemonApplication.ts:417` 调 `composeDaemonMemoryModules`；runtime-management 的注册表操作在
  `daemonModules/providerCore.ts:192` 组好，作 `core.runtimeRegistry` 交给 `daemonApplication`。

**system-operations**：`modules/system-operations/infrastructure/local/doctorDiagnostics.ts`。

- `:40` 取 `getRuntimeDriver`；`:568-571` 的 `probeRuntime` 取 opencode 驱动，探测配置的二进制
  （`probe(defaultBinary({ opencodePath })[0])`）。
- 端口是 system-operations 自有的 `DoctorDiagnosticsFamily.probeRuntime` 与 `DoctorRuntimeProbe`（`application/ports/doctorDiagnostics.ts:6-14`）。
- 工厂 `createLocalDoctorDiagnosticsFactory(contract, tasks)`（`:599-608`）。bootstrap 的 `bootstrap/doctorDiagnostics.ts:8-10` 传入
  task-execution 实现的 `DoctorTaskLifecyclePort`，这正是 DAG 上的虚线；runtime-management 与 system-operations 之间没有虚线。
- 同一个「按协议探测默认二进制」还在 `bootstrap/standalone.ts:211-216`：默认运行时是 claude-code 时做软探测，日志里带 `minVersion`。

**source-control**：`modules/source-control/infrastructure/local/taskAgentWorkspaceContents.ts:3,31`。

- 它用一族的纯函数 `resolveBoundaryMounts`（`services/execution/workspaceBoundary.ts:127-134`，7 行）算任务挂载列表（各仓 worktree，
  当前目录不在其中时排在最前），再逐个发 `aw-task-mount:` 引用。
- 另一个使用方是 task-execution 的 `infrastructure/local/nativeTaskAgentRun.ts:66`。它只有用例 harness `tests/helpers/runner.ts:5` 使用。
- 用例 `tests/rfc281-workspace-boundary.test.ts` 直接测这个函数。

**resource-catalog**：`modules/resource-catalog/infrastructure/local/taskAgentMaterialReferences.ts:4-5`。

- 它从任务快照造出「原生技能 / 插件内容记录」（`:18-60`；托管技能的路径是 resource-catalog 自己的存储布局
  `appHome/skills/<id>/files`），留给本机材料编译器取用。
- 两个类型却借道一族声明：
  - `ResolvedSkill` 与 `SkillSource`：`services/runtime/types.ts:115-127`，其中的 `readContentVersion` 是技能行的修订栅栏；
  - `RuntimePlugin`：`services/execution/agentInjection.ts:43-52`，即 `Pick<Plugin, …>` 加二选一的定位。
- 它们的生产方是 resource-catalog，消费方是驱动（runtime-management）与 task-execution 的本机运行选项；DAG 上这两个方向都指向
  resource-catalog。

## 2. 机制与落位

**memory（G1）**

- 删除 `infrastructure/memoryDistillRuntimeResolver.ts`。
- `ComposeMemoryOperationsOptions` 增 `runtimeProfiles: NativeMemoryDistillRuntimeResolver`，类型是 memory 自有的端口。
  `composeMemoryOperationsFor` 用它代替 `new DrizzleMemoryDistillRuntimeResolver(db)`，外层的 `bindRuntime` 照旧。
- `composeDaemonMemoryModules` 原样转交。`daemonApplication` 绑定 `{ resolve: (request) => core.runtimeRegistry.resolveInternalAgentRuntime(request) }`。
  runtime-management 的返回值在结构上满足 memory 的 `ResolvedMemoryDistillRuntime`，memory 不 import runtime-management 的值。
- 用例里直接 new 这个解析器的三处改用同一绑定（helper 用 runtime-management 的 composition 组注册表）。

**system-operations（G2）**

- system-operations 的端口文件增 `DoctorRuntimeBinaryProbe`：
  `probe(protocol: 'opencode', config: { readonly opencodePath?: string | null }): Promise<DoctorRuntimeProbe>`，类型全部是
  system-operations 自己的。
- 本机 doctor 删掉驱动 import，`probeRuntime` 改调注入的探测；`createLocalDoctorDiagnosticsFactory(contract, tasks, runtimeBinary)`。
- runtime-management 新增 `infrastructure/local/defaultRuntimeBinaryProbe.ts`：按协议取驱动，探测默认二进制，并带回该驱动的
  `minVersion`。
- runtime-management 的 `composition/defaultRuntimeBinaryProbe.ts` 交出 `composeDefaultRuntimeBinaryProbe()`，它只给 bootstrap 用。
  它的签名比 system-operations 的端口宽，返回值是超集，在结构上满足端口。
- bootstrap 有两个使用方：
  - `bootstrap/doctorDiagnostics.ts` 传入它；
  - `bootstrap/standalone.ts` 的软探测改调它，判据与日志字段不变。

**source-control（G3）**

- `resolveBoundaryMounts` 连同文档注释逐字迁入 source-control 的 `domain/taskAgentMounts.ts`。本机工作区内容改从 domain 取。
- `public/queries.ts` 转出这个函数。该文件已有 `repoRelForcedPaths` 等纯函数的先例。
- `nativeTaskAgentRun.ts` 改从 source-control 的 `public/queries` 取；task-execution → source-control 是允许方向。
- `services/execution/workspaceBoundary.ts` 删去这个函数，并在文件头记去向；`rfc281-workspace-boundary` 改指新位置。

**resource-catalog（G4）**

- `SkillSource`、`ResolvedSkill`、`RuntimePlugin` 的声明逐字迁入 resource-catalog 的 `domain/nativeAgentMaterialContents.ts`，由
  `public/types.ts` 交出。
- `services/runtime/types.ts` 与 `services/execution/agentInjection.ts` 改为从 resource-catalog 的 `public/types` 转出同名类型，
  自己用时 `import type`。
  - legacy → 模块 public 是允许的形状，一族的 `runtime/selfCheck.ts` 已经这样取 resource-catalog 的 `public/types`。
  - 一族、runtime-management 与 task-execution 的其余使用方一个不改，整族迁入时再改取 public。
- 材料引用改从自己的 domain 取类型。

**锁（G5）**：新增 `tests/rfc487-runtime-family-forbidden-consumers-boundary.test.ts`，登记 guard-manifest（§4）。

## 3. 账本与计数

- 表归属债：fixture 删去 memory 解析器这一条，121 → 120。`rfc317-table-ownership` 的初始集合不变，账本只降不升。
- 越 DAG 计数：
  - 本 RFC 不新增 context 值边与越 DAG 文件对；
  - source-control 的新转出由 task-execution 消费，是 DAG 内的边；
  - 四个 context 现有的、指向 runtime-management `public/participants` 的类型边不在范围内，原样保留。
- public surface 增：
  - resource-catalog `public/types` 3 个类型；
  - source-control `public/queries` 1 个函数。

  预期它们都有生产消费方：一族与 task-execution 的本机运行入口。未消费 public 符号以报告实测为准，不得升。

- `services/` 文件数不变，各文件只减 import 与声明。随 memory 解析器删除，legacy 横向文件数与 legacy 服务实现数按报告实测收紧；
  memory 解析器不在 `services/`，预期不动。
- `counts.json` 60 项不升，触及的收紧到实测（C13）。

## 4. 用例

`rfc487-runtime-family-forbidden-consumers-boundary`（AST，带负对照）：

1. memory、resource-catalog、source-control、system-operations 四个 context 的全部生产文件（语料下限 600）不 import 运行时驱动一族的
   任何文件。相对路径、`@/` 别名、re-export 与动态 import 都认，带负对照。
2. memory 的生产文件不再引用 `runtimes` 表，`DrizzleMemoryDistillRuntimeResolver` 不再存在；memory 的装配从输入取 `runtimeProfiles`；
   bootstrap 用 `resolveInternalAgentRuntime` 绑定它。
3. system-operations 的本机 doctor 经注入的 `DoctorRuntimeBinaryProbe` 探测；bootstrap 的 doctor 工厂与 standalone 软探测都取
   runtime-management 的 `composeDefaultRuntimeBinaryProbe`。
4. 下面两类声明各只在 owner 的 domain 出现一次：
   - `resolveBoundaryMounts` 只在 source-control 的 domain 声明一次，经 `public/queries` 交出；
   - `ResolvedSkill`、`SkillSource`、`RuntimePlugin` 只在 resource-catalog 的 domain 声明一次，经 `public/types` 交出。

   一族的原位置只剩类型转出，没有第二份声明。

5. 行为对拍（两种 provider）：memory 经 bootstrap 形状的绑定解析四种输入，结果与此前一致：
   - 已注册的名字（带观测身份）；
   - 内建协议名；
   - 未知名字回落 opencode；
   - 已弃用模型回到 opencode 加该模型。

   doctor 的探测用伪造的探测端口，确认 `probeRuntime` 原样交入配置的 opencode 路径并返回探测结果。

既有用例按新位置改指：

- `rfc281-workspace-boundary`；
- memory 蒸馏的三个用例与两个 helper；
- doctor 用例；
- 读这些文件文本的账本。

断言意图不变。

## 5. 失败模式

- 遗漏：某个四个 context 的文件仍取一族 → 第 1 条用例红。
- 双份：类型或挂载函数留下第二份声明 → 第 4 条红。
- 行为偏移：memory 解析与此前不同 → 第 5 条与既有蒸馏用例红。唯一允许的差别是未知名字的那条警告日志（proposal §4）。
- 装配漏传：memory 或 doctor 少了绑定 → `tsc` 报缺成员，所以端口一律是必填成员。

## 6. 取舍（可推翻）

- **memory 改用 runtime-management 的解析，而不是给 memory 留一份读表的实现**：同一规则只留一份。RFC-117 本就把蒸馏器列为它的
  使用方，复制品读的是别人的表。代价是未知名字多一条警告日志。
- **探测走 runtime-management 的 composition 加 bootstrap 绑定，而不是在 DAG 上新增 runtime-management ⇢ system-operations 的虚线**：
  端口只用 system-operations 自己的类型，runtime-management 不 import system-operations，DAG 不变。
- **原生内容记录的类型归 resource-catalog**：它们描述 resource-catalog 的技能与插件内容（路径布局、修订栅栏、插件定位），消费方都在
  DAG 上指向 resource-catalog。
- **挂载规则归 source-control**：它只处理 source-control 给出的工作区路径，由 source-control 的工作区内容发引用。task-execution 那个
  只给用例用的入口经 `public/queries` 取。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：
  - 纯规则（挂载列表）进 source-control 的 domain；类型（原生内容记录）进 resource-catalog 的 domain；
  - 探测执行在 runtime-management 的 infrastructure；
  - 装配在 bootstrap；
  - memory 删除复制的持久化读取。
- **C11**：public 只增 §3 列出的 4 个符号，都有生产消费方；不撤。
- **C12**：RFC-487 用例覆盖四个 context 的全部生产文件（≥600）、bootstrap 的三处绑定与两个 owner 的唯一声明。
- **C13**：触及的减速带收紧到实测。
