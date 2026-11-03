# RFC-431 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`。以 RFC-430 / RFC-401 落库后的源码（`a78f95d7a`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：本 RFC 落在 `bootstrap/`，即唯一装配根。单机 profile（`S/bootstrap/standalone.ts`）成为单机部署的装配根，与托管的
  `S/bootstrap/crewstation.ts` 对称：两者都给出完整的 `DeploymentSelections`。
- **模块侧只做两件事**：
  - 在 `composition` 入口导出本地实现（`bootstrap/` 不得穿到 `infrastructure/`）；
  - 删去只被 `bootstrap/` 调用、只为「选择项可能缺省」而存在的归一化。
- **承担的演进**：S2c「以类型化 profile 取代各模块 `select*` 助手」的装配层部分。模块内部还有其他调用方的缺省留作债务（§6）。
- **不新增**跨 context 内部 import、facade 或 `routes/` / `services/` 平铺耦合。`standalone.ts` 只 import 各模块 `composition` / `public`
  与 `services/` 中已被 `bootstrap/` 使用的本地实现（插件安装器）。

## 1. 选择项三分区

`S/bootstrap/deploymentProfile.ts` 的 `DeploymentSelections`（62 项）：

**R：必填（39 项）**，单机给本地实现：

`applicationConfiguration`、`workspaceUploads`、`isolationWorkspaces`、`repositoryGitWorkspaces`、`workspaceReads`、`workspaceContent`、
`workspacePresence`、`fusionWorkspaceEffects`、`workspaceMaintenanceFilesystem`、`workspaceExcludeProfiles`、`employeeCaseWorkspaceEffects`、
`repositoryRevisionContent`、`codeReviewArtifacts`、`taskRunSelection`、`taskArchive`、`taskDeletionEffects`、`archivedNodeEvents`、
`reviewRollbackSnapshots`、`runtimeInventoryContent`、`bootExecutionRecovery`、`programFixtureProcess`、`actionWorkspaceEntries`、
`recoveredExecutionTaskIds`、`hostedBackgroundOwners`、`runtimeManagement`、`systemAgentRunFamily`、`mcpDiagnostics`、`credentials`、
`customObserverPrograms`、`pluginInstaller`、`resourcePackagePluginArtifacts`、`employeePrograms`、`employeeInputArtifacts`、`evidenceArtifacts`、
`graphDevelopmentArtifacts`（新）、`developmentPurposes`、`verificationCommands`、`repositoryBaselines`、`actionWorkspaceEffects`。

**N：必填可空（6 项，`X | null`）**，托管独有能力，单机 `null`：

`taskInputFiles`、`humanGateArtifactRecovery`、`beforeEventObservationWrite`、`taskRecovery`、`maintenanceEffectsBootstrap`、`initializeExecution`。

**O：保持可选（17 项）**：

- 第三步（默认值要用会话的 `db` / 内容存储）：`contentStore`、`skillContent`、`reviewArtifacts`、`repositoryPreparationEffects`、
  `scratchWorkspaceEffects`、`repositoryPublicationTransport`、`developmentWorkspaceRepositoryPreparation`、`resourcePackageSkillArtifacts`、
  `intentArtifacts`、`databaseBackup`。
- 第四步（部署开关或有无分支）：
  - `databaseInstallation`：缺省即单机的整段 epoch 启动流程；
  - `secretBox`：缺省会创建 `secret.key`，必须在启动锁之后；
  - `repositoryRemote`、`crewStationEvents`：有无即部署开关；
  - `executionAuthority`：有无决定后台是否经执行权门控启动；
  - `repositoryCandidateEffects`、`conflictMergeWorkspaceEffects`：缺省时单机按请求换 git、候选可推到本地文件 remote。

键表 `S/bootstrap/deploymentSelections.ts` 加 `graphDevelopmentArtifacts`。

`DaemonProviderSessionComposeInput` 与 `DaemonApplicationInput` 不再重声明 `applicationConfiguration` 与四个工作区工厂，它们已在合同里必填。
两者只保留 `secretBox` 的必填重声明（第四步再议）。

## 2. 单机 profile

