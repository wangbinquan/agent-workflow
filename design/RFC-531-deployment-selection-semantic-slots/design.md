# RFC-531 技术设计

## 1. 现状（HEAD，源码实读）

`bootstrap/deploymentProfile.ts` 的 `DeploymentSelections` 有 7 个槽位以 `typeof <工厂>` 定型；单机 profile 交出本地工厂本身，托管 profile 交出
同签名（或参数更少、忽略输入）的函数：

| 槽位                                        | 类型（HEAD）                                             | 单机（`bootstrap/standalone.ts`）             | 托管                                                                                                         | 调用处                                   |
| ------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `runtimeManagement`                         | `typeof composeLocalRuntimeManagementSelection`          | 同名函数（`bootstrap/runFamilyProviders.ts`） | `composeCrewStationRunFamilySelections` 的 `runtimeManagement`                                               | `daemonModules/observation.ts`           |
| `systemAgentRunFamily`                      | `typeof composeLocalSystemAgentRunFamilySelection`       | 同名函数                                      | task-execution 的 `createCrewStationSystemAgentRunFamily`（返回类型写成 `ReturnType<typeof composeLocal…>`） | 同上                                     |
| `mcpDiagnostics`                            | `typeof composeLocalMcpDiagnostics`                      | resource-catalog 的同名函数                   | resource-catalog 的 `createCrewStationMcpDiagnostics`（返回类型写成 `typeof composeLocalMcpDiagnostics`）    | 同上；`daemonApplication.ts` 的测试接缝  |
| `repositoryPublicationTransport`            | `typeof createRepositoryPublicationTransport`            | 同名函数                                      | `() => 托管实例`（`crewstation.ts`）                                                                         | `daemonModules/repositoryCredentials.ts` |
| `developmentWorkspaceRepositoryPreparation` | `typeof createDevelopmentWorkspaceRepositoryPreparation` | 同名函数                                      | `() => 托管实例`                                                                                             | 同上                                     |
| `repositoryPreparationEffects`              | `typeof composeLocalRepositoryPreparationEffects`        | 同名函数                                      | `() => 托管实例`                                                                                             | `daemonModules/taskExecution.ts`         |
| `scratchWorkspaceEffects`                   | `typeof composeLocalScratchWorkspaceEffects`             | 同名函数                                      | `() => 托管实例`                                                                                             | 同上                                     |

另有 `daemonApplication.ts` 的 `mcpRuntimeTests: ReturnType<typeof composeLocalMcpDiagnostics>`，与 `HostProbeInput.log` 的
`ReturnType<typeof createLogger>`（中性的日志器，取 `Logger` 类型即可）。

可空的 `repositoryRemote: RepositoryRemoteEffects | null`（单机 `null`，托管是 source-control 托管工作区里的远端读取）只有两个读取处：
`bootstrap/daemonHttpComposition.ts` 按它选 `composeLocalRepositoryMirrors` 或 `composeRemoteRepositoryMirrors`（RFC-527 起在这里显式选）；
`bootstrap/daemonSession.ts` 的子仓刷新句柄在它非空时返回空句柄，否则起 source-control 本机的 `startConfiguredSubmoduleRefreshLoop` 并登记配置
变更监听。

## 2. 机制与落位

### D1 语义选择类型（拥有方模块导出）

每个槽位的类型是“会话交给选择的输入 → 模块的端口或装配”，以 `…Selection` 命名（与合同里既有的 `TaskRunRootSelection`、
`DevelopmentPurposeSelection` 一致）：

- **runtime-management**：`composition/runtimeManagement.ts` 导出装配的具名类型 `RuntimeManagementAssembly`（本机与托管的装配本来就是同一个
  `bindRuntimeManagement(...).management`）。选择的输入由 runtime-management 的装配输入与 task-execution 冒烟运行族的观察组成，属 bootstrap 的
  配对：`bootstrap/runFamilyProviders.ts` 导出 `RuntimeManagementSelection = (input: RuntimeManagementSelectionInput) => RuntimeManagementAssembly`，
  输入里冒烟观察的类型取 task-execution 组合层转出的 `SystemAgentObservationFactory`，不再取本地工厂的参数。
