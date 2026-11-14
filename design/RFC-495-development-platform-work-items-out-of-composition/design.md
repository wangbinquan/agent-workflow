# RFC-495 设计：开发自动化的平台工作项用例迁出 composition

## 1. 现状（HEAD `152fdcf4c`，源码实读）

`packages/backend/src/modules/development-automation/composition/digitalEmployeePlatformWorkItems.ts`，2,324 行；development-automation 组合层
控制流（F13 口径，按语法树计数）实测 491 行，这个文件占 120 行。结构：

- 第 1～50 行 import；第 52～440 行是计划、上下文与上传的 zod schema、类型和纯辅助函数（`DevelopmentReactionPlan`、`contextsOf`、
  `contextPatch`、`pendingPipelinePatch`、`reconcileStaleReviewSelection`、`platformOutput`、`reviewReplyMarker` 等），以及上传计划解析
  `recordedUploadDigest`、`resolveEmployeeUploadPlan`。
- 第 441～702 行：组合输入接口 `DevelopmentEmployeePlatformWorkItemsCompositionInput`（持久化、反应轮次查询、审批网关、流水线证据、
  图交付复验、远端、MR 效果与事实、源码控制、冲突合并等端口，外加三个可选的实现工厂与 `appHome`、`now`）。
- 第 704～2306 行：`composeDevelopmentEmployeePlatformWorkItemsFromPersistence(input)` 返回 `{ execute(plan, executionContext) }`，按
  `plan.workItemRef` 分派约 1,550 行的工作项用例；闭包开头选定工作区效果、建证据存储的懒取函数与案例目录的路径函数。
- 第 2308～2324 行：`composeDevelopmentEmployeePlatformWorkItems({ db, ... })` 用 `createEmployeePlatformWorkItemPersistence(db)` 绑定持久化
  （RFC-359 W4-D13：一份装配，两个 provider 共用）。

用例碰 infrastructure 的只有四处，都是装配：

1. 第 716 行 `selectedAutomationWorkspaceEffects(input.automationWorkspaceEffects)`：未注入时用本机文件实现，注入了不完整的工厂时报
   `automation-workspace-effects-factory-incomplete`。
2. 第 722～727 行证据存储：注入了 `evidenceArtifacts` 就用它，否则首次用到时在 `<应用根>/evidence` 建一个 `EvidenceStore`（只建一次）。
3. 第 1910～1911 行冲突复验：`businessTreeSnapshotDigest(await businessTreeSnapshot(conflict.workspacePath, factory))`。
4. `resolveEmployeeUploadPlan`（第 160 行）：`createGitBaselineReader(input.baselineRepoPath, input.baselineSha, input.repositoryBaselines)`
   读基线文件（未注入 `repositoryBaselines` 时用本机实现），`withAutomationWorkspaceEffects(factory, …)` 在一个工作区效果作用域里比对已有
   文件；调用处（第 1568 行）传入的就是第 1 处选定的 `factory`。

其余依赖都是本模块的 domain / application、shared、`@/util/hash`、`@/util/gitRef` 与 digital-employee 的 `public/types`
（`EmployeeReactionRoundQueryPort`）。文件不做直接 effect（没有 `node:` IO 包、`Bun.*`、`process.*` 与 `fetch`）；进程全局只有第 721 行
`input.now ?? Date.now` 的默认时钟。

使用方：bootstrap（`bootstrap/daemonModules/digitalEmployee.ts`）与 5 个用例只取 `composeDevelopmentEmployeePlatformWorkItems`；
`rfc396-mr-lifecycle` 取 `composeDevelopmentEmployeePlatformWorkItemsFromPersistence` 与组合输入类型。

按路径读这个文件的锁与登记（逐个读过）：`rfc317-upload-target-path-schema`（写侧边界文件之一）、`rfc321-repository-publication-ratchet`
（发布主体传递 4 次、不含 `caseOwnerUserId`）、`rfc323-adapter-boundary`（流水线与审批逻辑只经端口）、`rfc359-w4-d13-adapters`（装配里有
`PersistenceDb`、没有 provider 命名的孪生）、`rfc370-evidence-artifact-root-bindings`（`evidenceStore().materializeBundle` 一处且被 await）、
`rfc370-storage-and-worker-root-bindings`（`createGitBaselineReader` 的实参取选定的基线工厂；`workspaceOps.checkpoint` 一处、await 进
`checkpoint`）；`architecture/commons-debt.json` CC-08 的一个锚点（`:59-63`）；RFC-310 的 OS 依赖清单一条边（取 digital-employee 的
`public/types`）。`rfc317-table-ownership` 只在注释里提到这个文件（历史记述）。

## 2. 机制与落位

### D1 落 application

工作项用例是 development-automation 的应用逻辑：它编排本模块的 domain 规则与各个端口，依赖面里没有本模块的 infrastructure 以外的
越层项。RFC-294 design §3 的矩阵许 application 取本模块 domain / application 与其他模块 public 的精确入口；development-automation 的
`rfc310-architecture-lock` 只禁 application 取本模块 infrastructure 与传输层。四处 infrastructure 改为注入后，用例整体可以落 application。

