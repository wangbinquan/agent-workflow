# RFC-508 设计：开发自动化的流水线证据端口与 MR 事实采集迁出 composition

## 1. 现状（HEAD `155d8c0fc`，源码实读）

development-automation 组合层控制流（F13 口径，按语法树计数）119 行；本 RFC 的两个文件占 17 行，都不在 `composition-forbidden-import-files`
里：

- `pipelineEvidence.ts` 9 行：第 24 行 `for`，33、35、52、61、70、79 行 `if`，50、68 行 `try`。
- `developmentDelivery.ts` 8 行：第 84、129、136、140、142 行 `if`，130、143、145 行 `throw`（第 136 行的 `if` 与 `throw` 同一行，按一行计）。

**`composition/pipelineEvidence.ts`，84 行**：

- 第 1～7 行 import：`SelectedPipelineEvidenceExecution` 类型取自本模块的 `composition.ts`（它从 integration 的 public participants 转出），
  `PipelineEvidencePort`、`PipelineStagingFactories` 类型，`assertEvidenceStagingFactory` 与 `assertEvidenceStagingLease`（application）。
- 第 8～11 行从 `infrastructure/local/legacyPipelineEvidence.ts` 转出旧实现 `composeLegacyDevelopmentPipelineEvidence` 与类型
  `LegacyPipelineEvidencePort`。
- 第 13～84 行 `composeSelectedDevelopmentPipelineEvidence(runner, staging)`，返回 `{ pipelineEvidence }`：
  - 第 19～22 行类型 `RunnerFailure`（执行面 collect 失败分支的 `failure`），第 23 行 `failed(failure)`；
  - 第 24～25 行逐个核对 collect / trigger / rerun 三个暂存工厂（`assertEvidenceStagingFactory`）；
  - 第 28～45 行 `collect`：`staging.collect.create()`（可能是 promise），核对暂存属于该工厂的命名空间，带 `staging: parent.reference` 调用
    `runner.collect`；失败时关闭暂存（`close()` 返回 promise 就等它）再返回 `failed(out.failure)`；成功时返回 envelope、暂存、输出预算与
    `cleanup: () => parent.close()`；
  - 第 46～63 行 `trigger`、第 64～81 行 `rerun`：同样分配与核对暂存，`try` 里调用执行面，失败返回 `failed(out.failure)`，成功取 envelope 的
    `runRef`、`providerReceiptRef` 与 `adopted`（rerun 是 `runRef`、`attempt` 与 `providerReceiptRef`）；`finally` 里关闭暂存并等它。
- 使用方：本模块 `composition/developmentDelivery.ts` 的 `composeDevelopmentPipelineDeps`；用例 `rfc370-purpose-staging-lifecycle`、
  `rfc370-purpose-published-bindings` 直接调装配入口。

**`composition/developmentDelivery.ts`，193 行**：

- 第 1～4 行文件头注释（RFC-471），第 6～23 行 import（含 `canonicalDigest`、`projectMrCells` 与 `@/util/hash` 的 `sha256Hex`），第 25 行
  类型 `PipelineEvidenceExecution`。
- 第 27～119 行 `composeDevelopmentDeliveryDeps(deps)`，签名第 27～75 行（返回类型里写出 `mrFacts.collect` 的完整结果形状）：
  - 第 76 行 `provider`，第 77～79 行 `repoRemote`（转给 `provider.resolveRepository`）；
  - 第 80～111 行 `mrFacts.collect(repositoryId, mrRef, selfMarker)`：调 `deps.mrFacts.collect(repositoryId, mrRef, { selfMarker })`，失败
    （第 84 行）原样返回；成功时映射快照的 8 个字段，`unresolvedReviewCount` 数未解决且作者不是 `self` 的线程，`reviewThreads` 映射线程
    （`body` 取 `lastBody`）；
  - 第 112～118 行交出 `repoRemote`、`mrEffects`（原样）、`mrFacts` 与 `composeDevelopmentPipelineDeps(provider.pipeline, deps.staging)` 的
    `pipelineEvidence`。
- 第 121～171 行 `composeDevelopmentMrFactsCollector(deps)`，返回 `{ mergeRequestFacts }`；第 125 行 `provider`，第 128～168 行 `collect(input)`：
  - `input.mrClaimId === null` 抛 `mission <id> has no MR claim to collect facts for`；
  - `provider.readMrFactTarget` 为 null 抛 `mr claim <id> or mission not found`；
  - `deps.mrFacts.collect(target.repositoryId, target.mrIid, { selfMarker: input.missionId })` 失败时，`code-host-connection-missing` 抛
    `no code-host binding for repository <id>`，其余抛 `mr facts collect failed: <code>: <detail>`；
  - 成功时 `snapshotRef = canonicalDigest(snapshot)`、`now = Date.now()`；`cells` 在没有头提交时为 `{}`，否则
    `projectMrCells({ ...snapshot, headSha }, 0, snapshotRef, now)`；线程带 `bodyDigest = sha256Hex(lastBody)`。
