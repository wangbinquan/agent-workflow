# RFC-492 技术设计

落在 runtime-management（`infrastructure/drivers/` 接收一族；16 个使用方改取模块内路径；`public/participants` 撤下只供一族的出口；
`composition/runtimeDrivers.ts` 交给 bootstrap）、bootstrap（启动自检与资源策略束）与测试树（驱动租约夹具）。按 RFC-294 design §3.1：
runtime-management 不反向依赖上层业务 context，一族只取 shared、`util/`、`platform/persistence` 与 resource-catalog 的 `public/`
（runtime-management → resource-catalog 在目标 DAG 上）；按 §9.2 适配器落 `modules/<context>/infrastructure/`。

## 1. 现状（HEAD `9f8fda604`，源码实读）

**一族的 40 个文件**：

- `services/runtime/**`（36）：注册表与类型（`index.ts`、`types.ts`），共用的 `head.ts`、`injectionIdentity.ts`、`selfCheck.ts`、
  `spawnCtx.ts`、`stageSkills.ts`，`opencode/`（18，含 `plugin/` 下的 `index.ts`、`transcoder.ts` 与 `aw-inventory-dump.mjs`），
  `claudeCode/`（11）。
- `services/execution/agentInjection.ts`（注入物料的线形转换，两个驱动共用）、`services/execution/workspaceBoundary.ts`（工作区边界）。
- `services/execution/taskExecutionResourceDependencies.ts`：bootstrap 交给 resource-catalog 任务执行绑定的策略束（运行时的
  `findManagedInjectionNameConflict`、`formatManagedInjectionNameConflict` 加 shared 的 `pickCallTarget`）。
- `services/driverLease.ts`：RFC-108 的驱动租约兼容夹具，RFC-328 之后没有生产使用方；RFC-108 的四个单元用例在用。

**谁 import 它（生产）**：

- runtime-management 的 16 个文件：`infrastructure/local/` 下的 `agentMaterialCompiler`、`agentMaterialEvidence`、`agentProtocol`、
  `claudeAgentMaterial`、`defaultRuntimeBinaryProbe`、`frozenTaskRuntime`、`legacyAgentMaterialBinding`、`localAgentMaterialDefinition`、
  `nativeRuntimeDriver`、`opencodeAgentMaterial`、`pluginLoadDiagnostics`、`runtimeManagementEffects`、`taskRuntimeInventoryContent`，与
  `infrastructure/` 下的 `mcpTestEligibility`、`runtimeProtocolFacts`、`runtimeRegistryEffects`。
- bootstrap 的 2 个：`daemonApplication.ts`（启动自检 `assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver))`）、
  `daemonModules/taskExecution.ts`（资源策略束）。

**它 import 谁**：shared（18 个文件）、`util/`（log、process、semver、platformExec、paths、fileTrust、safePath）、
`platform/persistence`（4 个文件取只读 SQLite）、`embed.generated`（插件入口按相对路径取）、resource-catalog 的 `public/`（3 个文件），
以及 runtime-management 自己：`public/`（9 个文件）、`application/ports/agentLiveCapture`（1）、`infrastructure/local/` 的材料实现（3）。

**只供一族的 public 出口**：架构报告里 runtime-management 有 14 个 public 符号的生产消费方只有一族——`public/participants` 的
`AgentSessionCaptureRequest`、`SystemAgentSessionSweepRequest`、`SystemAgentSessionSweepOutcome`（声明在 `application/ports/agentMaterialEvidence`）、
`DeclarationFace`（`agentProtocol`）、`RuntimeSessionCaptureEvent`（`runtimeSessionCapturePersistence`）、`DeclaredRuntimeCapabilities`、
`NormalizedEventKind`、`NormalizedEventData`、`TerminalResultObservation`（`agentObservations`）、`UsageAccumulator`、`modelKey`、`tokenCount`、
`RuntimeUsageMeterInput`、`RuntimeUsageModel`（`domain/usageMeter`）。今天一族在 `services/`、算作模块之外的读者；迁入后它们就成了未消费
public 符号（减速带 `max=1`）。

