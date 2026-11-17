# RFC-502 设计：集成的开发适配器配置、代码托管交付、审批网关与工具连接目录迁出 composition

## 1. 现状（HEAD `183febdb9`，源码实读）

integration 组合层控制流（F13 口径，按语法树计数）实测 57 行：本 RFC 的四个文件 40 行，`taskImageDevelopmentAdapter.ts` 13 行与
`crewstationDevelopmentAdapters.ts` 3 行（RFC-370 余项），`webhookIngress.ts` 1 行。四个文件都不在 `composition-forbidden-import-files`
的 12 个文件里。

**`composition/developmentAdapterConfigOperations.ts`，212 行（12 行控制流）**：

- 第 5～17 行 import：shared 的类型 `ResourceAccess`、`ResourceGrantLevel`；`@/auth/actor` 的类型；`@/platform/persistence/persistenceDb`
  的类型；`@/util/errors` 的三个错误；本模块 application 的 `developmentAdapterCommands`（四个命令与类型
  `DevelopmentAdapterIdentityRow`）与 `adapters/resource-catalog-acl-adapter`；infrastructure 的 `createDevelopmentAdapterStore`。
- 第 19～91 行：私有的 `AdapterCreateInput`、`AdapterReviseInput`、`identityView`、`DevelopmentAdapterAccessRow`；导出的
  `DevelopmentAdapterAccess`（resource-catalog 交来的授权面）与 `DevelopmentAdapterGrantReads`（目录的 grant 读端口）。
- 第 93～98 行 `DevelopmentAdapterConfigCompositionInput`（`db`、`access`、`grants`、可选 `now`）。
- 第 104～208 行 `composeDevelopmentAdapterConfigOperationsFor(input)`：第 107～108 行按 `db` 建 store、`now` 缺省取进程时钟；其余是
  操作对象——`kind`、`resourceAclIdentity`、`list`、`get`（技术权限 + 编辑授权给全量，显式授权 + 可见给身份视图，否则 403）、`create`、
  `revise`、`publish`、`archive`、`loadAclRow`。
- 第 210～212 行类型 `DevelopmentAdapterConfigOperations`（没有使用方）。

**`composition/codeHostEffects.ts`，221 行（11 行控制流）**：第 1～12 行文件头；第 14～27 行 import 只取本模块 application 的
`mrEnsure`、`mrFacts` 与 domain 的 `repositoryProviderMatch`。第 29～31 行 `RepoCodeHostBindingResolver`；第 33～111 行
`DevelopmentMrEffects` 与 `composeDevelopmentMrEffects`（绑定缺失回 `code-host-connection-missing`，否则调 MR 确保 / 回复 / 观察）；
第 113～154 行 `DevelopmentCodeHostConnections` 与 `composeDevelopmentCodeHostBinding`（按仓库远端在 gitlab / github 连接里匹配）；第
156～185 行 `composeDevelopmentMrFactsSource`；第 187～201 行 `composeDevelopmentCodeHostDelivery`（把三者接在同一个绑定上，唯一的
装配）；第 203～221 行 `composeRepositoryCodeHostClaimKeys`。

**`composition/approvalGateway.ts`，190 行（10 行控制流）**：

- 第 7～84 行私有的 `gateway(input)`：第 11～17 行按进程环境取密钥与 mock 地址、建旧的执行适配器（infrastructure 的
  `createApprovalExecutionAdapter`）；第 18～83 行是回执投影——`binding`（`id@revision`）、`canonical`（键排序的规范 JSON）与
  `submit` / `lookupByIdempotencyKey` / `observe` 三条回执。
- 第 87～98 行 `composeApprovalGatewayRunnerFor(db, options)`：建 store 与绑定解析，交给 `gateway`。
- 第 100 行注释“旧名保留为装配别名，bootstrap 收敛后删除”，第 102～106 行在文件中部 import application 的
  `createSelectedApprovalExecutionAdapter`、类型 `SelectedApprovalExecution` 与端口类型 `ApprovalAdapterBinding`。
- 第 108～175 行私有的 `selectedGateway(execution)`：第 109～174 行与第 18～83 行**逐字相同**（66 行，脚本比对）。
- 第 177～190 行 `composeSelectedApprovalGatewayRunnerFor(db, binding)`：建 store 与绑定解析、选定绑定的执行适配器，交给
  `selectedGateway`。