```ts
// S/bootstrap/standalone.ts
export function standaloneSelections(input: { readonly appHome: string }): DeploymentSelections
export function composeStandaloneProfile(): DeploymentProfile // selections: standaloneSelections({ appHome: Paths.root })
```

- 返回值只含 R + N 共 45 项，O 组不出现。返回类型是 `DeploymentSelections`，漏给 R / N 任一项都是编译错误。
- **构造不做 IO**：profile 在 `main.ts` 的 start 分支、启动锁之前构造。逐项核对过的构造函数都只建闭包；
  会建目录的三处改为惰性（§4）。
- 测试入口 `T/helpers/providerHttpApplication.ts` 与 `T/rfc391-neutral-daemon-graph.test.ts` 的应用装配先展开
  `standaloneSelections({ appHome })`，再覆盖用例自己给的项。单机行为的唯一来源因此是同一个函数。

各项的单机值，与今天缺省时的构造逐字等价：

| 选择项                                                          | 单机值                                                                                                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applicationConfiguration`                                      | `composeApplicationConfigurationBinding({ kind: 'file', configPath: join(appHome, 'config.json') })`                                                                             |
| 四个工作区工厂                                                  | `createFileWorkspaceUploadContentFactory()`、`createLocalIsolationWorkspaceFactory()`、`createFileRepositoryGitWorkspaceFactory()`、`createFileRepositoryWorkspaceReadQueries()` |
| `workspaceContent`                                              | `createFileWorkspaceContentEffectsFactory()`（新，`bind: createFileWorkspaceContentEffects`）                                                                                    |
| `workspacePresence`                                             | `createFileWorkspacePresenceQueries()`                                                                                                                                           |
| `fusionWorkspaceEffects`                                        | `createFileFusionWorkspaceEffects({ appHome })`                                                                                                                                  |
| `workspaceMaintenanceFilesystem`                                | `createNodeWorkspaceMaintenanceFilesystem({ appHome, isMaterializingTask: materializingSpaces.has, invalidateWorkspacePath: invalidateCallGraphIndex })`                         |
| `workspaceExcludeProfiles`                                      | `composeLocalWorkspaceExcludeProfiles({ appHome })`（本地工厂，appHome 固定）                                                                                                    |
| `employeeCaseWorkspaceEffects`                                  | `createFileEmployeeCaseWorkspaceEffectsFactory()`                                                                                                                                |
| `repositoryRevisionContent` / `codeReviewArtifacts`             | `composeLocalRepositoryRevisionContent()` / `composeLocalCodeReviewArtifacts()`                                                                                                  |
| `taskRunSelection`                                              | `composeLocalTaskRunSelection({ nodeRunPrompts, portArtifacts })`（新，未绑定的 `TaskRunRootSelection`；提示词在 `appHome/runs`、端口产物在 `appHome`）                          |
| `taskArchive`                                                   | `{ content: createFileTaskArchiveContent() }`（不给 `locations`：仍由调用方给根目录；绑定类型的 `locations` 改为可选）                                                           |
| `taskDeletionEffects`                                           | `composeLocalTaskDeletionEffects()`（文件内容 + git 仓库两族）                                                                                                                   |
| `archivedNodeEvents`                                            | `createFileArchivedEventsReader()`（新，`platform/background`，读 `Paths.logsDir`，与今天的分支同一函数同一目录）                                                                |
| `reviewRollbackSnapshots`                                       | `composeLocalWorkspaceRollbackSnapshots()`（`new GitWorkspaceRollbackSnapshotInspector()`）                                                                                      |
| `runtimeInventoryContent`                                       | `createLocalTaskRuntimeInventoryContent()`                                                                                                                                       |
| `bootExecutionRecovery`                                         | `createLocalBootExecutionRecoveryFactory()`                                                                                                                                      |
| `programFixtureProcess`                                         | `createLocalScriptFixtureProcess({})`                                                                                                                                            |
| `actionWorkspaceEntries`                                        | `localActionWorkspaceEntries`                                                                                                                                                    |
| `recoveredExecutionTaskIds` / `hostedBackgroundOwners`          | `() => []` / `[]`                                                                                                                                                                |
| `runtimeManagement` / `systemAgentRunFamily` / `mcpDiagnostics` | `composeLocalRuntimeManagement` / `composeLocalSystemAgentRunFamily` / `composeLocalMcpDiagnostics`                                                                              |
| `credentials`                                                   | `composeLocalCredentialAdapters`                                                                                                                                                 |
| `customObserverPrograms`                                        | `createLocalCustomObserverProgramFactory()`                                                                                                                                      |
| `pluginInstaller`                                               | `createLocalPluginInstaller()`                                                                                                                                                   |
| `resourcePackagePluginArtifacts`                                | `createFileResourcePackagePluginArtifactOwner({ pluginsDir: join(appHome, 'plugins'), installer: createResourcePackagePluginInstaller() })`                                      |
| `employeePrograms` / `employeeInputArtifacts`                   | `createProgramArtifactStore(appHome)` / `createEmployeeInputArtifactStore(join(appHome, 'artifacts', 'employee-inputs'))`                                                        |
| `evidenceArtifacts`                                             | `createLocalEvidenceArtifactPort(appHome)`（改为惰性，根 `appHome/evidence`）                                                                                                    |
| `graphDevelopmentArtifacts`                                     | `createLocalGraphDevelopmentArtifactPort(appHome)`（新，惰性，根 `appHome`，即 RFC-396 起的位置）                                                                                |
| `developmentPurposes`                                           | `composeLocalDevelopmentPurposes({ appHome, evidenceArtifacts })`（从 `developmentPurposeRoot.ts` 的缺省分支整体移出）                                                           |
| `verificationCommands`                                          | `createLocalVerificationCommandEffectsFactory()`                                                                                                                                 |
| `repositoryBaselines`                                           | `createFileRepositoryBaselineEffectsFactory()`                                                                                                                                   |
| `actionWorkspaceEffects`                                        | `createFileActionWorkspaceEffects()`                                                                                                                                             |
| N 组 6 项                                                       | `null`                                                                                                                                                                           |

托管 profile 只加一项：`graphDevelopmentArtifacts: evidence.evidenceArtifacts`，与 `evidenceArtifacts` 是同一对象。N 组托管照旧给值。

## 3. 消费点

| 位置                                                 | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S/bootstrap/daemonStart.ts`                         | 直接用 `profile.selections.applicationConfiguration`。任务启动配置的同步 / 异步分支只看 `synchronousQueries`：托管的 `selected` 绑定没有它，单机文件绑定有，两侧结果与今天相同。删去四行工作区工厂归一化。                                                                                                                                                                                                                                         |
| `S/bootstrap/daemonSessionInput.ts`                  | 删去五项重声明                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `S/bootstrap/daemonSession.ts`                       | 托管后台 owner 直接 `map`。人工门产物恢复、维护效果描述照旧直接传入，两个消费方（人工门续跑 worker、维护 Worker 监督者）的参数改为接受 `null`，`null` 即无此能力。`lifecycleProgram.initialize(input.initializeExecution)` 收 `null`。                                                                                                                                                                                                             |
| `S/bootstrap/daemonLifecycleProgram.ts`              | `initialize(initializeExecution: … \| null = null)`，判 `null` 即内联执行恢复                                                                                                                                                                                                                                                                                                                                                                      |
| `S/bootstrap/daemonApplication.ts`                   | 四个工作区工厂、融合工作区、观测适配器（含 `workspacePresence`）、凭据、启动恢复、恢复任务 id 直接取输入。任务运行根改为 `bindTaskRunRootSelection(input.taskRunSelection)`，提示词与端口产物取自绑定结果，删去三处 `selectedTaskRuns === undefined` 分支。排除配置为 `() => input.workspaceExcludeProfiles`。开发工作区绑定只从动作工作区派生，冲突配对检查删除：动作工作区已必填，该检查不再可能触发。任务输入文件与托管恢复按 `null` 显式省略。 |
| `S/bootstrap/daemonHttpComposition.ts`               | 选择项包改为必填，类型取 `Pick<DeploymentSelections, …>`。工作区内容、运行清单内容、代码评审两项、资源包插件产物直接使用；资源包始终以 `pluginArtifacts` 形态传入。                                                                                                                                                                                                                                                                                |
| `S/bootstrap/daemonModules/adapters.ts`              | 删除 `standaloneModuleAdapters` 与 `DaemonModuleAdapters`                                                                                                                                                                                                                                                                                                                                                                                          |
| `S/bootstrap/daemonModules/observation.ts`           | 适配器类型改为 `Pick<DeploymentSelections, 'systemAgentRunFamily' \| 'mcpDiagnostics' \| 'runtimeManagement'>` 加 `workspacePresence` 值                                                                                                                                                                                                                                                                                                           |
| `S/bootstrap/daemonModules/providerCore.ts`          | `credentials` 必填                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `S/bootstrap/daemonModules/digitalEmployee.ts`       | 程序产物、员工输入产物、验证命令、图开发证据直接取适配器输入；删去 `createGraphDevelopment*Binding` 的调用                                                                                                                                                                                                                                                                                                                                         |
| `S/bootstrap/daemonModules/developmentAutomation.ts` | 验证命令直接取输入                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `S/bootstrap/daemonModules/integration.ts`           | 适配器改为必填；观测写前钩子直接传入，事件中心与事件存储的参数改为接受 `null`                                                                                                                                                                                                                                                                                                                                                                      |
| `S/bootstrap/developmentPurposeRoot.ts`              | `composeDevelopmentPurposeRoot({ selection, evidenceArtifacts })` 只做校验与转交；原缺省分支整体移为 `composeLocalDevelopmentPurposes`。文档命令的校验对两种部署一律执行，单机的文档命令惰性打开，校验不触发建目录。                                                                                                                                                                                                                               |
| `S/bootstrap/crewstation.ts`                         | 加 `graphDevelopmentArtifacts`                                                                                                                                                                                                                                                                                                                                                                                                                     |

