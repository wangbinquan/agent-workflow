# RFC-497 设计：开发自动化的 mission 与配置操作用例迁出 composition

## 1. 现状（HEAD `b549dcc5e`，源码实读）

development-automation 组合层控制流（F13 口径，按语法树计数）实测 274 行：`composition/missionOperations.ts` 61 行、
`composition/configOperations.ts` 18 行。两组操作的合同在 application：`application/missionOperations.ts`（417 行）与
`application/configOperations.ts`（441 行）声明操作接口、输入 schema 与操作描述，`public/operations.ts` 转出；composition 里是实现。

`composition/missionOperations.ts`，722 行：

- 第 1～53 行 import；第 55 行日志器；第 57～73 行游标、视图与两组状态的 zod schema；第 75～98 行 `refreshFailureError` 与游标编解码。
- 第 100～109 行组合选项接口 `DevelopmentMissionOperationCompositionOptions`（可选的基线效果工厂、MR effects、仓库 claim key、准入查找、
  模块参与方 `automation`、旧准入开关）；第 111～116 行 `createLegacyMissionAdmissionsEnabledQuery(writer)`（bootstrap 用，把 writer 状态
  投影成准入开关查询）；第 118～126 行持久化接口 `DevelopmentMissionOperationPersistence`（7 个端口）。
- 第 128～703 行 `composeDevelopmentMissionOperationsFromPersistence(deps, persistence)` 返回 `DevelopmentMissionOperations`。
- 第 705～722 行 `DevelopmentMissionOperationCompositionDeps` 与 `composeDevelopmentMissionOperations(deps)`：绑定 7 个持久化（RFC-359 W4-D12）。

mission 用例碰 composition 之外不该碰的地方：

1. 第 144 行 `createRepositoryBaselineResolverFromLocations(persistence.repositories, deps.repositoryBaselines)`（`infrastructure/gitBaselineReader`，
   选定基线效果的实现）建上传准入的基线解析；`persistence.repositories` 只用在这里。
2. 第 18 行 `import type { DevelopmentAutomationModule } from '../composition'`：RFC-376 G7 不许 application 取 composition，类型也不行。
   用例用到参与方的 10 个成员（`materializer`、`evidenceContents`、`evidenceDownloads`、`collaboration`、`drive`、`confirmNoChange`、
   `submitAnswers`、`handoff`、`attachMr`、`resume`）。接口在 `composition.ts` 第 183～230 行，其余 6 个成员（`evidence`、`reconcile`、
   `sweepWakes`、`sweepUploads`、`sweepRetention`、`recover`）里 `sweepRetention` 的结果类型来自 `infrastructure/retentionSweeper`。
3. 进程全局：第 141、213 行 `now: () => Date.now()`，第 628、633 行 `analyze(Date.now())`。另有第 214 行 `ulid()`、日志器与游标的
   `Buffer`：G6 不禁，本模块 application 早有取 `ulid` 的先例（`commands/launchMission.ts` 等），其他模块 48 个 application 文件取
   `@/util/log`。
4. 合同类型经 `../public/operations` 转取（`DevelopmentMissionListInput`、`DevelopmentMissionOperations`）；本模块 application 没有文件取
   自己的 public。

`composition/configOperations.ts`，684 行：

- 第 1～52 行 import；第 54 行 `Actor`；第 56～58 行 `DevelopmentConfigAccessRow`；第 60～79 行 `DevelopmentConfigResourceAccess`（Resource
  Catalog 在 bootstrap 绑定的 ACL 参与方）；第 81～88 行组合依赖接口 `DevelopmentConfigCompositionDependencies`；第 90～152 行
  `identityView`、`requireVisible`、`requireEditable`、`requireGovernable`、`invalidDraft`。
