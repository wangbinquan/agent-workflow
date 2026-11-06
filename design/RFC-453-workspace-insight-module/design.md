# RFC-453 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`WI` = `S/modules/workspace-insight`，`SC` = `S/modules/source-control`，
`TE` = `S/modules/task-execution`，`CC` = `S/modules/code-capability`，`L` = `S/services`，`SD` = `L/structuralDiff`，`SH` = `packages/shared/src`。
以 RFC-452 落地后的源码（`4f0ede4c5`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：新模块 workspace-insight 的 `domain`、`engine`、`application`、`application/ports`、`infrastructure/{deep,local,crewstation}`、
  `composition`、`public/types`；source-control 的 `infrastructure/local`；task-execution 的 `application` 与 `public/queries`；shared。
- **承担的演进**：W4 B / D 第十八步——`routes/` → `services/` 清零（W4 B / D 的路由退出条件）；E5 workspace-insight 首次成模块，并把
  code-capability 兼容岛里的 code-review 产物存储收回它的 owner；source-control 的修订内容适配器不再反向依赖分析代码。
- **跨 context 边**：只有 RFC-294 给出的 workspace-insight → source-control（修订内容端口、`openContainedFileWithin`、本机修订内容装配）、
  workspace-insight → task-execution（`public/types` 的工作区 / 检查点 / 调用图读模型类型，`public/queries` 的 `readWrapperGitBaseline`、
  `TaskWorktreeLocator` 与新导出的 `compareNodeRunsForTimeline`，`public/participants` 的 `SystemAgentRunFamily` 类型）。workspace-insight →
  development-automation（code-capability）与 source-control → workspace-insight 两条值边在本 RFC 内消失前就不出现。
- **留下的债**：模块级状态原样保留（叙述的进行中 / 失败缓存、索引缓存单例、调用图索引缓存、解析器初始化）；RFC-294 E5 的持久化
  叙述作业与洞察失效事件留给后续；`L/runtime`（W5）。
- **偏离项**：无。

## 1. 文件落位

函数体原样，只改 import；「拆」表示一个旧文件的函数分到两处，逐函数原样搬。

