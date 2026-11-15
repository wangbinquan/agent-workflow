# RFC-496 设计：开发自动化的员工工作区用例迁出 composition

## 1. 现状（HEAD `a8e04f58f`，源码实读）

`packages/backend/src/modules/development-automation/composition/digitalEmployeeWorkspace.ts`，1,418 行；development-automation 组合层
控制流（F13 口径，按语法树计数）实测 371 行，这个文件占 97 行。结构：

- 第 1～32 行 import；第 34～124 行是工作区策略、计划、尝试、Issue 上下文、输入信封、上下文记录与 MR 上下文的 zod schema。
- 第 125～596 行：快照的序列化与还原、受保护目录与跳过前缀、冻结平台产物（需求与流水线输入）的解析与复制、Issue / MR 上下文解析、
  业务改动集、`directoryContainsFile`、改动校验 schema、仓库准备端口，以及 Case 工作区读侧（`detailReader` 与两个交出的类型），
  末尾 `createDevelopmentEmployeeCaseWorkspaceDetailReader(db)` 用 `createEmployeeWorkspacePersistence(db)` 绑定持久化。
- 第 597～673 行：组合输入接口 `DevelopmentEmployeeWorkspaceCompositionInput`（持久化、反应轮次查询、输入产物、仓库准备、源码控制、
  冲突合并、图交付复验等端口，外加可选的工作区效果工厂、`appHome` 与 `now`）。
- 第 674～1403 行：`composeDevelopmentEmployeeWorkspaceFromPersistence(input)` 返回工作区参与方（准备、快照、校验、回退等）。
- 第 1404～1418 行：`composeDevelopmentEmployeeWorkspace({ db, ... })` 绑定持久化（RFC-359 W4-D13）。

用例碰 infrastructure 的地方：

1. 第 677 行 `selectedAutomationWorkspaceEffects(input.automationWorkspaceEffects)`；之后 6 处 `withAutomationWorkspaceEffects(factory, …)`
   （含 `directoryContainsFile`），传入的都是这一个已选定的工厂。
2. `infrastructure/protectedSnapshot.ts`：`snapshotProtectedRoots`（3 处）、`protectedRootSnapshotDigest`、类型 `ProtectedRootSnapshot`。
3. `infrastructure/workspaceValidator.ts`：`businessTreeSnapshot`（3 处）、`businessTreeSnapshotDigest`（2 处）、`validateWorkspaceOutcome`。
4. `infrastructure/attemptSupport.ts` 的常量 `GIT_METADATA_SKIP_PREFIXES`（第 200 行）。
5. `createEmployeeWorkspacePersistence(db)`（读侧与 bootstrap 装配两处，都是装配）；进程全局只有第 679 行 `input.now ?? Date.now`。

两个快照 / 校验文件（171 行、329 行）不取 IO 包、`Bun.*`、`process.*`：快照与校验都经工作区效果端口读文件；三个开作用域的函数
`snapshotProtectedRoots`、`businessTreeSnapshot`、`validateWorkspaceOutcome` 先看工厂有没有远端树操作（RFC-370 §9.2 V3，有就交给远端
一次做完），没有再 `withAutomationWorkspaceEffects(factory, …)`——未给工厂时这里选本机文件实现，这是它们唯一的 infrastructure 依赖。
使用方：本文件、`composition/digitalEmployeePlatformWorkItems.ts`（RFC-495 的业务树摘要绑定）、`composition/taskImageWorkspace.ts`、
`infrastructure/attemptSupport.ts`、`infrastructure/graph-development/employeeWorkspace.ts` 与 4 个用例；`taskImageWorkspace` 与用例里有不给
工厂、靠缺省选本机实现的调用。