- 第 173～193 行 `composeDevelopmentPipelineDeps` 的两个重载与实现：没有暂存时用旧实现，有暂存时用选定实现（三元式，不计入 F13）。
- 使用方：bootstrap `daemonModules/developmentAutomation.ts` 调三个入口、`daemonModules/digitalEmployee.ts` 调 `composeDevelopmentDeliveryDeps`
  （两处的实参由 RFC-471 用例按文本钉住）；用例 `rfc471-development-delivery-code-host-bridge` 直接调 `composeDevelopmentDeliveryDeps` 与
  `composeDevelopmentMrFactsCollector`，并读本文件的 import；RFC-321 发布棘轮与 RFC-349 provider 边界读本文件的原文做“不出现”断言。

## 2. 机制与落位

### D1 实现落 application

流水线证据端口的选定实现只编排本模块的暂存端口与一个外部执行面；MR 事实的读取与采集只经本模块的事实源端口与 domain 的摘要、投影。两者都没有
IO，是 application 的端口实现；不需要新的 infrastructure。

### D2 端口：integration 执行面的结构同形

`composition/pipelineEvidence.ts` 的入参类型 `SelectedPipelineEvidenceExecution` 来自 integration 的 public participants。development-automation
到 integration 的方向不在 context DAG 上：每个取 integration public 的文件都记一条 `off-dag-offered-file-context-pairs`（现有 45 条，本模块的
`composition.ts`、`infrastructure/developmentDeliveryProvider.ts` 与 `infrastructure/local/legacyPipelineEvidence.ts` 各一条）。新的 application
文件若直接取它会多一条。所以按本模块既有做法（`application/ports/developmentDelivery.ts` 的 MR 事实端口、`PipelineEvidencePort` 本身都是
integration 的结构同形）：

- **`application/ports/reconcilerPorts.ts`** 在 `PipelineEvidencePort` 之后增 `SelectedPipelineEvidenceRunnerPort`：collect / trigger / rerun 三个
  方法，入参是 `PipelineEvidencePort` 对应方法的入参加 `staging: EvidenceStagingReference`；结果是成功时带 `envelope`（collect 另带
  `outputBudget`），失败时带 `failure: OperationFailureReceipt`。collect 的 envelope 是 `PipelineCollectEnvelopeDto`；trigger 的 envelope 只写
  实现读的 `runRef`、`providerReceiptRef`、`adopted`，rerun 的只写 `runRef`、`attempt`、`providerReceiptRef`。
- integration 的 `SelectedPipelineEvidenceExecution` 按结构满足它（现有代码已把它的 envelope 与失败放进 `PipelineEvidencePort` 的结果、把本模块的
  暂存引用传给它，由 `tsc` 在装配处核对）；组合文件仍取 integration 的类型，application 不取。

### D3 新位置

- **`application/selectedPipelineEvidence.ts`**（新）：`createSelectedPipelineEvidence(runner, staging)`，`runner` 是
  `SelectedPipelineEvidenceRunnerPort`，`staging` 是 `PipelineStagingFactories`，返回 `PipelineEvidencePort`。函数体是原第 19～25 行与
  第 28～81 行的三个方法逐字；原来包在 `{ pipelineEvidence: { … } }` 里的端口对象改为直接返回。
- **`application/developmentMrFacts.ts`**（新）：
  - `createDevelopmentMrFacts(deps: DevelopmentMrFactsDependencies)`：返回带 `collect(repositoryId, mrRef, selfMarker)` 的对象，方法体是原
    第 81～110 行逐字；`deps` 只有 `mrFacts: DevelopmentMrFactsSourcePort`。
  - `createDevelopmentMrFactsCollector(deps: DevelopmentMrFactsCollectorDependencies): MergeRequestFactsCollectorPort`：函数体是原第 125 行与
    第 128～168 行的方法逐字，原来包在 `{ mergeRequestFacts: { … } }` 里的端口对象改为直接返回；唯一的替换是 `Date.now()` → `deps.now()`。
    `deps`：`provider`（只要 `readMrFactTarget`，以结构类型写出，与交付 provider 的同名方法同形）、`mrFacts`、`now: () => number`。