| 原位置 | 去向 | 依据 |
| --- | --- | --- |
| `SD/impact.ts`、`bodyDelta.ts`、`classGraph.ts`、`digest.ts` | `WI/domain/structuralDiff/` 同名 | 纯函数 |
| `SD/deps/diff.ts`、`deps/manifests.ts` | `WI/domain/structuralDiff/deps/` 同名 | 纯解析 |
| `SD/store.ts` 的 `isTerminalTaskStatus` | `WI/domain/structuralDiff/terminalStatus.ts` | 纯判定；终态集合直取 shared |
| `SD/store.ts` 的 `writeStoredDiff` / `readStoredDiff` | 删除 | 只被 `T/structural-diff-store` 用；该用例改直接用本机产物存储 |
| `SD/lang/grammars.ts`（拆） | 扩展名表、`LangResolution`、`resolveLang` → `WI/domain/lang/languages.ts`；资源定位（`grammarsDir`、`runtimeWasmPath`、`grammarFilePath`）→ `WI/engine/lang/grammars.ts` | 表是纯数据；资源定位属引擎。domain 不取 `node:path`（`R2` 的 domain 禁包），`resolveLang` 改用纯字符串取扩展名，与原来的 posix `extname` 逐例相同 |
| `SD/lang/parser.ts`、`queries.ts`、`extract.ts`、`mask.ts` | `WI/engine/lang/` 同名 | tree-sitter 引擎 |
| `SD/baseline.ts`、`assemble.ts` | `WI/engine/structuralDiff/` 同名 | 基线分析与装配（调引擎） |
| `SD/callGraph/extractCalls.ts` | `WI/engine/callGraph/extractCalls.ts` | 引擎 |
| `SD/callGraph/service.ts` | `WI/engine/callGraph/expandMethod.ts` | 单方法展开（调解析器） |
| `SD/callGraph/classIndex.ts`（拆） | `inferLocalTypes` → `WI/domain/callGraph/localTypes.ts`；`scanClassDecls` / `buildClassIndex` → `SC/infrastructure/local/classDeclarationIndex.ts` | 后两者只服务 source-control 的 `classIndex()` |
| `SD/deep/scip.ts`、`deepImpact.ts` | `WI/domain/deep/` 同名 | 纯解析 / 纯计算 |
| `SD/deep/indexers.ts`（拆） | 类型、`INDEXER_SPECS`、`indexersForFiles`、`resolveIndexerBin`、`IndexerProbe`、`isWindowsBatchShim` → `WI/domain/deep/indexers.ts`；`probeIndexer` → `WI/infrastructure/deep/indexerProbe.ts` | 后者 `Bun.which` + 版本探针子进程 |
| `SD/deep/runner.ts`（拆） | `runIndexer`、`SpawnFn` → `WI/infrastructure/deep/indexerRunner.ts`；`DeepDegradedReason`、`IndexerRunResult` → `WI/domain/deep/deepIndexing.ts` | `Bun.spawn`、临时目录；两个类型 application 也要用 |
| `SD/deep/indexCache.ts` | `WI/infrastructure/deep/scipIndexCache.ts`（`IndexAnswer` 去深度索引端口，类 `implements ScipIndexAnswers`） | 缺省依赖是真实探测 / 运行 |
| `SD/deep/service.ts`（拆） | `DeepUnavailableError`、`DEEP_INDEXING_UNAVAILABLE`、`ResolvedDeepConfig` → `WI/domain/deep/deepIndexing.ts`；`DeepDeps` → 深度索引端口；`computeDeepStructuralDiff` → `WI/infrastructure/deep/deepStructuralDiff.ts` | 后者调探测 / 运行 / 缓存 |
| `SD/service.ts` | `WI/application/structuralDiff/taskStructuralDiff.ts` | 用例 |
| `SD/gitBackend.ts` | `WI/application/structuralDiff/revisionAnalysis.ts` | 经修订内容端口 + 引擎 |
| `SD/refSelect.ts` | `WI/application/structuralDiff/nodeScope.ts` | 节点范围选择（取 TE public） |
| `SD/callGraph/expandService.ts` | `WI/application/callGraph/callTargets.ts` | 用例 + 调用图索引缓存 |
| `L/codeIntel/codeIntel.ts`、`fileSymbols.ts` | `WI/application/codeIntel/` 同名 | 用例 |
| `L/codeIntel/snapshot.ts` | `SC/infrastructure/local/worktreeSnapshotDigest.ts` | 只服务 source-control 的 `snapshotDigest()` |
| `L/changeNarrative.ts` | `WI/application/changeNarrative.ts` | 用例（经注入的系统 agent 运行端口） |
| `L/worktreeFileContent.ts` | `WI/application/fileContent.ts` | 用例（归属表原登记 source-control，改 workspace-insight：它取 `MAX_ANALYZE_BYTES`，是文件符号的上游） |
| `CC/application/ports/codeReviewArtifacts.ts` | `WI/application/ports/codeReviewArtifacts.ts` | 产物存储端口 |
| `CC/infrastructure/local/fileCodeReviewArtifacts.ts` | `WI/infrastructure/local/` 同名 | |
| `CC/infrastructure/crewstation/objectCodeReviewArtifacts.ts`、`codeReviewObjectSweep.ts` | `WI/infrastructure/crewstation/` 同名 | |
| `CC/composition/codeReviewArtifacts.ts`、`crewstationCodeReviewArtifacts.ts` | `WI/composition/` 同名 | |
| `CC/public/participants.ts` | 删除 | 只导出这套存储 |
| `CC/application/ports/existingResources.ts` 的 `CodeReviewTaskExistence` | `WI/application/ports/codeReviewTaskExistence.ts` | 只有托管清扫用；`CapabilityAgentExistence` 留在 code-capability |
| `L/repoLabels.ts` | `SH/repoGroupLayout.ts`（`RepoForKey`、`canonicalRepoKeys`、`canonicalRepoKeysWire`） | 只依赖 `repoKeyWire` |
| `L/reviewRoundStart.ts` | `TE/application/reviewRoundTiming.ts`；`compareNodeRunsForTimeline` 经 `TE/public/queries` 导出 | 消费方只有 TE 与本族 |
| `L/lifecycle` 的 `TERMINAL_TASK_STATUSES`（本族一处） | 直取 shared | 那是 shared 常量的转出 |