### D2 新文件 `application/employeePlatformWorkItems.ts`

- 第 52～440 行原样迁入（上传计划解析的两处改动见下）。
- 组合输入接口原样迁入，改名 `DevelopmentEmployeePlatformWorkItemsInput`，四处 infrastructure 换成已选定或已绑定的输入：
  - `automationWorkspaceEffects: AutomationWorkspaceEffectsFactory`（必填，已选定）；
  - `evidenceStore: () => EvidenceArtifactPort`；
  - `businessTreeDigest: (workspacePath: string) => Promise<string>`；
  - `baselineFileReader: (baselineRepoPath: string, baselineSha: string) => BaselineFileReader`。

  `now: () => number` 改为必填（默认时钟由 composition 给）；其余字段与注释逐字不变。

- 第 704～2306 行的用例迁为 `createDevelopmentEmployeePlatformWorkItems(input: DevelopmentEmployeePlatformWorkItemsInput)`，函数体逐字，只改
  闭包开头四行：`factory` 取 `input.automationWorkspaceEffects`、`now` 取 `input.now`、`evidenceStore` 取 `input.evidenceStore`（删去懒建的
  两行），冲突复验处改为 `await input.businessTreeDigest(conflict.workspacePath)`；调用上传计划处把
  `repositoryBaselines: input.repositoryBaselines` 换成 `baselineFileReader: input.baselineFileReader`。
- `resolveEmployeeUploadPlan`：入参的 `automationWorkspaceEffects` 改为必填的已选定工厂、`repositoryBaselines` 换成 `baselineFileReader`；
  `createGitBaselineReader(…)` 换成 `input.baselineFileReader(input.baselineRepoPath, input.baselineSha)`（同一位置、同样只在有仓库上传时
  调用），`withAutomationWorkspaceEffects(factory, …)` 换成 application 已有的 `withSelectedAutomationWorkspaceEffects(factory, …)`。原来
  那两次选定作用在已选定的同一个工厂上，只做完整性校验、原样返回，去掉后行为不变。
- 新文件只交出 `DevelopmentEmployeePlatformWorkItemsInput` 与 `createDevelopmentEmployeePlatformWorkItems`；其余名字照旧模块内私有。

### D3 composition 只留装配

`composition/digitalEmployeePlatformWorkItems.ts` 留：

- `DevelopmentEmployeePlatformWorkItemsCompositionInput`：由 application 的输入类型去掉四个注入项与 `now`，再加回三个可选的实现工厂
  （`automationWorkspaceEffects?`、`repositoryBaselines?`、`evidenceArtifacts?`）与 `now?`——字段与可选性和此前逐个相同，使用方不改。
- `composeDevelopmentEmployeePlatformWorkItemsFromPersistence(input)`：选定工作区效果（原第 716 行）、懒建证据存储（原第 722～727 行逐字）、
  绑定业务树摘要（`businessTreeSnapshotDigest(await businessTreeSnapshot(workspacePath, factory))`）与基线读取
  （`createGitBaselineReader(baselineRepoPath, baselineSha, input.repositoryBaselines)`）、默认时钟 `input.now ?? Date.now`，交给
  `createDevelopmentEmployeePlatformWorkItems`；返回类型取它的返回类型。
- `composeDevelopmentEmployeePlatformWorkItems({ db, ... })` 与它的输入类型逐字不变。

这个文件不再有 `if` / `for` / `while` / `switch` / `try` / `throw`。

### D4 锁、账本与清单

- 读用例源码的锁改指新文件、断言不变：`rfc317-upload-target-path-schema` 的写侧边界文件、`rfc321-repository-publication-ratchet` 读的
  平台工作项源码、`rfc323-adapter-boundary` 的 `platformParticipant`、`rfc370-evidence-artifact-root-bindings` 的
  `evidenceStore().materializeBundle`、`rfc370-storage-and-worker-root-bindings` 的 `workspaceOps.checkpoint`。
- `rfc370-storage-and-worker-root-bindings` 的基线读取一条：调用随装配留在 composition（路径不变），前两个实参改为装配函数的参数名
  `baselineRepoPath`、`baselineSha`，第三个仍是选定的 `input.repositoryBaselines`（这条锁要的正是“三处原有基线策略收同一个选定工厂”）。
- `rfc359-w4-d13-adapters` 不改：装配文件里仍有 `PersistenceDb`，新文件不持有持久化句柄。
- `architecture/counts.json`：`composition-control-flow-development-automation` 491 → 实测（预计 371）。
- `architecture/commons-debt.json` CC-08 的 `…/composition/digitalEmployeePlatformWorkItems.ts:59-63` 按内容改指新文件（脚本逐行比对，见
  `docs/dev-gotchas.md` 的锚点一条）。
- RFC-310 的 OS 依赖清单：取 digital-employee `public/types` 的一条边由 composition 文件改指新文件。
- `guard-manifest.json` 登记 RFC-495 用例。

## 3. 清单（退出门）

迁入 `application/employeePlatformWorkItems.ts`、只在那里声明的名字：