### D4 composition 只装配

- `composeSelectedDevelopmentPipelineEvidence(runner, staging)` 的签名与返回形状不变：`return { pipelineEvidence: createSelectedPipelineEvidence(runner, staging) }`。
  三个暂存工厂的核对仍在装配时（创建时）做。旧实现的转出不变。
- `composeDevelopmentDeliveryDeps(deps)` 的签名（含返回类型里写出的 `mrFacts` 形状）不变：`const mrFacts = createDevelopmentMrFacts({ mrFacts: deps.mrFacts })`；
  `repoRemote`、`mrEffects` 与 `pipelineEvidence` 不变。
- `composeDevelopmentMrFactsCollector(deps)` 的签名不变：`return { mergeRequestFacts: createDevelopmentMrFactsCollector({ provider: deps.provider, mrFacts: deps.mrFacts, now: () => Date.now() }) }`。
- `composeDevelopmentPipelineDeps` 不变。
- 不再用到的 import 删去：`assertEvidenceStagingFactory`、`assertEvidenceStagingLease`、`canonicalDigest`、`projectMrCells` 与 `sha256Hex`。
  `developmentDelivery.ts` 文件头注释里“MR 事实的 cell 投影、快照摘要与线程摘要只在这里做”改为指向新位置。

### D5 锁与账本

- `architecture/counts.json`：`composition-control-flow-development-automation` 119 → 实测（预计 102）。`guard-manifest.json` 登记 RFC-508 用例
  （它断言名字不在别处声明、组合文件没有控制流，条目标 `assertsAbsence: true`）。
- 不改：RFC-471 用例（读 `developmentDelivery.ts` 的 import 不含 integration、DA 的 public 不转出选定实现、bootstrap 的实参文本，并直接调两个
  装配入口）；RFC-321 发布棘轮与 RFC-349 provider 边界（读 `developmentDelivery.ts` 的原文做“不出现”断言，迁走代码后仍成立）；RFC-370 的两个
  用例（直接调 `composeSelectedDevelopmentPipelineEvidence`）；`design/` 里的历史记述。

## 3. 清单（退出门）

| 位置（`packages/backend/src/modules/development-automation/` 下） | 声明并交出                                                                                                                                   | 只声明不交出 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `application/selectedPipelineEvidence.ts`（新）                   | `createSelectedPipelineEvidence`                                                                                                             | —            |
| `application/developmentMrFacts.ts`（新）                         | `DevelopmentMrFactsDependencies`、`createDevelopmentMrFacts`、`DevelopmentMrFactsCollectorDependencies`、`createDevelopmentMrFactsCollector` | —            |
| `application/ports/reconcilerPorts.ts`（增一个名字）              | `SelectedPipelineEvidenceRunnerPort`                                                                                                         | —            |

允许的形状：两个组合文件没有 if / for / while / do / switch / try / throw 语句，从新位置取实现；`pipelineEvidence.ts` 仍声明并导出
`composeSelectedDevelopmentPipelineEvidence`、转出旧实现的两个名字；`developmentDelivery.ts` 仍声明并导出 `composeDevelopmentDeliveryDeps`、
`composeDevelopmentMrFactsCollector` 与 `composeDevelopmentPipelineDeps`（含两个重载）。

## 4. 用例

新增 `packages/backend/tests/rfc508-delivery-pipeline-evidence-mr-facts-out-of-composition-boundary.test.ts`（文件名带 `boundary`），
登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的位置声明；两个新文件恰好声明、交出清单列的名字；
  两个组合文件只声明并导出原有的装配入口，`pipelineEvidence.ts` 转出的两个名字不变。
- ② 两个组合文件没有控制流语句，也不再出现迁走的代码要的 `assertEvidenceStagingFactory`、`assertEvidenceStagingLease`、`canonicalDigest`、
  `projectMrCells` 与 `sha256Hex`；`Date.now` 只在交给采集的时钟里出现一次；三个新入口在生产代码里都只在组合文件调用一次，实参逐字钉住；
  带负对照。
- ③ 新代码的依赖面是闭集：两个新文件只取本模块的 domain、application、`application/ports` 与 `@/util/hash`，不用进程全局；新端口类型所在的
  `reconcilerPorts.ts` 不取 integration；带负对照。