- 迁入文件里指向同族的 `@/services/...` 取法改模块内相对路径；对 task-execution / source-control 的取法维持各自 `public/*`。
- 迁入文件里指向家族旧路径的注释同步改指新位置。

## 2. 端口与合同

- `WI/application/ports/structuralDeepIndexing.ts`：
  - `ScipIndexAnswers`——`get(q: { taskId, repoKey, snapshotDigest, indexerId, worktreePath }): Promise<IndexAnswer>`（`ScipIndexCache` 的公开
    方法；`IndexAnswer` 随之定义在端口里）；`DeepDeps`（深度结构 diff 的参数，原样，含测试注入缝）也在端口里；
  - `StructuralDeepIndexing`——`computeDeepStructuralDiff(args)`（参数即原 `computeDeepStructuralDiff` 的 `{ baseline, worktreePath, deps }`，
    `deps.cacheScope.cache` 的类型由 `ScipIndexCache` 换成 `ScipIndexAnswers`）与 `indexCache(): ScipIndexAnswers`。
- `WI/composition/structuralDeepIndexing.ts`：`composeStructuralDeepIndexing()` 绑定 `computeDeepStructuralDiff` 与 `indexCache: () => scipIndexCache()`
  ——每次调用现取单例，`resetScipIndexCache` 之后拿到的是新实例，与原来「缺省现场取单例」同语义。
- **用例的读依赖**：`CodeReviewReads` 去掉「裸工作区端口」的联合形态，产物存储 `artifacts` 与深度索引 `deep` 改为必填（修订内容
  `content` 仍可缺省为 source-control 的本机修订内容装配——那是 source-control 的 public，合法）；裸工作区端口的联合类型
  `CodeReviewReadInput` 删除。`codeReviewReads()` 随之只补 `content`。生产路径（HTTP 装配）本就都给；直调用例的测试改经
  `T/helpers/workspaceInsightReads.ts` 组本机实现。
  - `withDeep` 改接 `deep`（原来直调 `computeDeepStructuralDiff`），`getCodeIntel` 的缓存缺省由 `scipIndexCache()` 改为
    `reads.deep.indexCache()`；`getChangeNarrativeStatus` 的产物存储参数改必填。
- `WI/application/ports/taskWorkspaceInsight.ts`（经 `WI/public/types` 给路由）：
  ```ts
  interface TaskWorkspaceInsight {
    structuralDiff(taskId, scope: StructuralScope, nodeRunId: string | undefined, options: StructuralDiffOptions): Promise<StructuralDiff>
    changeNarrativeStatus(taskId): Promise<ChangeNarrativeStatus | null>
    triggerChangeNarrative(task: Task, runtime: ChangeNarrativeRuntimeSelection): Promise<ChangeNarrativeGenerating>
    fileContent(taskId, query: TaskFileContentQuery): Promise<FileContentResult>
    fileSymbols(taskId, query: FileSymbolsQuery): Promise<FileSymbolsResult>
    codeIntel(taskId, query: CodeIntelQuery): Promise<SymbolResolution>
    callTargets(taskId, methodRef: string): Promise<CallTarget[]>
  }
  ```
  返回 shared 的推导类型；查询与选项是封闭接口（`StructuralDiffOptions` 即原 `DeepOpts`，`ResolvedDeepConfig` / `DeepIndexerOverrides`
  随之进 public 类型），`FileContentResult` 原样搬进端口；不出现 `Actor`、路径、DB 或进程句柄。
