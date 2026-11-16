# RFC-498 设计：开发自动化的图交付桥用例迁出 composition

## 1. 现状（HEAD `b84ac06c2`，源码实读）

development-automation 组合层控制流（F13 口径，按语法树计数）实测 195 行，`composition/graphDeliveryBridge.ts` 占 62 行。

`composition/graphDeliveryBridge.ts`，704 行：

- 第 1～27 行 import：shared、source-control 的 `public/types`（三个参与方类型）、`@/util/gitRef`、本模块 application 的 5 个端口与 5 个
  图开发文件、domain 的 `graphDigest`、`application/employeeTypePackage` 的 `issueHandlingContextSchema`，以及第 26 行 infrastructure 的
  `withAutomationWorkspaceEffects`。
- 第 29～153 行：私有类型 `Candidate`、交出的 `GraphMrHandoffResult`、私有的 `GraphMrDeliveryInput`、`PublishedGraphCandidate`、
  `GraphPublishedInput` 与辅助函数 `deliveryIssue`、`publicationIdentity`。
- 第 155～702 行 `createGraphDeliveryBridge(deps)`：输入（第 156～171 行）是 appHome、工作区效果工厂、source-control 的 Case 工作区与候选
  暂存参与方、两组持久化端口、图设计的存储 / 命令 / 执行端口、验证用例与可选的 `now`；第 172 行 `const now = deps.now ?? Date.now`；第
  173～186 行由工厂解析 Case 的场景与工作区路径、组装 `createGraphMrCare`；第 187～242 行 `publishedCandidate` 与 `verificationWorkspace`；
  第 243～701 行返回照看的方法加 `verificationWorkspace`、`resumeHandoff`、`reusePublished`、`prepareHandoff`。
- 第 704 行 `export type GraphDeliveryBridge`：全仓零引用。

用例碰 composition 之外不该碰的地方只有两处：

1. 第 637 行 `withAutomationWorkspaceEffects(deps.factory, …)`（`prepareHandoff` 把图的临时上传搬进需求目录）。infrastructure 的这个函数先
   `selectedAutomationWorkspaceEffects(chosen)`——缺省时建本机实现、残缺时抛 `automation-workspace-effects-factory-incomplete`、否则原样
   返回——再交给 application 的 `withSelectedAutomationWorkspaceEffects`（`infrastructure/automationWorkspaceEffects.ts:10～34`）。交来的
   工厂在生产里已经选定过：bootstrap `daemonModules/digitalEmployee.ts:259` 把 `input.workspaceEffects.automationWorkspaceEffects` 交给
   `composeGraphDevelopment`，它由 `selectDevelopmentWorkspaceEffectBinding` 以 `selectedAutomationWorkspaceEffects` 选定
   （`infrastructure/actionWorkspaceEffects.ts:39～43`），`graphDevelopment.ts:202` 原样交给本用例；输入类型要求工厂必填；每条走到第 637 行
   的路径都先经 `deps.factory.resolve` 解析过工作区路径（第 580、605 行的 `workspacePath`）。
2. 第 172 行的默认时钟。用例里没有别的进程全局。

使用方：`composition/graphDevelopment.ts` 第 49 行取 `createGraphDeliveryBridge`，第 200～211 行调用一次（10 个字段，不传 `now`）；用例
`rfc396-mr-bridge` 第 25～28 行取 `createGraphDeliveryBridge` 与类型 `GraphMrHandoffResult`，第 429、1410 行各直接建一次（交本机的文件工厂
`createFileAutomationWorkspaceEffectsFactory()`，不传 `now`）。

按路径或内容读这个文件的锁：没有（全部包、`e2e`、`scripts`、`architecture` 与 `.github` 扫过，代码里只有上述两处 import）。账本
`architecture/commons-debt.json`、RFC-310 的 OS 依赖清单都没有它的条目；`composition-forbidden-import-files` 的 14 个文件不含它。`design/`
里提到它的是 RFC-294、RFC-396 与 RFC-494～497 的记述（当时的锚点）；RFC-396 的企业 MR 验收记录（JSON）只作文字引用，没有用例读它。