模块侧（只被 `bootstrap/` 调用的入口，改为必填并删去缺省）：

- `task-execution`：`composition/providerRuntime.ts` 的 `workspaceReads` 归一化；`selectLocalBootExecutionRecoveryFactory` 删除（`bootRecovery.ts`
  为模块级直接调用方保留 `?? createLocalBootExecutionRecoveryFactory()`，记入 §6）；
  `composition/taskRuntimeInventoryContent.ts`（只剩 HTTP 装配一个调用方，整个删除）；`selectTaskRunRootSelection` 与
  `composeLocalTaskRunRootSelection` 由 `composeLocalTaskRunSelection` + `bindTaskRunRootSelection` 取代。
- `development-automation`：`composition/graphDevelopmentBindings.ts` 的两个缺省绑定删除（只剩模块组一个调用方）；
  `infrastructure/actionWorkspaceEffects.ts` 的冲突配对参数删除。
- 删除前逐个按全仓（含 `T/`）确认没有其他调用方。仍有调用方的保留，并记入 §6。

## 4. 新增或改形的本地实现

- **证据存储惰性打开**：`development-automation/infrastructure/local/evidenceStaging.ts`。
  - `EvidenceStore` 的构造函数会建 `blobs/`、`bundles/`。
  - `createLocalEvidenceArtifactPort(appHome)`（根 `appHome/evidence`）与新增的 `createLocalGraphDevelopmentArtifactPort(appHome)`（根 `appHome`）
    返回同一个惰性端口：首次访问任一成员时才构造 `EvidenceStore`。
  - 选择项构造（启动锁之前）因此不碰磁盘。之后各目录的创建时机：
    - `appHome/evidence/blobs`、`bundles/`：与今天相同，仍在应用装配时创建。开发自动化模块装配时读取证据存储的
      `contents` / `downloads` / `contexts`，取值即打开存储。
    - 图开发存储的 `appHome/blobs`、`bundles/`：今天在数字员工模块组装配时构造即建；它在装配时只登记方法，
      改为首次读写时创建。
  - 内容盘点与备份对缺目录按 ENOENT 跳过（`platform/content/inventory/manifest.ts`），已有内容与读写位置不变。