**跟随一族路径的仓内物**：

- eslint 的 RFC-282 §4.2 围栏（`backendRuntimeFencePatterns`）：按运行时的内部（`opencode/*`、`claudeCode/*`）只能经注册表与类型访问，
  别名与相对写法逐条列出；两个本机材料实现豁免。
- `scripts/build-binary.ts` 的 `pluginsDir`（单二进制嵌入 opencode 插件的目录）。
- workflow 路径过滤：`integration-opencode.yml`（push 与 pull_request 两份：`services/runtime/opencode/**`、`services/execution/**`）、
  `windows-platform.yml`（两份，各 7 条）、`visual-regression-nightly.yml`（两份，各 1 条）。
- 架构账本：`commons-debt.json` 的 9 条 R1 inbound 边全部起自一族；`commons-manifest.json` 有 7 处内核文件指向一族；`counts.json`；
  `architectureReport.ts` 的遗留路径目标表（保留已删文件的历史归属，RFC-491 design §6 细化 1）。
- 用例：134 个测试文件提到一族的路径，91 个只在 import 里，43 个还有路径字面量（源码锚点、守卫的允许清单、负对照与夹具）。
- 现行契约文档：`docs/OPENCODE_CONFIG.md`（注入线形转换的实现位置）、`docs/env-flags.md`（`AGENT_WORKFLOW_OPENCODE_BIN` 的读取处）。

## 2. 机制与落位

### D1 目录：`modules/runtime-management/infrastructure/drivers/`

`services/runtime/**` 整体搬到 `infrastructure/drivers/`，内部结构与文件名不变（`drivers/index.ts`、`drivers/types.ts`、`drivers/opencode/**`、
`drivers/claudeCode/**`）；`agentInjection.ts`、`workspaceBoundary.ts` 搬到 `drivers/` 根下。文件内容只改 import：

- 一族内部的相对 import 不变（结构不变）；唯一越出目录的相对 import 是插件入口取 `embed.generated`，改为 `@/embed.generated`（与
  `bootstrap/persistenceHead.ts` 等同一写法）。
- 原先取 runtime-management 的 `@/modules/runtime-management/...` 改为模块内相对路径；取 `public/` 的改取声明处（D2）。

不用 `infrastructure/local/`：驱动对象把静态声明（种类、能力、协议事实，托管准备经 `public/queries` 读）与本机进程效果（spawn、
探测、会话捕获）放在同一个对象里，两种部署形态都用；按部署形态拆驱动不在本 RFC（proposal §3）。

### D2 模块内取声明处，public 撤下只供一族的 14 个出口

一族迁入后是 runtime-management 自己的 infrastructure，取本模块的类型与函数改取声明文件（`application/ports/*`、`domain/usageMeter`、
`public/types` 里本就声明的 `RuntimeProfile` 与 `EMPTY_RUNTIME_PROFILE`），不经本模块的 `public/`。`public/participants` 撤下 §1 列出的
14 个只供一族的出口；其余仍有外部读者的照旧。测试里从 public 取这几个符号的改取声明处。

### D3 bootstrap 经 composition

- 新增 `modules/runtime-management/composition/runtimeDrivers.ts`，只做转出：`assertRuntimeDeclarations`、`getRuntimeDriver`、
  `RUNTIME_KINDS`（启动自检），`findManagedInjectionNameConflict`、`formatManagedInjectionNameConflict`（资源策略束）。
- `daemonApplication.ts` 的启动自检改取它，调用不变。
- 资源策略束迁为 `bootstrap/taskExecutionResourceDependencies.ts`：仍是同一个冻结对象、同样 3 个字段，运行时的两个函数取上面的
  composition，`pickCallTarget` 取 shared。`daemonModules/taskExecution.ts` 改取它。

### D4 驱动租约夹具移出生产