## 2. 机制与落位

### D1 用例落 application

与 RFC-495～497 相同：交付用例编排本模块 application 的 MR 照看、验证与图设计命令，经各个端口工作，属于 application。
`graphDevelopment.ts` 装配的其余图开发用例都在 `application/graph-development/`；同目录的 `mrCare.ts` 已取 source-control 的 `public/types`
与 `@/util/gitRef`。`rfc294-review-module-layer-rules` 只禁 application 取 infrastructure（值与类型）、composition 与传输层。

### D2 新文件 `application/graph-development/deliveryBridge.ts`

- 第 29～153 行原样迁入（类型与两个辅助函数）；`GraphMrHandoffResult` 照旧交出。
- 第 155～702 行的用例原样迁入，名字不变，函数体逐字，只改 3 处：输入的 `now` 改为必填；第 172 行改为 `const now = deps.now`；第 637 行
  改用同层的 `withSelectedAutomationWorkspaceEffects(deps.factory, …)`（回调的形参与返回不变）。
- import 按新目录改写路径（`../application/ports/…` → `../ports/…`，`../application/graph-development/…` → `./…`，domain 与
  `employeeTypePackage` 同理），不再取 infrastructure。
- 第 704 行的 `GraphDeliveryBridge` 不随迁（全仓零引用）。

去掉的再次选定只是对交来的工厂再验一次：生产里交来的是 bootstrap 选定过的同一个对象，选定对它原样返回；`rfc396-mr-bridge` 交的是完整的
本机文件工厂。缺省或没有 `resolve` 的工厂在两版里都先在第 580 行失败；只有手造的、有 `resolve` 却缺 `parent` 或 `acquire` 的工厂，失败的
形状会从具名错误变成 TypeError（缺 `parent` 且没有临时上传时不再失败）——没有调用方能交出这样的工厂（经 `composeGraphDevelopment` 装配、
交空 `workspace` 的两个 RFC-396 用例交来的是 undefined，属于前一种）。

### D3 composition 不再有这个文件

- 删除 `composition/graphDeliveryBridge.ts`。
- `graphDevelopment.ts` 第 49 行的 import 改取 `../application/graph-development/deliveryBridge`，与同文件取其余图开发用例的 import 并列；
  第 200～211 行的调用加一个字段 `now: Date.now`（此前用例取缺省的 `Date.now`，结果相同），其余 10 个字段逐字；不增控制流。

### D4 锁、账本与清单

- `rfc396-mr-bridge`：import 改取新文件；两处直接建用例各加 `now: Date.now`（此前取缺省值，行为相同）。
- `architecture/counts.json`：`composition-control-flow-development-automation` 195 → 实测（预计 133）。
- `guard-manifest.json` 登记 RFC-498 用例。
- 不改：没有其他锁或账本读这个文件；`design/` 里的历史记述不改。

## 3. 清单（退出门）

- **`application/graph-development/deliveryBridge.ts`**：交出 `GraphMrHandoffResult`、`createGraphDeliveryBridge`；模块内私有：`Candidate`、
  `GraphMrDeliveryInput`、`PublishedGraphCandidate`、`GraphPublishedInput`、`deliveryIssue`、`publicationIdentity`。

这些名字在全部生产文件里没有别的顶层同名声明。

允许的形状：`composition/graphDeliveryBridge.ts` 不存在；`graphDevelopment.ts` 从新文件取 `createGraphDeliveryBridge`、恰好调用一次，
字段是原来的 10 个加 `now: Date.now`。

## 4. 用例

新增 `packages/backend/tests/rfc498-development-graph-delivery-bridge-out-of-composition-boundary.test.ts`（文件名带 `boundary`），登记
guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）里只在新文件声明。
- ② `composition/graphDeliveryBridge.ts` 不存在；`graphDevelopment.ts` 从新文件取 `createGraphDeliveryBridge`、恰好调用一次，字段恰好是
  原来的 10 个加 `now: Date.now`，带负对照。