- 交出：`DevelopmentEmployeePlatformWorkItemsInput`、`createDevelopmentEmployeePlatformWorkItems`。
- 模块内私有：`DevelopmentReactionPlan`、`employeeUploadPlanSchema`、`EmployeeUploadPlan`、`recordedUploadDigest`、`resolveEmployeeUploadPlan`、
  `candidateStateSchema`、`MergeRequestReviewThreadState`、`conflictValidationSchema`、`contextsOf`、`isTargetAwarePipelinePlan`、
  `usesMinimalToolContracts`、`contextPatch`、`pendingPipelinePatch`、`reconcileStaleReviewSelection`、`platformOutput`、`reviewReplyMarker`、
  `reviewMarkerToken`，以及较泛的 `contextSchema`、`envelopeSchema`、`issueSchema`、`Context`、`issueOf`。早已存在的同名声明逐个钉住：
  `contextsOf`（`composition/digitalEmployeeWorkspace.ts`）、`usesMinimalToolContracts`（`application/employeeTypePackage.ts`）。

`composition/digitalEmployeePlatformWorkItems.ts` 只声明 `DevelopmentEmployeePlatformWorkItemsCompositionInput`、
`DevelopmentEmployeePlatformWorkItemsBootstrapInput`、`composeDevelopmentEmployeePlatformWorkItemsFromPersistence`、
`composeDevelopmentEmployeePlatformWorkItems`，只交出其中三个（输入类型、两个装配函数）。

## 4. 用例

新增 `packages/backend/tests/rfc495-development-platform-work-items-out-of-composition-boundary.test.ts`（文件名带 `boundary`，守卫普查按
文件名认守卫），登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）里只在新文件声明（已有的同名声明逐个钉住）。
- ② composition 文件的声明与交出恰好是上面四个 / 三个；没有控制流语句（语法树）；装配函数把选定的工厂、懒建的证据存储、两个绑定与
  默认时钟交给 application 的用例。
- ③ 全部生产文件、用例（下限 2,500）与 e2e 从 composition 文件只取三个组合名字，不取迁出的名字；命名 import、type-only、re-export、
  命名空间成员与动态 import 的解构都认，带负对照。
- ④ 新文件只取 zod、shared、`@/util/hash`、`@/util/gitRef`、digital-employee 的 `public/types` 与本模块 domain / application，不取
  infrastructure、composition、IO 包，不用进程全局（`Date.now`、`process`、`Bun`、`fetch`、`globalThis`），带负对照。

行为由现有用例对拍：两个系统模拟 E2E（含冲突一支）、员工工作区交付、平台流水线收集、MR 生命周期、目的流水线落地与 RFC-370 的
根绑定用例。

## 5. 失败模式

- **注入改变了时机**：懒建证据存储、基线读取与业务树快照都只在原位置、原条件下发生（D2、D3 逐条对应原行）；选定工作区效果仍在装配
  时发生一次，不完整的工厂仍在装配时报错。
- **锁静默变空**：读源码的锁若仍指 composition，会读到一个只剩装配的短文件、断言变成“恒不含”。迁移后按文件名本身（含路径片段）与
  代码里的字符串字面量全仓再扫，逐个改指；`rfc317-upload-target-path-schema` 的“语料非空”断言（每个文件超过 1,000 字符）会挡住漏改。
- **组合输入类型漂移**：由 application 的输入类型推出，字段与可选性逐个对照；`tsc` 覆盖使用方与用例。

## 6. 取舍（可推翻）

1. **一个 application 文件**：schema、辅助函数与用例一起迁、逐字；按工作项拆分另立（§8）。
2. **默认时钟放到 composition**：新文件不用进程全局；用例里 `now()` 的调用逐字不变。
3. **基线读取注入函数**，不把基线工厂交给 application 再在那里建读取器：默认实现的选定留在 infrastructure，与 RFC-370 的三处基线策略
   一致。
4. **组合输入类型形状不变**：使用方零改动；application 的输入类型是用例真正需要的已选定 / 已绑定输入。
5. **命名** `employeePlatformWorkItems.ts`，与已有端口 `ports/employeePlatformWorkItemPersistence.ts` 同词。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是工作项用例与它的规则，落 application；composition 只留装配（选定实现、绑定端口、默认值）；不新增用例入口（用例本来就
  经 digital-employee 的平台工作项端口调用）。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-495 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明与 import，另读 composition 文件与新文件；只对这些范围宣告退出门。
- **C13**：`composition-control-flow-development-automation` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 development-automation 的第二步——平台工作项用例离开 composition，这个文件只剩装配；组合层控制流 491 → 实测。
- **留下**：`application/employeePlatformWorkItems.ts` 仍是一个按工作项分派的大函数（约 1,550 行），可按工作项拆成各自的用例；
  development-automation `composition/` 的其余 S10 范围（`digitalEmployeeWorkspace.ts` 的工作区策略、`missionOperations.ts` /
  `configOperations.ts` / `graphDeliveryBridge.ts` 的命令处理）由后继步骤承接。