- 第 154～656 行 `composeDevelopmentConfigOperationsFromPersistence(deps)` 返回 `DevelopmentConfigOperations`。
- 第 658～682 行 `composeDevelopmentConfigOperationsFor(input)`（绑定三个持久化，两个 provider 共用）与位置参数形态的
  `composeDevelopmentConfigOperations(db, developmentAdapter, access)`；第 684 行是一段已无对应声明的注释（它说明的 PostgreSQL 入口名
  已删，全仓零引用）。

配置用例只经端口工作：infrastructure 只在两个装配函数里出现；进程全局只有第 161 行 `deps.now ?? (() => Date.now())`；第 345、427 行
`ulid()`。合同类型同样经 `../public/operations` 转取。

使用方：bootstrap `daemonModules/developmentAutomation.ts` 取 `composeDevelopmentMissionOperations` 与
`createLegacyMissionAdmissionsEnabledQuery`；`daemonModules/resourceCatalog.ts` 取 `composeDevelopmentConfigOperationsFor` 与类型
`DevelopmentConfigResourceAccess`；用例 `rfc310-pr3-journey`、`rfc370-pipeline-evidence-content` 取前者，`rfc359-w7-module-composition-roots`
取 `composeDevelopmentConfigOperationsFor`；`rfc380-daemon-module-bundles` 只列组合名字。`DevelopmentAutomationModule` 的使用方是 mission
操作的组合文件与 6 个用例（都从 `composition.ts` 取类型）；bootstrap 用的是装配出来的对象。

按路径或内容读这两个文件的锁（逐个读过）：

- mission：`rfc344-operation-catalog`（含 `readonly automation: DevelopmentAutomationModule` 与 `const automation = deps.automation`，不含
  `composeDevelopmentAutomation(`、不取 integration / source-control / task-execution）、`rfc349-development-admission-postgresql-adapter`
  （含 `readonly admissionLookup: AdmissionLookup` 与 `lookup: deps.admissionLookup`，不含 `createAdmissionLookup`）、`rfc310-pr9-cutover`
  （含 `new ConflictError('cutover-adopt-rejected'`）、`rfc370-storage-and-worker-root-bindings`（`createRepositoryBaselineResolverFromLocations`
  恰好一次、实参 `persistence.repositories` 与 `deps.repositoryBaselines`）、`rfc359-w4-d12-adapters`（有 `PersistenceDb`、没有按 provider
  命名的孪生）、`rfc471-development-delivery-code-host-bridge`（不取 `developmentDeliveryDeps`）。
- 配置：`architecture/rfc317-acl-write-gate-guard`（`routes/developmentConfig.ts` 的写门由这个文件调用的标识符代理）、
  `rfc305-architecture-lock`（跨 context 使用方清单里 `composition/configOperations.ts -> @/modules/identity-access/public/participants` 一条）、
  `rfc344-operation-catalog`（含 `developmentAdapter: DevelopmentConfigResourceOperations`，不取 integration）。
- 账本：`architecture/commons-debt.json`、RFC-310 的 OS 依赖清单都没有按路径读这两个文件的条目。

## 2. 机制与落位

### D1 用例落 application

与 RFC-495 / RFC-496 相同：两组用例编排本模块的 domain 规则、application 命令与各个端口，属于 application。RFC-294 design §3 的矩阵许
application 取本模块 domain / ports 与其他模块受控 public 的精确入口，禁的是传输层、具体表、直接 effect、platform 实现与 infrastructure /
composition；同层文件与本模块 engine 的 import 早有先例（`missionReconciler.ts` 取 engine 的策略求值与工作选择，
`agentActionOrchestrator.ts` 取 prompt 组装与信封解析），
`rfc294-review-module-layer-rules` 只禁 application 取 infrastructure（值与类型）、composition 与传输层。

### D2 新文件 `application/missionOperationHandlers.ts`