- **需求文档命令惰性打开**：`createFileEvidenceDocumentCommands` 构造时会建暂存目录 `appHome/evidence/staging`。
  - 今天开发自动化模块组装配时读取这个 getter，暂存目录随之在装配时建好。
  - 单机需求目的的 `documentCommands` 改为首次 `writeDocument` 时才构造底层命令；每次写入本来就会递归建目录，
    写入结果不变。
- **工作区内容工厂**：`source-control` 新增 `createFileWorkspaceContentEffectsFactory()`，从 `composition` 导出。
- **任务运行选择**：`task-execution/composition/localTaskRunSelection.ts` 新增 `composeLocalTaskRunSelection({ nodeRunPrompts, portArtifacts })`，返回未绑定的选择，
  由应用装配统一 `bindTaskRunRootSelection`。今天本地分支传给绑定的 `contentsFor` 返回的就是选择里的同一对提示词 / 端口产物，
  与不传等价，所以两种部署走同一条绑定。
- **归档事件读取**：`platform/background/eventsArchiveReader.ts` 新增 `createFileArchivedEventsReader()`，`read` 即
  `readArchivedEvents(Paths.logsDir, …)`；守护进程路径上任务路由从不设 `logsDir`，与今天的分支读同一目录。
- **任务归档绑定**：`TaskArchiveContentBinding.locations` 改为可选。单机只给内容、不钉根目录，调用方照旧传 `Paths` 的归档 / 运行 / 日志目录；
  托管照旧钉根目录（维护 Worker 的效果描述仍要求它）。