`services/driverLease.ts` 原样迁为 `tests/helpers/driverLease.ts`；RFC-108 的四个用例改取它。架构门里为它留的生产例外（RFC-328 的
「生产代码不得 import」与 RFC-376 的两处登记）随之删去，不可达生产文件 16 → 15。

### D5 跟随的守卫与配置

- **eslint 围栏**：模式改指新位置——别名 `@/modules/runtime-management/infrastructure/drivers/{opencode,claudeCode}/*`、
  `**/drivers/{opencode,claudeCode}/*`，相对写法按 runtime-management 内的实际层次列出（`./drivers/…`、`../drivers/…`、
  `../infrastructure/drivers/…`、`../../infrastructure/drivers/…`）；提示语改为经 `infrastructure/drivers`（注册表与类型）访问；两个本机
  材料实现的豁免不变。
- **单二进制构建**：`pluginsDir` 改为 `modules/runtime-management/infrastructure/drivers/opencode/plugin`；嵌入表的键是文件名，不变。
- **workflow 路径过滤**：逐条改指新位置。`integration-opencode.yml` 的 `services/execution/**` 原是为进程生命周期留的，现在那里只剩
  一族的三个文件，改为 `drivers/agentInjection.ts` 与 `drivers/workspaceBoundary.ts`（策略束去了 bootstrap，不影响真实 opencode 路径）。
- **架构账本**：`commons-debt.json` 删去 9 条 R1 inbound 边（迁入后都是模块内的边）；`commons-manifest.json` 的 7 处文件改指新位置；
  `counts.json` 触及的项收紧到实测；遗留路径目标表照留（同 RFC-491）。
- **文档**：`docs/OPENCODE_CONFIG.md`、`docs/env-flags.md` 的现行位置改指新路径；`design/`、`docs/audit-backlog.md`、
  `docs/dev-gotchas.md` 里的历史记录不改。描述现行位置的源码注释同步改。

### D6 用例

- 91 个只在 import 里提到旧路径的测试文件：只改 import 说明符（别名与 `../src/…` 相对写法都改为新位置的别名）。
- 43 个带路径字面量的：源码锚点、允许清单与负对照逐条改指新位置，断言意图不变。RFC-487、RFC-488、RFC-491 用例里的「一族」改为
  `infrastructure/drivers/**`，它们锁的「这些 context 不 import 一族」照旧成立；RFC-462 的「`types.ts` 只再导出、不声明」改为再导出自
  声明处；发布账本的夹具（`tests/fixtures/release-upgrade/`）记录的是已发布版本的源码，不改。
- RFC-213 的启动根逆变换（`helpers/rfc213DevStartupRootInverse.ts`）按新的 import 行改写，逆变换的语义不变。

## 3. 账本与计数（预计，实测为准）

- legacy 服务实现 46 → 6（余 git 一族 3 个、`codeRoundContract.ts`、`digitalEmployeeAgentTemplates.ts`、`demoSeed.ts`）；legacy 横向文件
  165 → 125；不可达生产文件 16 → 15（驱动租约夹具；插件 `.mjs` 换位置、仍按路径加载）。
- `commons-debt.json` 的 inbound 边 9 → 0。
- runtime-management 的未消费 public 符号保持 1；public surface 1,209 → 1,195；public 类型偏差 57 → 56（`modelKey` 的开放类型随出口撤下）。
- 跨 context 内部文件对、越 DAG 的值边与 offered 文件对、直接 `setInterval` 点（一处换路径）不变。

## 4. 用例

新增 `rfc492-runtime-driver-family-in-runtime-management-boundary`（AST，带负对照，登记 guard-manifest）：

- ① 一族不在 `services/`：`services/runtime/`、`services/execution/` 没有文件，`services/driverLease.ts` 不存在；`infrastructure/drivers/`
  下的文件不少于 38 个；`tests/helpers/driverLease.ts` 存在。