三组常量 `PLATFORM_OWNED_GIT_METADATA_PREFIXES`、`RUNTIME_OWNED_GIT_METADATA_PREFIXES`、`GIT_METADATA_SKIP_PREFIXES`（`attemptSupport.ts`
第 53～82 行）是平台与运行时各自拥有、`git-meta` 受保护目录对拍时跳过的路径，不依赖任何东西；使用方是 `attemptSupport.ts` 本身、
本文件、`graph-development/employeeWorkspace.ts` 与 `rfc370-runtime-git-cache-protected-root` 用例。

工作区文件的使用方：bootstrap（`bootstrap/daemonModules/digitalEmployee.ts`）取 `composeDevelopmentEmployeeWorkspace` 与
`createDevelopmentEmployeeCaseWorkspaceDetailReader`；`composition/graphDevelopment.ts` 与 1 个用例取后者；6 个用例取前者；
`composition/employeeCaseDetailProjection.ts` 取读侧的两个类型。

按路径或内容读这个文件的锁与登记（逐个读过）：`rfc317-upload-target-path-schema`（写侧边界文件，`targetPath` 不得裸声明 zod）、
`rfc323-adapter-boundary`（标准 Issue 入口不取需求来源获取端口）、`rfc359-w4-d13-adapters`（装配里有 `PersistenceDb`）、
`rfc370-storage-and-worker-root-bindings`（`sourceControl.checkpoint` 两处、都被 await）、RFC-494 与 RFC-495 用例钉住的同名声明
（`mergeRequestContextSchema`、`contextsOf`）、`architecture/commons-debt.json` CC-08 的两个锚点（`:57-70`、`:323-327`）、RFC-310 的 OS
依赖清单一条边（取 digital-employee 的 `public/types`）。两个快照 / 校验文件与三组常量没有按路径读它们的锁。

## 2. 机制与落位

### D1 用例落 application

与 RFC-495 相同：工作区用例编排本模块的 domain 规则与各个端口，属于 application；RFC-294 design §3 的矩阵许 application 取本模块
domain / application 与其他模块 public 的精确入口，`rfc294-review-module-layer-rules` 与 development-automation 的 `rfc310-architecture-lock`
只禁 application 取 infrastructure（值与类型）、composition 与传输层。

### D2 新文件 `application/employeeWorkspace.ts`

- 第 34～588 行原样迁入（`directoryContainsFile` 的一处改动见下）；`detailReader` 改名 `createEmployeeCaseWorkspaceDetailReader` 并交出，
  `DevelopmentEmployeeWorkspaceParticipant` 交出；第 590～595 行的数据库绑定留在 composition。
- 组合输入接口原样迁入，改名 `DevelopmentEmployeeWorkspaceInput`：`automationWorkspaceEffects` 改为必填（已选定），`now` 改为必填（默认
  时钟由 composition 给）；其余字段与注释逐字不变。
- 第 674～1402 行的用例迁为 `createDevelopmentEmployeeWorkspace(input: DevelopmentEmployeeWorkspaceInput)`，函数体逐字，只改闭包开头两行：
  `factory` 取 `input.automationWorkspaceEffects`、`now` 取 `input.now`。
- 6 处 `withAutomationWorkspaceEffects(factory, …)` 换成 application 已有的 `withSelectedAutomationWorkspaceEffects(factory, …)`：传入的都是
  装配时选定的同一个工厂，`selectedAutomationWorkspaceEffects` 对它只校验三个方法、原样返回，去掉后行为不变（RFC-495 D2 同理）。
- 快照、校验与常量改取 application / domain 的同名文件（D3、D4）。

### D3 快照与校验归 application

- `infrastructure/protectedSnapshot.ts`、`infrastructure/workspaceValidator.ts` 的全部内容原样迁入 `application/protectedSnapshot.ts`、
  `application/workspaceValidator.ts`。只改三个开作用域的函数：工厂参数改为必填（已选定），远端树操作的判断逐字照旧，本机一支由
  `withAutomationWorkspaceEffects(factory, …)` 换成 `withSelectedAutomationWorkspaceEffects(factory, …)`；`workspaceValidator` 取快照改取同层文件。