- `WI/composition/taskWorkspaceInsight.ts`：`composeTaskWorkspaceInsight({ workspace, content, artifacts, worktrees, callGraphWorkspace,
  narrative: { resolveRuntime, systemAgents } })` 只做绑定（RFC-423），依赖全为必填参数（RFC-359 W1-T1）；深度索引在装配里绑本模块
  infrastructure；返回 `Object.freeze`。
- composition barrel（`WI/composition.ts`）导出 `composeTaskWorkspaceInsight`、`invalidateCallGraphIndex`、`composeLocalCodeReviewArtifacts`、
  `composeCrewStationCodeReviewArtifacts`、`composeCrewStationCodeReviewObjectSweep`、`composeStructuralDeepIndexing`。
- `WI/public/types.ts` 导出合同与它的查询 / 结果类型、`CodeReviewArtifactStore`、`StructuralDiffArtifactKey`（装配根的部署选择类型要用）。

## 3. source-control 的三处 helper

- `SC/infrastructure/local/repositoryRevisionContent.ts`：`worktreeSnapshotDigest` 与 `scanClassDecls` / `buildClassIndex` 改取同目录的新文件；
  类索引遍历的语言判定由 `resolveLang(e.name) !== null` 改为 `langIdForPath(extname(e.name)) !== null`（shared）。`extname` 的结果要么为空、
  要么只含开头一个点，`langIdForPath` 对它做的就是「小写后查表」，与 `resolveLang` 完全相同——前提是两张表的键与语言逐项相等。
- `SH/schemas/codeIntel.ts` 导出这张表（`LANG_ID_BY_EXTENSION`，只读），RFC-453 用例锁定它与 `WI/domain/lang/languages.ts` 的
  `EXT_RESOLUTION` 键集与语言逐项相等，并对点文件、多点名、大小写、无扩展名逐例比对两种判定。
- workspace-insight 里深度结构 diff 在没给快照摘要时的回落（原 `worktreeSnapshotDigest(worktreePath)`）改为
  `composeLocalRepositoryRevisionContent().bind(worktreePath).snapshotDigest()`——本机适配器的 `snapshotDigest` 就是这一调用。

## 4. 路由与装配

- `S/routes/tasks.ts`：7 个端点改调 `deps.workspaceInsight`；查询参数校验（`structuralScopeSchema`、`narrative-scope-invalid`、
  `file-content-side-invalid`、`call-target-method-required`）、`requireOperator`、`operations.get` 的 404、深度配置读取
  （`resolveStructuralDeepConfig`）与叙述 runtime 选择的配置读取留在路由；叙述的成员门（原触发函数第一句 `requireMember`）在路由里
  紧挨触发调用之前执行。`TaskRouteDependencies` 去掉 `codeWorkspace`、`codeReview`、`repositoryWorkspace`、`changeNarrative`，加
  `workspaceInsight: TaskWorkspaceInsight` 与 `changeNarrativeAccess: { requireMember(actor, taskId) }`；缺它们时分别抛
  `task-workspace-insight-not-composed` / `task-change-narrative-not-composed`。路由对任务读模型的唯一用处（调用目标的
  `callGraphWorkspace`）随合同进了装配，`taskExecutionReadModels` 依赖与它的 `task-execution-read-models-not-composed` 一并删除。
- `S/bootstrap/daemonHttpComposition.ts`：`workspaceInsight = composeTaskWorkspaceInsight({ workspace: createTaskCodeWorkspaceQueries(db),
  content / artifacts: input.selections 的同名对象, worktrees: createTaskWorktreeLocator(db), callGraphWorkspace:
  taskExecutionProvider.readModels.callGraphWorkspace, narrative: { resolveRuntime, systemAgents } })`——与原来路由拿到的是同一批对象；
  `changeNarrativeAccess.requireMember` 原样（`resolveCollaborationTaskAccess` → 404 / 403）。