- 旧的 `ApprovalExecution`（`infrastructure/local/legacyApprovalAdapter.ts`）与 `SelectedApprovalExecution` 结构相同：三个方法的入参逐字，
  返回类型都取 application `developmentAdapterRunner` 的同名函数（infrastructure 的那三个函数声明返回 `ReturnType<typeof selected.…>`）。

**`composition/digitalEmployeeToolConnections.ts`，107 行（7 行控制流）**：第 1～7 行 import：`PersistenceDb` 类型、resource-catalog
`public/queries` 的 `isVisibleToAudienceSnapshot`、domain 的 `developmentAdapterContentSchema`、infrastructure 的
`createDevelopmentToolConnectionStore` 与类型 `DevelopmentToolConnectionStore`。第 14～102 行私有的 `catalog(store)`：`resolve`（按精确
修订取身份与内容，算可用与可见、拼摘要）与 `selectAutomatic`（按用途收集已发布与候选的修订、排序后取第一个可用且可见的）。第 105～107
行 `composeDevelopmentToolConnectionCatalog(db)`。store 接口 `DevelopmentToolConnectionStore` 声明在
`infrastructure/developmentToolConnectionStore.ts` 第 8～16 行，第 84 行转出类型；它只被这个组合文件取。

使用方：

- bootstrap：`daemonModules/resourceCatalog.ts` 第 17、160 行取并调用 `composeDevelopmentAdapterConfigOperationsFor`（不传 `now`）；
  `daemonModules/repositoryCredentials.ts` 第 10、72 行取 `composeDevelopmentCodeHostDelivery`；`daemonModules/integration.ts` 第 20、83、152 行
  取 `composeSelectedApprovalGatewayRunnerFor`，第 22、223 行取 `composeDevelopmentToolConnectionCatalog`。
- 用例取被迁的名字：`rfc310-digital-employee-conflict-system-mock-e2e`（第 45、179 行）、`rfc310-digital-employee-system-mock-e2e`（第 70、
  801 行）、`rfc310-pr5-e2e-java`（第 47、207 行）、`rfc310-t109-full-journey-e2e`（第 64、250 行）取 `composeDevelopmentMrEffects`；
  `rfc359-w4-d13-adapters`（第 22、330 行）取 `composeDevelopmentCodeHostBinding`；`rfc471-development-delivery-code-host-bridge`（第 32～36
  行）取四个 `compose…` 与 `composeDevelopmentCodeHostDelivery`。
- 用例只取留下的装配入口（不改）：`rfc359-w4-d6a-adapters`、`rfc359-w7-module-composition-roots`（配置操作）；
  `rfc310-digital-employee-system-mock-e2e` 第 69、454 行与 `rfc359-w7-integration-composition-roots` 第 37、643、733 行（旧的审批装配）；
  `rfc370-purpose-published-bindings`（选定绑定的审批装配）；`rfc349-development-integration-composition` 第 6 行与
  `rfc359-w7-integration-composition-roots` 第 38、734 行（工具连接目录）。
- 按路径或名字读这些文件的锁：`rfc344-operation-catalog` 第 845～850 行读配置操作的组合文件，要求含 `composeDevelopmentAdapterConfigOperations`、
  不取 development-automation；`rfc497-…-boundary` 第 73 行的 `HOMONYMS` 把 `identityView` 钉在配置操作的组合文件；`rfc321-repository-publication-ratchet`
  第 400～427 行读 `codeHostEffects.ts`，要求不含两个密钥相关的名字；`rfc471` 第 213 行要求 `codeHostEffects.ts` 不取 development-automation，第
  278～290 行要求 MR 的三个写 / 读函数只在 `codeHostEffects.ts` 被调；`rfc466-resource-acl-and-workgroups-facade-retirement` 第 96 行要求工具连接的
  组合文件取 resource-catalog `public/queries` 的 `isVisibleToAudienceSnapshot`；`rfc349` 第 113～133 行要求 `approvalGateway.ts` 与
  `digitalEmployeeToolConnections.ts` 等没有带 provider 名的导出；`architecture/rfc380-daemon-module-bundles` 第 111、129、172、173 行把四个
  装配入口列为成员工厂。