- infrastructure 的两个同名文件只留：
  - 三个缺省选本机实现的包装（名字、参数与返回不变）：`factory?.treeOperations` 存在时把工厂原样交给 application 的同名函数（远端优先、
    不校验，与此前相同），否则交 `selectedAutomationWorkspaceEffects(factory)`（未给时选本机文件实现，给了不完整的工厂时照旧报
    `automation-workspace-effects-factory-incomplete`）。本机文件实现没有 `treeOperations`，结果与此前逐支相同。
  - `taskImageWorkspace` 要用的三个转出（`serializeProtectedRootSnapshot`、`reviveWorkspaceValidationInput`、类型
    `SerializedWorkspaceValidationInput`）：这个文件归 RFC-370 余项、逐个避让，不改它的 import；转出记为债（§8）。
- 其余使用方改取 application：`attemptSupport.ts`（在作用域内读快照、校验与类型）、`graph-development/employeeWorkspace.ts`（序列化与
  还原）、RFC-495 的业务树摘要绑定（选定的工厂，改取 application 的两个函数）、4 个用例里的纯函数与类型；不给工厂的调用照旧取
  infrastructure 的包装。

### D4 常量归 domain

`attemptSupport.ts` 第 53～82 行（三组常量与注释）原样迁入 `domain/gitMetadataOwnership.ts`；`attemptSupport.ts`、
`graph-development/employeeWorkspace.ts`、工作区用例与 `rfc370-runtime-git-cache-protected-root` 改取 domain，原位置不留转出。

### D5 composition 只留装配

`composition/digitalEmployeeWorkspace.ts` 留：

- `DevelopmentEmployeeWorkspaceCompositionInput`：由 application 的输入类型去掉 `automationWorkspaceEffects` 与 `now`，再加回两个可选字段——
  字段与可选性和此前逐个相同。
- `composeDevelopmentEmployeeWorkspaceFromPersistence(input)`：选定工作区效果（原第 677 行）、默认时钟 `input.now ?? Date.now`，交给
  `createDevelopmentEmployeeWorkspace`；返回类型取 application 交出的参与方类型。
- `createDevelopmentEmployeeCaseWorkspaceDetailReader(db)`：`createEmployeeCaseWorkspaceDetailReader(createEmployeeWorkspacePersistence(db))`。
- `composeDevelopmentEmployeeWorkspace({ db, ... })` 与它的输入类型逐字不变。

这个文件不再有 `if` / `for` / `while` / `switch` / `try` / `throw`。`employeeCaseDetailProjection.ts` 的两个读侧类型改取 application；
bootstrap、`graphDevelopment.ts` 与用例不改。

### D6 锁、账本与清单

- 读用例源码的锁改指 `application/employeeWorkspace.ts`、断言不变：`rfc317-upload-target-path-schema` 的写侧边界文件、`rfc323-adapter-boundary`
  的 `workspaceParticipant`、`rfc370-storage-and-worker-root-bindings` 的 `sourceControl.checkpoint`（两处）。`rfc359-w4-d13-adapters` 不改
  （装配文件仍有 `PersistenceDb`）。
- RFC-494 / RFC-495 用例里钉住的同名声明（`mergeRequestContextSchema`、`contextsOf`）改指新文件。
- `architecture/counts.json`：`composition-control-flow-development-automation` 371 → 实测（预计 274）。
- `architecture/commons-debt.json` CC-08 的两个锚点按内容改指新文件（脚本逐行比对）。
- RFC-310 的 OS 依赖清单：取 digital-employee `public/types` 的一条边由 composition 文件改指新文件。
- `guard-manifest.json` 登记 RFC-496 用例。

## 3. 清单（退出门）