- `standalone.ts`、`crewstation.ts`、`crewstationMaintenance.ts`、`deploymentProfile.ts`、`daemonApplication.ts`、`maintenanceWorkerGraph.ts`
  改从 workspace-insight 的 composition barrel / `public/types` 取产物存储装配、托管清扫与 `invalidateCallGraphIndex`。

## 5. 守卫、账本与用例

- **新用例** `T/rfc453-workspace-insight-module.test.ts`：旧文件（32 + 2 + code-capability 7 个）不存在且 `S` 下零引用（census AST，
  别名与相对路径都认，带负对照）；`S/routes` 下零个文件 import `services/`；source-control 不 import workspace-insight；语言表相等与
  两种判定逐例等价，`resolveLang` 的纯字符串取扩展名与原来的 posix `extname` 逐例相同（目录名带点、点文件、尾随斜杠、`..`）；
  `composeTaskWorkspaceInsight` 缺依赖在类型层不可表达、结果冻结；合同 7 个方法的转发（选项、产物存储、修订内容、
  调用图读模型、runtime 选择逐一落到原调用的参数上）；深度索引端口每次现取单例；TE 的时间线比较器与 shared 的 repo key 经新入口可用。
- **账本**：架构报告 legacy 归属表删去 34 条；`rfc376-structural-guards` 的精确清单、`guard-manifest.json` 受影响守卫的行数、
  `commons-manifest.json` 里的文中路径、`windows-platform.yml` 的触发清单（`changeNarrative.ts`）随迁移刷新；`commons-debt` 的 `R1` / `R2`
  按实测（本族只取模块 public，预计不变）。
- **随迁的文本锁**：结构 diff 的深度源锁与嵌入守卫、RFC-349 的 code-capability provider 边界与 repository workspace 锁、RFC-331 的
  legacy 消费方清单、RFC-339 的源码锁、RFC-284 的 spawn 点账本与 sha256 微助手清单、RFC-254 平台面豁免、RFC-359 W5 的 void promise 账本、
  RFC-395 检查点边界与 O3 跨 context 闭包、RFC-394 部署选择、RFC-349 路由失败关闭锁、RFC-370 V16 的路由装配锁（缺
  `workspaceInsight` / `changeNarrativeAccess` 各报各的错误码），逐个改指新位置 / 新错误码。
- **用例的 import 与直调**：52 个用例文件改从新位置取（拆开的文件按导入名分到新位置）；直调用例的测试经
  `T/helpers/workspaceInsightReads.ts` 组读依赖；`structural-diff-store` 改用本机产物存储；叙述用例的触发 helper 保留「先成员门、后触发」
  的路由顺序。

## 6. 失败模式

- 求值环：模块内取值不经本模块 public（RFC-452 的教训）；barrel 只被装配根 import；
- 层：`application` 不取 `infrastructure`（深度索引与本机产物存储只经端口 / 装配），起子进程的文件全在 `infrastructure`——
  `module-layer-violations` 与 `application-direct-effect-files` 的精确清单兜底；
- off-DAG：`context-value-pairs-off-dag` 上限 0、source-control → workspace-insight 由新用例兜底；
- 语言判定漂移：表相等用例兜底；
- domain 取宿主模块（`node:path` / `node:fs` 等）：`R2` 账本逐条相等兜底（集中验证时它查出 `languages.ts` 取了 `node:path`）；
- 漏改的文本锁 / 清单：集中验证全量跑，`test-suite-policy` 与 `ci-workflow-path-filters` 兜底。

## 7. 测试策略

- 迁移的家族与产物存储：既有用例改 import 后全部复跑（SQLite 全量 + PostgreSQL 受影响面）；
- 路由：结构 diff / 叙述（读与触发，含成员门的 403 / 404）/ 文件正文 / 文件符号 / 代码智能 / 调用目标的 HTTP 用例原样通过；
- 新用例见 §5；P0 变异 lane 两引擎各 17 阶段符合预期。