- development-automation 的两处注释写着旧名字：`infrastructure/developmentDeliveryProvider.ts` 第 4～5 行（`composeDevelopmentCodeHostBinding`）、
  `application/ports/developmentDelivery.ts` 第 3～4 行（`composition/codeHostEffects.ts` 的 `composeDevelopmentMrFactsSource`、
  `composeRepositoryCodeHostClaimKeys`）；`composition/developmentDelivery.ts` 第 3 行说实现是 `composition/codeHostEffects.ts` 的组装，迁移
  后仍然成立。

清单里的名字在全部生产文件、用例与 e2e 里没有别的顶层同名声明，`identityView` 除外：development-automation 的
`application/configOperationHandlers.ts` 有一份同名的私有函数（RFC-497 已钉）。

## 2. 机制与落位

### D1 用例落 application

四组都是经传入端口工作的用例：配置操作编排本模块 application 的命令与授权面，代码托管桥编排 application 的 MR 函数与 domain 的匹配，
回执投影只包一层执行端口，工具连接目录读 store 端口、用 domain 的 schema 与 resource-catalog 的 public 可见性判断。同目录的
`developmentAdapterCommands.ts`、`mrEnsure.ts`、`developmentApprovalAdapter.ts` 就是它们取的东西，属于 application。
`rfc294-review-module-layer-rules` 只禁 application 取 infrastructure（值与类型）、composition 与传输层；所以工具连接目录用的 store
接口要随之进 application。

### D2 新文件

- **`application/developmentAdapterConfigOperations.ts`**：第 19～91 行与操作对象原样迁入。工厂 `createDevelopmentAdapterConfigOperations(deps)`
  取 `DevelopmentAdapterConfigOperationsDeps`（`store: DevelopmentAdapterStore`、`access`、`grants`、必填的 `now`），函数体开头的
  `const store = deps.store`、`const now = deps.now` 接替原第 107～108 行，其后逐字；类型 `DevelopmentAdapterConfigOperations` 随迁。
- **`application/developmentCodeHostDelivery.ts`**：第 29～185 行与第 203～221 行原样迁入，四个工厂改名为 `createDevelopmentMrEffects`、
  `createDevelopmentCodeHostBinding`、`createDevelopmentMrFactsSource`、`createRepositoryCodeHostClaimKeys`；文件头随迁，import 按新目录改写。
- **`application/developmentApprovalGateway.ts`**：回执投影（第 109～174 行）一份，工厂 `createDevelopmentApprovalGateway(execution)`，
  参数类型 `SelectedApprovalExecution`；函数体逐字，取 `@/util/hash` 的 `sha256Hex`。
- **`application/developmentToolConnectionCatalog.ts`**：`catalog` 原样迁入为 `createDevelopmentToolConnectionCatalog(store)`，doc 注释随迁。
- **`application/ports/developmentToolConnectionStore.ts`**：`DevelopmentToolConnectionStore` 接口原样迁入；
  `infrastructure/developmentToolConnectionStore.ts` 删去接口声明与类型转出、改取它（随之不用的 `DevelopmentAdapterIdentityRow` import 删去）。

### D3 composition 只装配

- `developmentAdapterConfigOperations.ts`：留文件头、`DevelopmentAdapterConfigCompositionInput` 与
  `composeDevelopmentAdapterConfigOperationsFor(input)`——按 `input.db` 建 store、`now` 缺省取进程时钟（与此前相同的中性默认），调
  application 的工厂。
- `codeHostEffects.ts`：只留 `composeDevelopmentCodeHostDelivery`，参数类型改为 `Parameters<typeof createDevelopmentCodeHostBinding>[0]`，
  函数体只换四个工厂名。
- `approvalGateway.ts`：import 移到文件头；两条装配各自建好执行适配器后交给 `createDevelopmentApprovalGateway`。旧的那条把原 `gateway`
  第 11～17 行（进程环境的密钥快照、mock 地址、旧的执行适配器）原样内联，对象字面量的键序不变；第 100 行的注释改为如实记述它的现状。
- `digitalEmployeeToolConnections.ts`：只留 `composeDevelopmentToolConnectionCatalog(db)`。
- bootstrap 不改：五个装配入口的名字、参数与返回形状不变。

### D4 锁、账本与注释