- **`application/employeeWorkspace.ts`**：交出 `DevelopmentEmployeeWorkspaceInput`、`DevelopmentEmployeeWorkspaceParticipant`、
  `createDevelopmentEmployeeWorkspace`、`DevelopmentEmployeeCaseWorkspaceDetailRow`、`DevelopmentEmployeeCaseWorkspaceDetailReader`、
  `createEmployeeCaseWorkspaceDetailReader`；模块内私有：`workspacePolicySchema`、`planSchema`、`attemptSchema`、`issueContextSchema`、
  `inputEnvelopeSchema`、`contextRecordSchema`、`mergeRequestContextSchema`、`SerializedPreState`、`serializeProtected`、`reviveProtected`、
  `rootsOf`、`skipPrefixes`、`FrozenPlatformArtifactRef`、`REQUIREMENT_ARTIFACT_PREFIX`、`PIPELINE_ARTIFACT_PREFIX`、
  `parseFrozenPlatformArtifactRef`、`frozenPlatformArtifactRefs`、`requirePlainDirectory`、`requirePlainDirectoryPath`、
  `ensurePlainDirectoryPath`、`copyFrozenPlatformEntry`、`hydrateFrozenPlatformArtifacts`、`hasImplementationPlanReview`、
  `preStateWithFrozenPlatformArtifacts`、`contextsOf`、`resolveIssue`、`resolveMergeRequest`、`businessDelta`、`businessChangedPaths`、
  `directoryContainsFile`、`changedWorkspaceValidationSchema`、`RepositoryPreparationPort`。早已存在的同名声明逐个钉住：`planSchema`、
  `attemptSchema`、`inputEnvelopeSchema`、`RepositoryPreparationPort`（task-execution）、`contextRecordSchema`
  （`application/digitalEmployeeToolContractProjectionV2.ts`）、`mergeRequestContextSchema`（`application/employeeTypePackage.ts`）、
  `contextsOf`（`application/employeePlatformWorkItems.ts`）、`SerializedPreState`、`serializeProtected`、`reviveProtected`
  （`infrastructure/attemptSupport.ts`）。
- **`application/protectedSnapshot.ts`**：`ProtectedRootSnapshot`、`SnapshotViolation`、`protectedRootSnapshotDigest`、`walk`（私有）、
  `readProtectedRootSnapshot`、`diffProtectedRoots`、`SerializedProtectedRootSnapshot`、`serializeProtectedRootSnapshot`、
  `reviveProtectedRootSnapshot`、`snapshotProtectedRoots`。
- **`application/workspaceValidator.ts`**：`readBusinessTreeSnapshot`、`businessTreeSnapshotDigest`、`BoundaryViolationCode`、
  `WorkspaceValidationOutcome`、`WorkspaceValidationInput`、`within`、`boundary`（私有）、`validateWorkspaceOutcomeInScope`、
  `businessTreeSnapshot`、`SerializedWorkspaceValidationInput`、`serializeWorkspaceValidationInput`、`reviveWorkspaceValidationInput`、
  `validateWorkspaceOutcome`。
- **`domain/gitMetadataOwnership.ts`**：`PLATFORM_OWNED_GIT_METADATA_PREFIXES`、`RUNTIME_OWNED_GIT_METADATA_PREFIXES`、
  `GIT_METADATA_SKIP_PREFIXES`。

允许的同名：infrastructure 的两个文件只声明三个包装 `snapshotProtectedRoots`、`businessTreeSnapshot`、`validateWorkspaceOutcome`，另外只
转出 D3 的三个名字。`composition/digitalEmployeeWorkspace.ts` 只声明 `DevelopmentEmployeeWorkspaceCompositionInput`、
`DevelopmentEmployeeWorkspaceBootstrapInput`、`composeDevelopmentEmployeeWorkspaceFromPersistence`、`composeDevelopmentEmployeeWorkspace`、
`createDevelopmentEmployeeCaseWorkspaceDetailReader`，只交出其中三个（组合输入类型、两个装配函数）。

## 4. 用例

新增 `packages/backend/tests/rfc496-development-employee-workspace-out-of-composition-boundary.test.ts`（文件名带 `boundary`），登记
guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）里只在清单列的文件声明（早已存在的同名声明与 infrastructure 的三个包装逐个钉住）。
- ② composition 文件的声明与交出恰好是上面五个 / 三个；没有控制流语句（语法树）；装配函数把输入连同选定的工厂与默认时钟交给
  application 的用例，恰好一次。