- **排除配置**：`source-control/composition/workspaceExcludeProfiles.ts` 新增 `composeLocalWorkspaceExcludeProfiles({ appHome })`。
  - 今天单机按 drive 请求读 `request.appHome ?? Paths.root`。
  - 请求的 `appHome` 来自运行配置：由应用的 `appHome` 起始，子任务继承，恒等于应用的 `appHome`。取 profile 的 `appHome` 等价。
- **其他**：任务删除效果、回滚快照检查器、各模块已有的本地实现，按 §2 的名字从各自 `composition` 导出，不改实现。

## 5. 守卫与测试锁

- **新锁** `T/architecture/rfc431-standalone-selections.test.ts`（AST，读全语料，带负例）：
  1. `DeploymentSelections` 的 R / N / O 分区与锁内清单逐项相等：R 无 `?` 且类型不含 `null`；N 无 `?` 且类型含 `| null`；O 有 `?`。
  2. `composeStandaloneProfile` 的 `selections` 是 `standaloneSelections(...)` 调用。
  3. `standaloneSelections` 返回的对象字面量的键恰为 R + N，N 组的值都是字面量 `null`。
  4. `S/bootstrap/`（除 `standalone.ts` 与 `crewstation*.ts`）对 R + N 的属性访问不出现以下写法，N 组只准与 `null` 比较：
     - `??` 左操作数；
     - `?.`；
     - 与 `undefined` 比较；
     - R 组与 `null` 比较。
  5. 退役标识符不出现在 `S/`：`standaloneModuleAdapters`、`DaemonModuleAdapters`、`selectTaskRunRootSelection`、
     `composeLocalTaskRunRootSelection`、`createGraphDevelopmentArtifactBinding`、`createGraphDevelopmentVerificationBinding`、
     `composeTaskRuntimeInventoryContent`，以及实施时确认零调用方后删除的其余助手。
- **RFC-394 架构锁**：`REQUIRED_OVERRIDES` 两个输入都只剩 `secretBox`。其负例（重声明 / 改可选 / 去继承 / provider 可选）照旧成立。
- **`T/helpers/deploymentSelectionSource.ts`**：`expectDeploymentSelection` 不再一律要求可选，改为按 RFC-431 分区断言该项的可选性与可空性。
  分区清单由新锁导出，单一来源。
- **`T/rfc394-deployment-profile.test.ts`**：托管键集合 61 → 62；单机 profile 断言 `selections` 的键恰为 R + N。
- **guard-manifest**：登记新锁，刷新改动过的锁的行数。
- **消费方账本**：`bootstrap/standalone.ts` 是各模块 `composition` 入口的新消费方，按装配根登记进既有账本：
  - identity-access：`rfc305-architecture-lock`、`rfc347-identity-access-runtime`；
  - development-automation：`rfc310-architecture-lock`；
  - 数字员工 OS 清单 `design/RFC-310-…/os-architecture-manifest.json`：digital-employee 与 event-center 各一条。
    event-center 只许外部引用 `composition` 根入口，所以本地观察程序工厂改从根入口导出。