- 用例改取新位置：四个 `rfc310` E2E 改从 application 取 `createDevelopmentMrEffects`；`rfc359-w4-d13-adapters` 改取
  `createDevelopmentCodeHostBinding`；`rfc471` 改从 application 取四个 `create…`（`composeDevelopmentCodeHostDelivery` 照旧取 composition），第
  213 行的“不取 development-automation”对组合文件与新文件都查，第 278～290 行的“MR 函数只在一处被调”改为新文件。
- `rfc344` 的“不取 development-automation”对组合文件与新文件都查（组合文件仍含 `composeDevelopmentAdapterConfigOperations`）；`rfc321` 读组合
  文件与新文件；`rfc466` 改读工具连接目录的新文件；`rfc497` 的 `HOMONYMS` 把 `identityView` 改钉到新文件。`rfc349`、`rfc380` 不改（组合文件与
  装配入口都在）。
- development-automation 的两处注释改写为新名字与新位置。
- `architecture/counts.json`：`composition-control-flow-integration` 57 → 实测（预计 17）。`guard-manifest.json` 登记 RFC-502 用例。

## 3. 清单（退出门）

| 新文件（`modules/integration/application/`） | 声明并交出                                                                                                                                                                                                                       | 只声明不交出                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `developmentAdapterConfigOperations.ts`      | `DevelopmentAdapterAccess`、`DevelopmentAdapterGrantReads`、`DevelopmentAdapterConfigOperationsDeps`、`createDevelopmentAdapterConfigOperations`、`DevelopmentAdapterConfigOperations`                                           | `AdapterCreateInput`、`AdapterReviseInput`、`identityView`、`DevelopmentAdapterAccessRow` |
| `developmentCodeHostDelivery.ts`             | `RepoCodeHostBindingResolver`、`DevelopmentMrEffects`、`createDevelopmentMrEffects`、`DevelopmentCodeHostConnections`、`createDevelopmentCodeHostBinding`、`createDevelopmentMrFactsSource`、`createRepositoryCodeHostClaimKeys` | —                                                                                         |
| `developmentApprovalGateway.ts`              | `createDevelopmentApprovalGateway`                                                                                                                                                                                               | —                                                                                         |
| `developmentToolConnectionCatalog.ts`        | `createDevelopmentToolConnectionCatalog`                                                                                                                                                                                         | —                                                                                         |
| `ports/developmentToolConnectionStore.ts`    | `DevelopmentToolConnectionStore`                                                                                                                                                                                                 | —                                                                                         |

允许的形状：四个组合文件只声明并交出 `DevelopmentAdapterConfigCompositionInput`、`composeDevelopmentAdapterConfigOperationsFor`、
`composeDevelopmentCodeHostDelivery`、`composeApprovalGatewayRunnerFor`、`composeSelectedApprovalGatewayRunnerFor`、
`composeDevelopmentToolConnectionCatalog`，没有 if / for / while / do / switch / try / throw 语句；改名前的 `composeDevelopmentMrEffects`、
`composeDevelopmentCodeHostBinding`、`composeDevelopmentMrFactsSource`、`composeRepositoryCodeHostClaimKeys` 没有声明；`approvalGateway.ts`
恰好调用 `createDevelopmentApprovalGateway` 两次；infrastructure 的工具连接 store 不声明 `DevelopmentToolConnectionStore`、从端口文件取它；
bootstrap 取四个组合文件的装配入口照旧。

## 4. 用例

新增 `packages/backend/tests/rfc502-integration-development-use-cases-out-of-composition-boundary.test.ts`（文件名带 `boundary`），登记
guard-manifest：

- ① 清单里交出的名字与端口接口在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的新文件声明（`identityView` 另有
  development-automation 的那一份，逐个钉住）；改名前的四个名字没有声明；每个新文件恰好声明、交出清单列的名字。
- ② 四个组合文件只声明、交出允许的装配入口，没有控制流语句，没有 `gateway` / `selectedGateway` / `catalog`；各自从新文件取工厂；
  `approvalGateway.ts` 恰好调用投影两次；工具连接 store 从端口文件取接口、自己不声明不转出；bootstrap 从四个组合文件取装配入口照旧；
  带负对照。
- ③ 全部生产文件、用例与 e2e 从四个组合文件只取允许的装配入口：命名 import、type-only、默认与副作用 import、re-export、命名空间成员与
  动态 import 都认，带负对照。