- **task-execution**：新文件 `composition/systemAgentRunFamilySelection.ts` 定义 `SystemAgentRunFamilyBinding<Bind>`（`family` 是既有端口
  `SystemAgentRunFamily`，另有 `bindRuntime` 与 `withFixture`）与 `SystemAgentRunFamilySelection<Bind>`；托管工厂的返回类型改为它。选择的输入
  `SystemAgentRunFamilySelectionInput` 是此前的 `LocalSystemAgentRunFamilyInput` 改名（单机与托管共用），仍定义在本机的运行族开启处：它的
  fixture 以原生运行的选项与结果定型，这两个类型在 `infrastructure/local/`，`application/ports/` 不能取。合同里的 `Bind` 是 bootstrap 配对文件
  导出的 `SystemAgentRuntimeBinder`（runtime-management 原生的运行时绑定，两种 profile 交回的都是它）。
- **resource-catalog**：`composition/mcpDiagnostics.ts` 定义 `McpDiagnosticsSelectionInput`（此前 `localMcpDiagnostics.ts` 的
  `LocalMcpDiagnosticsCompositionInput`，托管实现原样展开它）与 `McpDiagnosticsSelection = (input) => McpDiagnosticsRuntime`；本地与托管的工厂都
  按它定型，daemon 的 `mcpRuntimeTests` 取 `McpDiagnosticsRuntime`。
- **source-control**：新文件 `composition/deploymentSelections.ts` 导出 4 个选择类型，输入是 daemon 实际交入的字段：
  `RepositoryPublicationTransportSelection`（`{ repository, secretBox, appHome, endpointDiscovery }` → `RepositoryPublicationTransport`）、
  `DevelopmentWorkspaceRepositoryPreparationSelection`（`{ store, appHome, secretBox }` → `DevelopmentWorkspaceRepositoryPreparation`）、
  `RepositoryPreparationEffectsSelection`（`RepositoryPreparationInput` → `RepositoryPreparationEffectFactory`）与
  `ScratchWorkspaceEffectsSelection`（`RepositoryPreparationInput` → `ScratchWorkspaceEffects`）。本地工厂的参数是这些输入的超集（多出的可选项是
  用例的接缝），照旧可以直接交给单机 profile；托管照旧交忽略输入的函数。两种实现都交出的
  `DevelopmentWorkspaceRepositoryPreparation` 端口从本机实现的文件挪到 `application/ports/`。

`DeploymentSelections` 里这 7 个槽位改用上面的类型；文件里不再有 `typeof` 定型的成员。

### D2 镜像与镜像刷新由 profile 选择

- `repositoryRemote` 换成两个必填选择（source-control `composition/deploymentSelections.ts` 定义类型）：
  - `repositoryMirrors: RepositoryMirrorsSelection`（`{ store, secretBox, appHome }` → `RepositoryMirrors`）：单机交 `composeLocalRepositoryMirrors`；
    托管交闭包，按托管工作区的远端读取调 `composeRemoteRepositoryMirrors`（与此前 daemon 在远端非空时构造的相同）。
  - `repositoryMirrorRefresh: RepositoryMirrorRefreshSelection`（`{ store, configuration, appHome, secretBox }` → `Promise<RepositoryMirrorRefresh>`，
    后者即刷新循环的 `stop` / `reconfigure` / `awaitIdle`）：单机交 `composeLocalRepositoryMirrorRefresh`（调本机的
    `startConfiguredSubmoduleRefreshLoop`，实参与此前 daemon 交的相同）；托管交返回 `idleRepositoryMirrorRefresh`（什么都不做）的闭包。这两个
    放在新文件 `composition/repositoryMirrorRefresh.ts`，镜像的组合文件不变。
  - 两个新键都是会话级的工厂（RFC-432 的约定：单机交构造函数本身，托管交闭包），选择分组的清单随之改。
- daemon：HTTP 装配调 `selections.repositoryMirrors(...)`；子仓刷新句柄调 `repositoryMirrorRefresh(...)` 并照旧登记配置变更监听、停止与排空。
  两处 `null` 分支删去；生命周期程序里 `submodule-refresh` 句柄照旧两种 profile 都登记（有序作业 id 不变）。
- `DEPLOYMENT_SELECTION_KEYS` 删 `repositoryRemote`、加这两个键。

### D3 用例与锁