- ③ 全部生产文件、用例（下限 2,500）与 e2e 不从旧位置取名字：命名 import、type-only、re-export、命名空间成员与动态 import 的解构都认，
  带负对照。
- ④ 新文件的依赖面是闭集：只取 shared、source-control 的 `public/types`、`@/util/gitRef` 与本模块 domain / application；开作用域恰好一处、
  用 `withSelectedAutomationWorkspaceEffects`，不出现 `withAutomationWorkspaceEffects`；不取 infrastructure、composition、IO 包，不用进程
  全局，带负对照。

行为由现有用例对拍：`rfc396-mr-bridge`（交付、接续、复用、验证工作区与中断恢复）、`rfc396-mr-runtime-wiring`、`rfc396-mr-lifecycle`、
`rfc396-mr-job`、经 `composeGraphDevelopment` 装配的 `rfc396-current-evidence` 与 `rfc396-current-evidence-git`、`rfc396-verification`
与图开发的工作项用例。

## 5. 失败模式

- **工厂走样**：临时上传的搬运用的仍是装配时交来的同一个工厂；去掉的再次选定对选定过的工厂原样返回。
- **时钟走样**：`graphDevelopment.ts` 交 `Date.now`，与此前的缺省相同；用例照旧在调用时取时间。
- **遗留引用**：删除文件后由 `tsc` 与 RFC-498 用例 ③ 覆盖；迁移后按文件名（含路径片段）与代码里的字符串字面量全仓再扫。
- **锁静默变空**：眼下没有锁读这个文件；全仓再扫同样覆盖。

## 6. 取舍（可推翻）

1. **删除，不留装配文件**：唯一的装配方 `graphDevelopment.ts` 本就从 application 装配其余图开发用例；留一个只转手的文件既不装配什么，
   又让 S10 点名的文件继续留在 `composition/`（退出门要求它离开）。
2. **名字不变**：`createGraphDeliveryBridge` 与 `GraphMrHandoffResult` 的使用方只改 import 路径。
3. **不在装配处再选定工厂**：工厂在 bootstrap 选定一次，`composeGraphDevelopment` 的输入类型要求的就是选定过的工厂；再选定只是重复验证。
4. **时钟必填、由装配给**：与 RFC-495～497 一致，application 不取进程全局。
5. **`GraphDeliveryBridge` 类型不随迁**：全仓零引用，需要时可由 `ReturnType` 现取。
6. **文件名** `deliveryBridge.ts`：同目录按 `createGraph<Name>` ↔ `<name>.ts` 命名（`designCommands.ts`、`verification.ts`、`mrCare.ts`、
   `platformWorkItems.ts`）。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是交付用例与它的类型、辅助函数，落 application；工厂的选定在 bootstrap，默认时钟由 `graphDevelopment.ts` 给；不新增
  用例入口（用例本来就只由 `graphDevelopment.ts` 装配、交给工作项用例）。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-498 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明与 import，另读 `graphDevelopment.ts` 与新文件；只对这些范围宣告
  退出门。
- **C13**：`composition-control-flow-development-automation` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 development-automation 的第五步——S10 点名的 `graphDeliveryBridge.ts` 离开 `composition/`（点名的另两个文件由 RFC-497
  迁走实现、只剩装配）；组合层控制流 195 → 实测。
- **留下**：
  - 其余组合文件的控制流：`graphDevelopment.ts` 14 行、`pipelineEvidence.ts` 9 行、`developmentDelivery.ts` 8 行、`graphDeliveryLifecycle.ts`
    6 行、`activityOperations.ts` 5 行、`graphDeliveryJob.ts` 4 行等；`taskImage*` / `crewstation*`（80 行）待 RFC-370 余项。
  - S10 收口时，RFC-495～497 各留的只剩装配的同名文件并入模块装配或改名；`DevelopmentAutomationModule` 其余成员与它的装配仍在
    `composition.ts`，随 S10 收口与 S12 处理。
