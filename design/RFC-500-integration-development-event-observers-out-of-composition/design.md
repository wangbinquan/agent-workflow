# RFC-500 设计：集成的开发员工事件观察者迁出 composition

## 1. 现状（HEAD `3cf7d3404`，源码实读）

integration 组合层控制流（F13 口径，按语法树计数）实测 101 行，`composition/digitalEmployeeEventObserver.ts` 占 27 行。

`composition/digitalEmployeeEventObserver.ts`，428 行：

- 第 1～14 行 import：`node:crypto` 的 `randomUUID`、shared 的 `canonicalJson` 与 `utf16MaxLength`、zod、`@/util/hash` 的 `sha256Hex`、
  development-automation `public/types` 的 `DEVELOPMENT_APPROVAL_STATUS_CHANGED_EVENT_REF`、`decodeDevelopmentApprovalSubject` 与类型
  `DevelopmentApprovalSubject`，本模块 `application/mrFacts` 的 `collectMergeRequestFacts` 与类型 `MrFactsSnapshot`、`application/mrEnsure` 的
  类型 `MrEnsureConnectionDeps`。
- 第 16～29 行：私有接口 `ObserverSource`、`ObserverSubject` 与函数 `splitMrSubject`。
- 第 31～99 行 `buildDevelopmentCodeHostFacts(snapshot)`：MR 事实快照投影成生命周期、检视、冲突与门禁复核四类事实（纯函数）。
- 第 101～151 行：私有类型 `DevelopmentCodeHostFact`、`CursorFactCode`，两张按事件类型的表 `cursorFactCodeByEventType`、
  `codeHostFactRevisionByEventType`，函数 `codeHostFactRevision` 与游标的三个 schema。
- 第 153～215 行 `advanceDevelopmentCodeHostObserverCursor(input)`：按事实摘要推进游标，给出变化与去重键（纯函数；激活标识由输入给）。
- 第 217～303 行 `composeDevelopmentCodeHostEventObserver(input)`：输入是代码托管绑定与可选的 `now`、`activationRef`；第 224～225 行
  `const now = input.now ?? Date.now`、`const activationRef = input.activationRef ?? randomUUID`；`run` 对 `code-host.activity` 来源逐个 MR
  主题经绑定与 `collectMergeRequestFacts` 取快照、投影、推进游标，产出观察。
- 第 305～333 行：私有的审批游标 schema `approvalObserverCursorSchema` 与网关接口 `DevelopmentApprovalObservationGateway`。
- 第 335～411 行 `composeDevelopmentApprovalEventObserver(input)`：输入是网关与可选的 `now`；第 339 行 `const now = input.now ?? Date.now`；
  `run` 对 `development.approval-state` 来源逐个审批主题读回执，摘要变化时产出 `development.approval-updated` 与审批状态变化两条观察。
- 第 413～428 行 `composeDevelopmentEmployeeEventObserver(input)`：按来源把请求分派给审批或代码托管观察者。

文件不取 infrastructure 与 composition；进程全局只有上述三处缺省。

使用方：

- bootstrap `daemonModules/integration.ts`（236 行）：第 20～24 行取三个 `compose…`；第 83～85 行的输入类型
  `developmentCodeHostBinding: Parameters<typeof composeDevelopmentCodeHostEventObserver>[0]['binding']`；第 174～181 行调用一次——
  分派器的 `codeHost` 交 `composeDevelopmentCodeHostEventObserver({ binding: input.developmentCodeHostBinding })`，`approval` 交
  `composeDevelopmentApprovalEventObserver({ gateway: developmentApprovalGateway })`，都不传 `now` 与 `activationRef`。
- 用例 `rfc310-event-center`：第 20～24 行取 `advanceDevelopmentCodeHostObserverCursor`、`buildDevelopmentCodeHostFacts` 与
  `composeDevelopmentApprovalEventObserver`；第 482 行建审批观察者时交 `now: () => 42`。

按内容读这些文件的锁：`rfc471-development-delivery-code-host-bridge` 第 326～328 行要求 bootstrap 文件含 `binding: input.developmentCodeHostBinding,`。
没有锁按路径读观察者文件（全部包、`e2e`、`scripts`、`architecture` 与 `.github` 扫过）；`composition-forbidden-import-files` 的 12 个文件不含它；
`design/` 里提到它的是 RFC-317 的 findings（当时的锚点）。清单里的名字在全部生产文件、用例与 e2e 里没有别的顶层同名声明。

## 2. 机制与落位

### D1 观察者落 application