- 新增 `packages/backend/tests/rfc531-deployment-selection-semantic-slots-boundary.test.ts`，登记 guard-manifest：① `deploymentProfile.ts` 的成员
  类型里没有类型查询（`typeof`）；② 托管一族的文件（路径含 `crewstation`）与 `bootstrap/daemon*.ts` 里没有按 `Local` / `File` / `Native` 工厂
  签名定型的类型查询；③ daemon 不读 `repositoryRemote`，两个 profile 都给出 `repositoryMirrors` 与 `repositoryMirrorRefresh`；④ 托管的镜像刷新
  什么都不做、单机的选择按本机实现构造（行为）；带负对照（只喂伪造的源码）。
- 钉住旧形状的锁随改：RFC-527 的“HTTP 装配按远端显式选镜像”；选择分组的清单（`tests/helpers/deploymentSelectionPartition.ts`）与读它的
  `rfc394`、`rfc431`（分组计数、两条以 `repositoryRemote` 为靶的负对照改以 `databaseInstallation` 与 `taskRecovery` 为靶）、`rfc433`（单机交出
  本机的镜像与刷新）；`rfc370-v4-repository-mirrors` 与 `rfc370-root-background-bindings`（子仓刷新句柄改调选择）；`rfc422`（运行族开启处定义的
  输入改名）。

## 3. 清单（退出门）

| 名字                                              | 之后                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| 合同里 7 个 `typeof` 槽位与 `HostProbeInput.log`  | 拥有方模块的具名选择类型；`Logger`                                |
| 托管 MCP 诊断与 System Agent 运行族工厂的返回类型 | `McpDiagnosticsSelection` / `SystemAgentRunFamilySelection<Bind>` |
| `daemonApplication.ts` 的 `mcpRuntimeTests`       | `McpDiagnosticsRuntime`                                           |
| `repositoryRemote`（可空）                        | 删去；`repositoryMirrors` 与 `repositoryMirrorRefresh`（必填）    |
| daemon 按 `repositoryRemote` 的两处分支           | 删去                                                              |

## 4. 用例

- ① ～ ④ 见 D3；既有用例覆盖两种 profile 的镜像读取、子仓刷新的启停与排空、运行时管理、System Agent 与 MCP 诊断的装配。

## 5. 失败模式

- **托管丢了远端读取**：托管的 `repositoryMirrors` 是按托管工作区的远端读取调 `composeRemoteRepositoryMirrors` 的闭包（实参与此前 daemon 交的
  相同），RFC-531 用例钉住两个 profile 都给出这个选择。
- **单机的刷新换了时序**：单机选择照旧调 `startConfiguredSubmoduleRefreshLoop(store, configuration, 缺省周期, appHome, secretBox)`，句柄的
  停止与排空、配置监听照旧；`rfc370-root-background-bindings` 钉住句柄以同一个配置查询调选择。
- **类型放宽漏掉入参**：选择类型的输入取 daemon 实际交入的字段；`tsc` 校验每个调用处与两种实现。

## 6. 取舍（可推翻）

1. **先让每个槽位有语义类型，不在本 RFC 按模块分组**：分组要改全部 62 个键与全部读取处、两份 profile 与选择键清单，与本 RFC 的类型改动正交；
   有了语义类型，分组是纯搬迁，另立后继。
2. **托管的镜像刷新给什么都不做的实现，而不是保留 `null`**：选择是必填的，daemon 不再判断部署能力；什么都不做的刷新与此前的空句柄等价（多登记
   的配置监听调到的也是什么都不做）。
3. **`databaseInstallation` 不在本 RFC**：本机安装路径（自动升级子进程、配置重读、待定恢复与文件准备）要整体收成单机 profile 给出的安装端口，
   与本 RFC 的改动面不重叠，另立后继。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层不变。**C11**：各模块 public 不变（新类型在 composition 与 application/ports）。**C12**：RFC-531 用例覆盖选择合同、托管一族与
  daemon 装配。**C13**：计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 6 项的一半（选择合同里没有 `typeof <本地工厂>` 定型的槽位）与第 1 项余项里镜像、子仓刷新两处 daemon 分支。
- **留下**：`databaseInstallation` 的 daemon 分支（第 1 项余项的另一半）；按模块分组为适配器集合（design §9.3 的终态）；MCP 诊断选择输入里的
  效果依赖类型仍定义在 `infrastructure/local/`（两种实现共用，随分组一起挪）。