- ④ 新文件的依赖面是闭集：只取 shared、`@/util/errors`、`@/util/hash`、`@/auth/actor` 的类型、resource-catalog 的 `public/queries` 与
  本模块 domain / application；不取 infrastructure、composition、IO 包，不用进程全局；带负对照。

行为由现有用例对拍：`rfc359-w4-d6a-adapters`、`rfc359-w7-module-composition-roots` 与经 bootstrap 跑配置面的用例（配置操作）；
`rfc471`、`rfc359-w4-d13-adapters` 与四个 `rfc310` E2E（代码托管桥）；`rfc370-purpose-published-bindings`、
`rfc359-w7-integration-composition-roots` 与 `rfc310-digital-employee-system-mock-e2e`（两条审批装配）；`rfc349`、`rfc359-w7-integration-composition-roots`
与数字员工的工具连接用例（工具连接目录）。

## 5. 失败模式

- **用例走样**：函数体逐字迁移；配置操作只把建 store、取时钟两行留在装配；审批的两份投影本就逐字相同，合为一份后两条装配的执行
  适配器照旧。
- **装配入口变形**：五个入口名字与参数不变，返回值是 application 工厂的结果、形状不变；`tsc` 覆盖 bootstrap 与用例的取用。
- **遗留引用**：由 `tsc` 与 RFC-502 用例 ③ 覆盖；迁移后按名字、路径片段与代码里的字符串字面量全仓再扫。
- **锁静默变空**：`rfc344`、`rfc321`、`rfc471`、`rfc466`、`rfc497` 改读新文件或两处都读，断言照旧；全仓再扫同样覆盖。

## 6. 取舍（可推翻）

1. **四个文件一个 RFC**：四处是同一种形状（用例写在 composition、装配一两行），同一个模块、互不相交，迁法相同；合在一步做省三轮集中
   验证，清单与用例按文件逐项列，不因合并降低覆盖。
2. **留组合文件与装配入口，不改 bootstrap**：装配（按 `PersistenceDb` 建 store、时钟缺省、进程环境、把三者接在一个绑定上）正是
   composition 的事；入口不变则 bootstrap 与只取入口的用例都不动。
3. **工厂改名为 `create…`、私有函数改为导出工厂**：与同层的 `createWebhookLaunchAdmission`、`createDevelopment…EventObserver` 一致，
   `compose…` 留给 composition 的装配。
4. **时钟在 application 必填**：缺省时钟是装配的选择（RFC-500 同样处理）；application 不读进程时钟。
5. **审批投影合一份**：两份逐字相同、入参结构相同，留两份就要么在 application 也放两份、要么一份留在 composition；合为一份后两条装配只
   差执行适配器。旧的那条装配本身不删（§8）。
6. **store 接口进 `application/ports/`**：目录在 application 取它，接口归 application、实现归 infrastructure；infrastructure 的类型转出没有
   别的使用方，删去而不是留转手。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是四组用例，落 application；composition 只留装配、没有控制流；不新增用例入口（bootstrap 照旧各取一份），审批投影由两份
  变一份。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子（新端口是读端口接口，留在模块内）。
- **C12**：RFC-502 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明与 import，另读四个组合文件、工具连接 store、bootstrap 的三个
  文件与新文件；只对这些范围宣告退出门。
- **C13**：`composition-control-flow-integration` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 integration 的第三步——开发适配器配置、代码托管交付、审批回执投影与工具连接目录离开 `composition/`，审批的重复
  投影消失，工具连接 store 的接口归 application；组合层控制流 57 → 实测。
- **留下**：`webhookIngress.ts` 的一行可用性判断；`taskImageDevelopmentAdapter.ts` 13 行与 `crewstationDevelopmentAdapters.ts` 3 行待
  RFC-370 余项；旧的审批装配 `composeApprovalGatewayRunnerFor` 与只有它在用的 `infrastructure/local/legacyApprovalAdapter.ts`（bootstrap
  已不用，`rfc310-digital-employee-system-mock-e2e` 经它接审批 mock、`rfc359-w7-integration-composition-roots` 经它测绑定解析；删除要先把
  那条 E2E 改到选定绑定的装配，单独立步）；组合文件里读 `process.env` 与时钟缺省的位置随 S12 处理。