- 第 55～98 行原样迁入（日志器、四个 schema、`refreshFailureError`、游标编解码）。
- 组合选项接口迁入，改名 `DevelopmentMissionOperationsInput`：去掉只用于建基线解析的 `repositoryBaselines`；`automation` 改取 D3 的端口
  类型；新增必填的 `resolveBaseline`（类型 `UploadAdmissionDeps['resolveBaseline']`，composition 建好交来）与 `now`；其余字段与注释逐字。
- `DevelopmentMissionOperationPersistence` 原样迁入并交出，去掉只用于建基线解析的 `repositories`。
- 第 128～703 行的用例迁为 `createDevelopmentMissionOperations(deps, persistence)`，函数体逐字，只改 5 处：`uploadAdmission.resolveBaseline`
  取 `deps.resolveBaseline`；`launchDeps` 与 `cutoverDeps` 的 `now` 取 `deps.now`；`readCutover`、`materializeCutover` 的 `analyze(Date.now())`
  改为 `analyze(deps.now())`。
- 合同类型改取同层的 `./missionOperations`（此前经 `public/operations` 转取，同一声明）。

### D3 端口 `application/ports/developmentMissionAutomation.ts`

- `DevelopmentMissionAutomation` 声明用例用到的 10 个成员，声明与注释从 `DevelopmentAutomationModule` 原样迁来；成员类型都来自本模块
  application（需求物化器、证据内容与下载查询、驱动结果、三条命令的结果与交接三命令）。
- `composition.ts` 的 `DevelopmentAutomationModule` 改为 `extends DevelopmentMissionAutomation`，只留其余 6 个成员：成员集合、类型与
  只读性不变，取它的 6 个用例与 bootstrap 不改；`composition.ts` 里只给迁走成员用的类型 import 随之删去（值 import 不动）。
- 不整体迁移这个接口：其余成员里 `sweepRetention` 的结果类型在 infrastructure，整体迁移会把它一起拖进 application；用例也只该依赖它
  用到的成员。

### D4 新文件 `application/configOperationHandlers.ts`

- 第 54～152 行原样迁入（`Actor`、`DevelopmentConfigAccessRow`、`DevelopmentConfigResourceAccess`、五个辅助函数）。
- 组合依赖接口迁入，改名 `DevelopmentConfigOperationsInput`：`now` 改为必填（默认时钟由 composition 给）；其余字段逐字。
- 第 154～656 行的用例迁为 `createDevelopmentConfigOperations(deps)`，函数体逐字，只改 `const now = deps.now`。
- 合同类型改取同层的 `./configOperations`。

### D5 composition 只留装配

`composition/missionOperations.ts` 留：

- `DevelopmentMissionOperationCompositionOptions`：由 application 的输入类型去掉 `automation`、`resolveBaseline` 与 `now`，再加回可选的
  `repositoryBaselines` 与 `automation: DevelopmentAutomationModule`——字段与可选性和此前逐个相同。
- `createLegacyMissionAdmissionsEnabledQuery` 与 `DevelopmentMissionOperationCompositionDeps` 逐字。
- `composeDevelopmentMissionOperations(deps)`：按原次序绑定 7 个持久化；以 `persistence.repositories` 与 `deps.repositoryBaselines` 调用
  `createRepositoryBaselineResolverFromLocations` 建基线解析（原第 144 行的调用移到这里，同样在装配时建一次）；默认时钟 `Date.now`；
  交给 `createDevelopmentMissionOperations`。

`composition/configOperations.ts` 留：

- 转出类型 `DevelopmentConfigResourceAccess`（bootstrap 取用，import 不改）。
- `DevelopmentConfigCompositionDependencies`：由 application 的输入类型去掉 `now`，再加回可选的 `now`。
- `composeDevelopmentConfigOperationsFromPersistence(deps)`：默认时钟 `deps.now ?? Date.now`，交给 `createDevelopmentConfigOperations`。
- `composeDevelopmentConfigOperationsFor` 与 `composeDevelopmentConfigOperations` 逐字；末尾那段已无对应声明的注释删去。