纯投影、游标与三个用例一起落 application：

- 代码托管观察者编排本模块 application 的 `collectMergeRequestFacts`、经代码托管绑定工作；审批观察者经审批网关工作；分派器按请求的来源
  选择——都是用例，属于 application。
- 纯投影与游标取 application 的 `MrFactsSnapshot`（`application/mrFacts.ts:45`）；domain 不取 application，拆到 domain 要先迁这个类型（不在
  本步，见 §6）。
- integration `application/` 已有取 zod、`@/util/hash` 与 development-automation `public/types` 的文件；`rfc294-review-module-layer-rules`
  只禁 application 取 infrastructure（值与类型）、composition 与传输层。

### D2 新文件 `application/developmentEventObservers.ts`

- 第 3～428 行原样迁入，只改三处：
  - 三个用例改名：`composeDevelopmentCodeHostEventObserver` → `createDevelopmentCodeHostEventObserver`、
    `composeDevelopmentApprovalEventObserver` → `createDevelopmentApprovalEventObserver`、`composeDevelopmentEmployeeEventObserver` →
    `createDevelopmentEmployeeEventObserver`（分派器输入里的两处 `ReturnType<typeof compose…>` 随之改名）；
  - 输入的 `now`（两处）与 `activationRef` 改为必填，第 224～225 行与第 339 行改为直接取输入；
  - import 去掉 `node:crypto`，`../application/mrFacts` 与 `../application/mrEnsure` 改为同目录。
- 其余逐字：两个纯函数的名字、签名与函数体，私有类型、表、schema 与网关接口，三个 `run` 的函数体。

### D3 composition 只装配

`composition/digitalEmployeeEventObserver.ts` 改为只有一个装配函数（文件名不变）：

```ts
export function composeDevelopmentEmployeeEventObserver(input: {
  readonly binding: Parameters<typeof createDevelopmentCodeHostEventObserver>[0]['binding']
  readonly gateway: Parameters<typeof createDevelopmentApprovalEventObserver>[0]['gateway']
}) {
  return createDevelopmentEmployeeEventObserver({
    codeHost: createDevelopmentCodeHostEventObserver({
      binding: input.binding,
      now: Date.now,
      activationRef: randomUUID,
    }),
    approval: createDevelopmentApprovalEventObserver({ gateway: input.gateway, now: Date.now }),
  })
}
```

没有控制流；时钟与激活标识与此前的缺省相同（`Date.now`、`randomUUID`），照旧在每次 `run` 时调用。

bootstrap `daemonModules/integration.ts`：第 20～24 行只取 `composeDevelopmentEmployeeEventObserver`；第 83～85 行的类型改为
`Parameters<typeof composeDevelopmentEmployeeEventObserver>[0]['binding']`（同一个类型）；第 174～181 行改为
`composeDevelopmentEmployeeEventObserver({ binding: input.developmentCodeHostBinding, gateway: developmentApprovalGateway })`。
`rfc471` 要求的 `binding: input.developmentCodeHostBinding,` 照旧在。

### D4 锁、账本与清单

- `rfc310-event-center`：import 改取 `application/developmentEventObservers` 的 `advanceDevelopmentCodeHostObserverCursor`、
  `buildDevelopmentCodeHostFacts` 与 `createDevelopmentApprovalEventObserver`（第 482 行改名，照旧交 `now: () => 42`）。
- `architecture/counts.json`：`composition-control-flow-integration` 101 → 实测（预计 74）。
- `guard-manifest.json` 登记 RFC-500 用例。
- 不改：`rfc471` 的正则照旧成立；没有其他锁或账本读这些文件；`design/` 里的历史记述不改。

## 3. 清单（退出门）

- **`application/developmentEventObservers.ts`**：交出 `buildDevelopmentCodeHostFacts`、`advanceDevelopmentCodeHostObserverCursor`、
  `createDevelopmentCodeHostEventObserver`、`createDevelopmentApprovalEventObserver`、`createDevelopmentEmployeeEventObserver`；模块内私有：
  `ObserverSource`、`ObserverSubject`、`splitMrSubject`、`DevelopmentCodeHostFact`、`CursorFactCode`、`cursorFactCodeByEventType`、
  `codeHostFactRevisionByEventType`、`codeHostFactRevision`、`observerCursorEntrySchema`、`observerCursorSubjectSchema`、`observerCursorSchema`、
  `approvalObserverCursorSchema`、`DevelopmentApprovalObservationGateway`。