- ② 全部生产文件里 import `infrastructure/drivers/**` 的只有 runtime-management 自己的文件（语料下限 3,000）；import 识别带负对照：
  别名、相对路径、re-export、动态 import、type-only。
- ③ 生产文件不再有指向旧位置的 import 说明符；`infrastructure/drivers/**` 不取本模块的 `public/participants`。
- ④ public 撤下的 14 个出口不再从 `public/participants` 交出，且各在声明处只声明一次。
- ⑤ bootstrap：`composition/runtimeDrivers.ts` 只有转出；启动自检取它；策略束 3 个字段、与 runtime-management 和 shared 的函数引用
  相等；`daemonModules/taskExecution.ts` 取 bootstrap 的策略束。
- ⑥ 构建与配置：`build-binary.ts` 的插件目录指向新位置且目录里有 `aw-inventory-dump.mjs`；插件入口取 `@/embed.generated`；eslint 配置
  里的围栏模式指向新位置、不再出现旧位置；三份 workflow 的路径过滤登记新位置、不再出现旧位置。

另外依赖现有用例：RFC-282 的 eslint 围栏用例（对合成文件跑 eslint，新位置的别名与相对写法都被拦、注册表入口可用）、
`opencode-integration-path-coverage`（两份触发器的清单逐条相等）、RFC-317 的账本用例（清单文件存在、债务账本与实算相等）。

## 5. 失败模式

- 构建找不到插件目录：嵌入表为空，单二进制里库存插件落不下去，e2e 的库存标记缺失。用例 ⑥ 钉住目录与文件，CI 的单二进制构建与
  e2e 兜底。
- 围栏模式没跟上：按运行时的内部可被随意 import。RFC-282 的 eslint 用例对新位置的别名与相对写法各给负对照。
- 路径过滤没跟上：改驱动不触发真实 opencode 与 Windows 套件。用例 ⑥ 与 `opencode-integration-path-coverage` 钉住。
- 未消费 public 符号上升：D2 撤下出口；用例 ④ 与架构门（减速带 `max=1`）双重钉住。
- 旧路径的否定断言变空：`not.toContain('@/services/runtime')` 一类在迁移后恒真。逐条改指新位置（D6），用例 ③ 另从生产侧锁住。

## 6. 取舍（可推翻）

1. **落 `infrastructure/drivers/` 而不是 `infrastructure/local/`**：理由见 D1。
2. **内部结构与文件名不变**：只换根目录，便于逐文件核对；驱动内部的重构另立。
3. **资源策略束归 bootstrap，不放 runtime-management 的 composition**：它把运行时与 shared 的函数拼成 resource-catalog 的端口，是装配；
   runtime-management 只交出自己的两个函数。
4. **驱动租约夹具移出生产，不随一族进 runtime-management**：RFC-294 plan §4.7 的表把 `driverLease.ts` 列在一族里，但它是 RFC-108 的
   兼容夹具、不是驱动，没有生产使用方；偏离本表，与 RFC-491 处理只供用例的运行器一致。
5. **模块内取声明处**：一族迁入后取本模块 `public/` 会让 14 个出口失去模块外读者、成为未消费符号；改取声明处并撤下出口，public 只留
   有外部读者的部分。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：一族是 runtime-management 的适配器，落 infrastructure；composition 只做转出；不新增用例入口。
- **C11**：public 只减不增（撤下 14 个只供一族的出口）；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-492 用例覆盖全部生产文件（下限在 guard-manifest 写明）与指定的 runtime-management、bootstrap、构建脚本、eslint 配置与
  workflow 文件；只对这些范围宣告退出门。
- **C13**：触及的计数收紧到实测。
- **§4.7**：运行时驱动一族收口；`services/` 余 6 个文件（W5 的 git 一族 3 个，`codeRoundContract.ts` 随 W4-E8，
  `digitalEmployeeAgentTemplates.ts` 随 W4-E9，`demoSeed.ts` 归 bootstrap）。