两个文件不再有 `if` / `for` / `while` / `switch` / `try` / `throw`；bootstrap 与用例不改。

### D6 锁、账本与清单

- 读用例源码的锁改指新文件、断言不变：`rfc310-pr9-cutover`、`rfc349-development-admission-postgresql-adapter` 与 `rfc471-development-delivery-code-host-bridge`
  的 mission 一条改读 `application/missionOperationHandlers.ts`；`rfc317-acl-write-gate-guard` 的配置操作源改读
  `application/configOperationHandlers.ts`；`rfc344-operation-catalog` 里 `const automation = deps.automation` 与“不取其他 context”两条改读
  mission 的新文件，`readonly automation: DevelopmentAutomationModule`、`developmentAdapter: DevelopmentConfigResourceOperations` 仍在
  composition、不改。
- `rfc305-architecture-lock`：跨 context 使用方清单里 `composition/configOperations.ts` 一条改为 `application/configOperationHandlers.ts`。
- 不改：`rfc370-storage-and-worker-root-bindings`（基线解析的调用与实参原样留在 composition）、`rfc359-w4-d12-adapters`（装配仍有
  `PersistenceDb`）、`rfc380-daemon-module-bundles` 与 `rfc359-w7-module-composition-roots`（只取组合名字）。
- `architecture/counts.json`：`composition-control-flow-development-automation` 274 → 实测（预计 195）。
- `guard-manifest.json` 登记 RFC-497 用例。

## 3. 清单（退出门）

- **`application/missionOperationHandlers.ts`**：交出 `DevelopmentMissionOperationsInput`、`DevelopmentMissionOperationPersistence`、
  `createDevelopmentMissionOperations`；模块内私有：`log`、`MissionCursorSchema`、`MissionViewSchema`、`RawMissionStatusesSchema`、
  `MissionStatusesSchema`、`refreshFailureError`、`encodeMissionCursor`、`decodeMissionCursor`。
- **`application/ports/developmentMissionAutomation.ts`**：`DevelopmentMissionAutomation`。
- **`application/configOperationHandlers.ts`**：交出 `DevelopmentConfigAccessRow`、`DevelopmentConfigResourceAccess`、
  `DevelopmentConfigOperationsInput`、`createDevelopmentConfigOperations`；模块内私有：`Actor`、`identityView`、`requireVisible`、
  `requireEditable`、`requireGovernable`、`invalidDraft`。

早已存在的同名声明（如各处的 `log`、`Actor`）由 RFC-497 用例逐个钉住。

允许的声明：`composition/missionOperations.ts` 只声明并交出 `DevelopmentMissionOperationCompositionOptions`、
`createLegacyMissionAdmissionsEnabledQuery`、`DevelopmentMissionOperationCompositionDeps`、`composeDevelopmentMissionOperations`；
`composition/configOperations.ts` 只声明并交出 `DevelopmentConfigCompositionDependencies`、`composeDevelopmentConfigOperationsFromPersistence`、
`composeDevelopmentConfigOperationsFor`、`composeDevelopmentConfigOperations`，另外只转出 `DevelopmentConfigResourceAccess`；
`composition.ts` 的 `DevelopmentAutomationModule` 继承端口、只声明 D3 的 6 个成员。

## 4. 用例

新增 `packages/backend/tests/rfc497-development-mission-and-config-operations-out-of-composition-boundary.test.ts`（文件名带 `boundary`），
登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）里只在清单列的文件声明（早已存在的同名声明逐个钉住）。
- ② 两个 composition 文件的声明、交出与转出恰好是 §3 所列；没有控制流语句（语法树）；装配函数恰好一次调用 application 的用例：mission
  一侧交出按 `persistence.repositories` 与 `deps.repositoryBaselines` 建的基线解析与默认时钟，配置一侧交出 `deps.now ?? Date.now`。