- ③ infrastructure 的两个快照 / 校验文件只声明三个包装、只另外转出三个名字，没有控制流语句；包装把工厂交给 application 的同名函数。
- ④ 全部生产文件、用例（下限 2,500）与 e2e 不从旧位置取迁出的名字：composition 文件只给三个组合名字，两个 infrastructure 文件只给三个
  包装与三个转出，`attemptSupport.ts` 不再给三组常量；命名 import、type-only、re-export、命名空间成员与动态 import 的解构都认，带负对照。
- ⑤ 三个新的 application 文件只取 zod、shared、`@/util/hash`、`@/util/gitRef`、digital-employee 的 `public/types` 与本模块 domain /
  application，domain 文件没有 import；都不取 infrastructure、composition、IO 包，不用进程全局，带负对照。

行为由现有用例对拍：两个系统模拟 E2E（含冲突一支）、员工工作区交付与仓库新鲜度、Case 运行时、冲突工作区绑定、RFC-370 的工作区效果与
树操作、RFC-310 PR-4 的工作区校验与受保护目录探针、运行时 git 缓存的受保护目录用例。

## 5. 失败模式

- **默认选定走样**：未给工厂的调用方（`taskImageWorkspace`、用例）仍经 infrastructure 的包装选本机实现；给了工厂的照旧校验、远端树
  操作照旧优先（D3 逐支对应原分支）。
- **锁静默变空**：读源码的锁若仍指 composition，会读到一个只剩装配的短文件、断言变成“恒不含”。迁移后按文件名（含路径片段）与代码里的
  字符串字面量全仓再扫，逐个改指；`rfc317-upload-target-path-schema` 的“语料非空”断言会挡住漏改。
- **组合输入类型漂移**：由 application 的输入类型推出，字段与可选性逐个对照；`tsc` 覆盖使用方与用例。

## 6. 取舍（可推翻）

1. **快照与校验整体归 application**，而不是由 composition 注入函数：两文件只经端口工作（design §2 属于 application），用例还要用它们的
   纯函数与类型；注入会把纯函数与类型也变成端口。
2. **infrastructure 留包装与三个转出**：未给工厂时选本机实现属于 infrastructure；`taskImageWorkspace` 逐个避让，不改它的 import。
3. **application 的三个函数与包装同名**：迁入的用例与调用逐字不变；同名由 RFC-496 用例逐个钉住。
4. **常量落 domain**：不依赖任何东西的规则；原位置不留转出。
5. **命名** `employeeWorkspace.ts`，与端口 `ports/employeeWorkspacePersistence.ts` 同词（RFC-495 同例）。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是工作区用例、它依赖的快照与校验逻辑与规则常量，分别落 application 与 domain；composition 只留装配（选定实现、绑定
  持久化、默认值）；不新增用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-496 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明与 import，另读 composition 文件、两个 infrastructure 文件与新文件；
  只对这些范围宣告退出门。
- **C13**：`composition-control-flow-development-automation` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 development-automation 的第三步——工作区用例离开 composition，这个文件只剩装配；快照与校验逻辑离开 infrastructure；
  组合层控制流 371 → 实测。
- **留下**：
  - infrastructure 给 `taskImageWorkspace` 的三个转出：RFC-370 余项释放这个文件后改为直接取 application、删去转出。
  - `attemptSupport.ts`（尝试上下文与校验适配）与 `graph-development/employeeWorkspace.ts` 的归位不在本步。
  - S10 退出门要求点名的文件不再位于 `composition/`：RFC-495 与本 RFC 各留一个只剩装配的同名文件，S10 收口时并入模块装配或改名。
  - development-automation `composition/` 的其余 S10 范围（`missionOperations.ts` / `configOperations.ts` / `graphDeliveryBridge.ts` 的命令
    处理）由后继步骤承接。