- ④ 行为（直接调用新位置，端口用内存替身）：
  - 流水线证据：三个暂存工厂任一不合格时创建就抛；collect 失败时先关闭暂存（等待异步关闭）再返回原失败，成功时交出原 envelope、暂存与输出
    预算，`cleanup` 关闭暂存；trigger / rerun 在成功、失败与执行面抛错时都关闭暂存一次，成功时返回的字段与 envelope 对应；暂存的分配可以是
    同步值或 promise；
  - MR 事实读取：失败原样返回；成功时映射 8 个字段，未解决计数不含已解决与 `self` 的线程，线程的 `body` 取 `lastBody`；
  - MR 事实采集：四条错误文案逐字；成功时 `snapshotRef` 是快照的 `canonicalDigest`，没有头提交时 `cells` 为空，否则与按同一时钟投影的结果
    相同，线程带 `bodyDigest`。

行为另由现有用例对拍：`rfc471-development-delivery-code-host-bridge` 经两个装配入口走 MR 事实读取与采集，`rfc370-purpose-staging-lifecycle`
与 `rfc370-purpose-published-bindings` 经装配入口走流水线证据的暂存生命周期与已发布内容。

## 5. 失败模式

- **用例走样**：函数体逐字迁移；collect 里“先关闭再返回失败”的次序、trigger / rerun 的 `try` / `finally`、`'then' in allocation` 的判断、
  采集的错误判断次序与错误串都原样保留；唯一的替换是采集的时钟。
- **端口类型不够宽或不够窄**：结构同形的端口若与 integration 的执行面不相容，装配处 `tsc` 报错；端口只写实现读到的字段，不写实现不读的。
- **晚绑定**：原来 `deps.mrFacts` 在调用时从装配入参读；改为装配时取出交入。两个装配入口的入参都是装配根与用例现写的对象字面量，没有别处
  持有它们，取出时机不同不可观察。时钟在采集时调用，与原来读 `Date.now()` 的时机相同。
- **对象字段走样**：交出的 `pipelineEvidence`、`mrFacts` 与 `mergeRequestFacts` 的字段名与签名逐个保留，由 `tsc` 与 RFC-471、RFC-370 用例覆盖。
- **遗留引用**：装配入口不变，使用方不改；迁移后按名字、路径片段与代码里的字符串字面量全仓再扫，另按全部文件类型扫一遍。
- **按原始文本扫的锁误计**：新文件的注释不写组合文件的路径（RFC-506 的教训）。
- **账本漏标**：guard-manifest 条目标 `assertsAbsence: true`（RFC-507 集中验证的教训）。

## 6. 取舍（可推翻）

1. **两个文件一步**：两者都是开发交付依赖的装配，`developmentDelivery.ts` 经 `composeDevelopmentPipelineDeps` 取 `pipelineEvidence.ts`；一并迁移后
   组合层不再有循环。`graphDeliveryLifecycle.ts`、`graphDeliveryJob.ts` 属于图交付，另立。
2. **执行面用结构同形的端口**：不让 application 取 integration（会多一条 off-DAG 的文件对），与本模块 MR 事实端口的做法一致。
3. **时钟由装配传入**：与 RFC-505、RFC-506 的做法一致，新位置不读进程全局；组合文件交入 `() => Date.now()`。
4. **端口对象直接返回**：新函数返回端口本身，组合文件保留 `{ pipelineEvidence }`、`{ mergeRequestFacts }` 的包装与签名，使用方不改。
5. **MR 事实的读取与采集放一个文件**：两者都把同一个事实源端口的结果映射给 mission 一侧，依赖面相同。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是流水线证据端口的实现与 MR 事实的读取、采集，都落 application；两个组合文件只装配、没有控制流；不新增用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-508 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读两个组合文件、两个新位置与 `reconcilerPorts.ts`；只对这些范围宣告
  退出门。
- **C13**：`composition-control-flow-development-automation` 收紧到实测；其余触及的计数不升（`off-dag-offered-file-context-pairs` 与跨 context
  import 不变）。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 development-automation 的第七步：开发交付的流水线证据端口与 MR 事实采集离开 `composition/`；组合层不再有循环。
- **留下**：`graphDeliveryLifecycle.ts`、`activityOperations.ts`、`graphDeliveryJob.ts`、`evidenceStaging.ts`、`employeeCaseDetailProjection.ts`
  （连同 `detailProjection` 与 `digitalEmployeeWorkspace.ts`）、`executionTerminalObserver.ts` 与 `repositoryFactsScanner.ts` 的余项由后继承接；
  `crewstation*` / `taskImage*` 待 RFC-370 余项；task-execution、source-control 与 resource-catalog 的余项与 S10 收口另立。