- ③ `DevelopmentAutomationModule` 继承 `DevelopmentMissionAutomation`、只声明其余 6 个成员；端口恰好声明 10 个成员。
- ④ 全部生产文件、用例（下限 2,500）与 e2e 不从旧位置取迁出的名字：两个 composition 文件只给 §3 列的名字；命名 import、type-only、
  re-export、命名空间成员与动态 import 的解构都认，带负对照。
- ⑤ 三个新文件的依赖面是闭集：mission 用例只取 zod、`ulid`、shared、`@/util/errors`、`@/util/log` 与本模块 domain / application；配置用例
  只取 `ulid`、shared、`@/util/errors`、identity-access 的 `public/participants` 与本模块 domain / application / engine；端口只取本模块
  application。都不取 infrastructure、composition、IO 包，不用进程全局，带负对照。

行为由现有用例对拍：mission 一侧的旅程与切换（`rfc310-pr3-journey`、`rfc310-pr9-cutover`）、流水线证据内容、非法请求体、mission 页与
操作目录；配置一侧的配置路由错误、配置资源写门与 ACL 矩阵、员工定义与创建合同、剧本与引导旅程。

## 5. 失败模式

- **时机走样**：基线解析与时钟仍在装配时各建一次；7 个持久化的绑定次序不变。
- **锁静默变空**：读源码的锁若仍指 composition，会读到只剩装配的短文件、断言变成“恒不含”。迁移后按文件名（含路径片段）与代码里的
  字符串字面量全仓再扫，逐个改指（含只登记路径、眼下不参与判定的一项）。
- **参与方接口走样**：`DevelopmentAutomationModule` 的成员集合与类型不变，由 RFC-497 用例 ③ 与 `tsc`（bootstrap、6 个用例）覆盖。
- **组合输入类型漂移**：由 application 的输入类型推出，字段与可选性逐个对照；`tsc` 覆盖使用方与用例。

## 6. 取舍（可推翻）

1. **两个文件同批**：同一种形状（合同早在 application、composition 里是实现），同一次集中验证覆盖两份。
2. **参与方只取用到的成员作端口**，`DevelopmentAutomationModule` 继承它：用例不依赖它不用的成员；整体迁移会把 infrastructure 的
   结果类型拖进 application。
3. **基线解析由 composition 建好交来**：`createRepositoryBaselineResolverFromLocations` 选定基线效果的实现，属于 infrastructure。
4. **`ulid`、日志器与 `Buffer` 留在用例里**：G6 不禁，application 已有先例；时钟按 RFC-495 / RFC-496 的做法由 composition 给。
5. **命名** `missionOperationHandlers.ts` / `configOperationHandlers.ts`：同目录已有同名的合同文件，实现取 handlers 区分；交出的
   `createDevelopmentMissionOperations` / `createDevelopmentConfigOperations` 与合同接口同词。
6. **ACL 参与方类型随用例迁入 application**，composition 转出给 bootstrap：bootstrap 的 import 不改。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是两组操作用例与它们的辅助规则，落 application；用例要用的参与方成员成为 application 端口；composition 只留装配
  （选定实现、绑定持久化、默认值与准入开关的查询投影）；不新增用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-497 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明与 import，另读两个 composition 文件、`composition.ts` 与新文件；
  只对这些范围宣告退出门。
- **C13**：`composition-control-flow-development-automation` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 development-automation 的第四步——mission 与配置两组操作用例离开 composition，这两个文件只剩装配；组合层控制流
  274 → 实测。
- **留下**：
  - `graphDeliveryBridge.ts` 的命令处理（S10 下一步）；`activityOperations.ts`（5 行）的实现。
  - S10 退出门要求点名的文件不再位于 `composition/`：RFC-495、RFC-496 与本 RFC 各留只剩装配的同名文件，S10 收口时并入模块装配或改名。
  - `DevelopmentAutomationModule` 其余成员与它的装配仍在 `composition.ts`，随 S10 收口与 S12 处理。