## 6. 留下的债务（模块内部还有其他调用方的缺省）

以下缺省在本 RFC 后只服务模块级用例、维护 Worker 或 CLI，生产的守护进程路径总是收到选择项给的值。留给各模块所在的波次处理：

- **source-control**：
  - task-execution 内部的 `selectIsolationWorkspaceFactory` / `selectRepositoryGitWorkspaceFactory` / `selectRepositoryWorkspaceReadQueries` /
    `selectWorkspaceUploadContentFactory`：任务路由、修复、运行参与者、提交推送、上传；
  - `createWorkspaceContentScope` 的可选参数；
  - `composeWorkspaceMaintenanceCommand` 的文件系统缺省（维护 Worker 也用）；
  - `bindEmployeeCaseWorkspaceParticipant` 的效果缺省（若实施时确认只剩模块组调用，则一并改必填）。
- **task-execution**：
  - `runTaskExecutionBootRecovery` 的启动恢复族缺省（多个模块级用例直接调用）；
  - 任务路由读投影里 `archivedEvents === undefined` 的两处分支与 `sessionView` 的一处；
  - `taskDelete` / `taskDeleteRecovery` 的删除效果缺省；
  - `providerRuntime.ts` 在 `taskRunBinding` 缺省时的提示词 / 端口产物回落，以及排除配置回落；
  - 任务归档维护命令的 `content` 缺省（维护 Worker 也用）；
  - 执行合同夹具的进程缺省、动作执行环境的 `workspaceEntries` 缺省、路由层的运行清单缺省守卫。
- **development-automation**：
  - `composeDevelopmentAutomation` 的动作工作区、证据存储缺省；
  - 平台工作项的流水线证据存储缺省；
  - `gitBaselineReader` 的基线效果缺省；
  - 任务输入上传的惰性证据存储。
- **其他模块**：
  - event-center：`composeEventCenter` 的自定义观察程序缺省（模块级用例）；
  - resource-catalog：`composePluginCatalogFromAdapters` 的安装器缺省（模块级用例）；
  - collaboration：`prepareWorkspaceRollbackPlan` 的检查器缺省。

第三、四步各自立项。

## 7. 失败模式

- **托管漏给某项**：编译错误，取代今天的静默回落。
- **单机 profile 漏给 R / N**：编译错误；新锁第 3 条再从语法上兜底。
- **装配层重新补缺省**：新锁第 4 条报出，取代今天的「缺省分支悄悄生效」。
- **惰性端口首次访问失败**（建目录失败）：错误在首次使用的调用处抛出，与今天单机惰性创建的报错位置一致。

## 8. 测试策略

- **单机 profile 行为**（`T/rfc431-standalone-selections.test.ts`）：
  - 键集合恰为 R + N，N 组为 `null`；
  - 文件类实现的根目录取传入的 `appHome`（配置路径、证据两个根、员工输入、程序产物、融合工作区、插件目录、提示词目录）；
  - 构造后临时 `appHome` 下没有任何新目录；
  - 首次写证据才建 `evidence/blobs`；图开发证据写到 `appHome/blobs`。
- **托管**：托管键集合 62；`graphDevelopmentArtifacts` 与 `evidenceArtifacts` 是同一对象（托管装配函数级用例或源码锁）。
- **结构锁**：§5 新锁及其负例，RFC-394 锁的收缩。
- **回归**：只读源码的接线锁（`rfc370-*-root-*`、`rfc380`、`rfc391`、`rfc392`、`rfc394` 等）改为断言新接线；
  经测试入口注入某项的行为用例照旧覆盖默认值。
- **集中验证**：全部实现与用例写完后一次进行，内容如下：
  - 静态检查：typecheck 含 tests，eslint `--max-warnings 0`，prettier；
  - 针对性验证集：全部架构测试，加按关键词选出、读写这 45 项的用例与 HTTP 测试入口的使用方；
  - 在导出仓库里跑按已提交源码出报告的用例；
  - P0 变异 lane。