- **`composition/digitalEmployeeEventObserver.ts`**：只有 `composeDevelopmentEmployeeEventObserver`。

允许的形状：装配文件只取 `node:crypto` 与新文件，建两个观察者与分派器各恰好一次、没有控制流语句；bootstrap 只从装配文件取
`composeDevelopmentEmployeeEventObserver`，调用恰好一次。

## 4. 用例

新增 `packages/backend/tests/rfc500-integration-development-event-observers-out-of-composition-boundary.test.ts`（文件名带 `boundary`），
登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在清单列的文件声明。
- ② 装配文件只取 `node:crypto` 与新文件、只交出 `composeDevelopmentEmployeeEventObserver`，没有控制流语句，两个观察者与分派器各建恰好
  一次，时钟恰好两处 `Date.now`、激活标识恰好一处 `randomUUID`；bootstrap 只从装配文件取这一个名字、调用恰好一次；带负对照。
- ③ 全部生产文件、用例与 e2e 不从旧位置取迁走的名字（三个 `compose…` 里只有 `composeDevelopmentEmployeeEventObserver` 还在那里）：
  命名 import、type-only、re-export、命名空间成员与动态 import 的解构都认，带负对照。
- ④ 新文件的依赖面是闭集：只取 shared、zod、`@/util/hash`、development-automation 的 `public/types` 与同目录的 `mrFacts` / `mrEnsure`；
  不取 infrastructure、composition、IO 包，不用进程全局（`Date.now`、`randomUUID`、`Math.random`、`process`），三个用例的时钟与激活
  标识必填；带负对照。

行为由现有用例对拍：`rfc310-event-center`（纯投影、游标与审批观察者）、经 bootstrap 装配事件中心的用例（`rfc381-daemon-integration-bundles`、
员工自动化包等）与 RFC-471 的代码托管桥用例。

## 5. 失败模式

- **时钟或激活标识走样**：装配交 `Date.now` 与 `randomUUID`，与此前的缺省相同；观察者照旧在每次 `run` 时调用。
- **分派走样**：分派器的判据与两个观察者的 `run` 逐字迁移；装配交给分派器的正是新建的两个观察者。
- **遗留引用**：由 `tsc` 与 RFC-500 用例 ③ 覆盖；迁移后按文件名（含路径片段）与代码里的字符串字面量全仓再扫。
- **锁静默变空**：`rfc471` 的正则照旧匹配；全仓再扫同样覆盖。

## 6. 取舍（可推翻）

1. **纯投影与游标留在 application、与用例同文件**：它们取 application 的 `MrFactsSnapshot`，domain 不取 application；先把这个类型迁到
   domain 会动 `mrFacts.ts` 与它在 development-automation 的使用方，超出本步。
2. **装配文件留一个函数、bootstrap 只调它**：bootstrap 交的是部署选定的绑定与网关；两个观察者与分派器怎么接是模块自己的装配，不必由
   bootstrap 一个个建。装配文件不再交出两个单独的观察者（只有 bootstrap 用过）。
3. **application 里的名字改为 `create…`**：与同层的 `createGraphDeliveryBridge`、`createRepositoryPreparationBridge` 一致，`compose…`
   留给 composition 的装配。
4. **时钟与激活标识必填、由装配给**：与 RFC-495～498 一致，application 不取进程全局。
5. **文件名** `developmentEventObservers.ts`：同目录按职责命名（`mrFacts.ts`、`mrEnsure.ts`、`webhookDispatch.ts`），三个用例同属开发员工的
   事件观察者。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是三个观察者用例与它们的纯投影、游标，落 application；composition 只留装配（时钟与激活标识的选定）；不新增用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-500 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明与 import，另读装配文件、bootstrap 文件与新文件；只对这些范围
  宣告退出门。
- **C13**：`composition-control-flow-integration` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 integration 的第一步——开发员工事件观察者离开 `composition/`，组合层控制流 101 → 实测。
- **留下**：
  - integration 其余组合文件的控制流：`webhookAdmission.ts` 17 行、`developmentAdapterConfigOperations.ts` 12 行、`codeHostEffects.ts` 11 行、
    `approvalGateway.ts` 10 行、`digitalEmployeeToolConnections.ts` 7 行等；`taskImageDevelopmentAdapter.ts` 13 行与 `crewstationDevelopmentAdapters.ts`
    3 行待 RFC-370 余项。
  - 纯投影与游标随 `MrFactsSnapshot` 迁 domain 时一并下沉；S10 收口时只剩装配的文件并入模块装配或改名。
