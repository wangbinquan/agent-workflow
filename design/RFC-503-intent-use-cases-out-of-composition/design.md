# RFC-503 设计：意图的平台清单、图校验与维护命令迁出 composition

## 1. 现状（HEAD `7d2e82937`，源码实读）

intent 组合层控制流（F13 口径，按语法树计数）实测 23 行：本 RFC 的四个文件 18 行（`platformInventory.ts` 9、`graphValidation.ts` 5、
`maintenance.ts` 3、`dispatch.ts` 1），`resourceCatalog.ts` 1 行，RFC-370 余项的 `crewstationArtifacts.ts` 3 行与 `crewstationScratch.ts` 1 行。
四个文件都不在 `composition-forbidden-import-files` 的 12 个文件里。

**`composition/platformInventory.ts`，144 行**：第 1～9 行全是 type-only import——`@/auth/actor`、development-automation `public/operations`
的 `DevelopmentConfigOperations`、digital-employee `public/participants` 的 `DigitalEmployeePlatformInventoryParticipant`、identity-access
`public/participants` 的 `DirectAuthenticatedAuthority`、本模块 `application/ports/intentAuxiliaryQueries` 的两个类型与 domain
`teaching/platformMap` 的 `PlatformOnlyResourceType`。第 11～27 行导出 `IntentCapabilityTemplateInventoryQueries` 与
`IntentPlatformInventoryCompositionDependencies`；第 29～90 行私有的 `publishState`、`optionalText`、`sortRows`、`developmentRows`；第 97～144 行
`composeIntentPlatformInventoryParticipant(input)`：按资源类型取 code-capability、digital-employee 或 development-automation 五种配置资源的
可见行，投影成清单行再排序。文件里没有装配。

**`composition/graphValidation.ts`，50 行**：第 1～3 行注释（RFC-358：这里是唯一知道图校验由谁提供的地方，application 只见端口）；第 5～11 行
type-only import——`@/auth/actor`、resource-catalog `public/queries` 的 `WorkflowQueries` 与 `WorkflowValidationQueries`、`public/participants`
的 `WorkflowOperationContext`、本模块的端口类型；第 13～50 行 `composeIntentWorkflowGraphValidation(deps)`：`validate` 把候选交给
resource-catalog 的校验查询，`workflowsUsingAgents` 在 actor 可见的工作流里找引用了给定代理的工作流（第 37～44 行两层循环）。

**`composition/maintenance.ts`，154 行**：第 11～20 行 `IntentMaintenanceLog` 与 `IntentMaintenanceCompositionDependencies`；第 27～62 行快照查询
的接口与装配；第 64～113 行 `composeIntentMaintenanceCommands(dependencies)`：`scratch.sweep` 算截止时间（`input.now ?? Date.now()`）、跳过
运行中的 turn、逐个删除并记日志、把运行中与删除失败的排除在水位外（第 75～87 行循环与 `try`），`recovery` 列开机恢复的 turn、恢复并列出
排队的工作集（`input.now ?? Date.now()`）；第 115～154 行按 app home 与按数据库的装配（含回落到文件草稿目录的 `??`，S12 的事）。
`IntentMaintenanceLog` 与 `IntentMaintenanceCompositionDependencies` 只在这个文件里用。

**`composition/dispatch.ts`，15 行**：`resumeQueuedIntentWorkingSets(dependencies, sessionIds)` 第 13 行判空返回，否则调 application
`dispatcher.ts` 的同名函数。后者第 218～247 行：`sessionIds ?? 列出排队的`——空数组不是 nullish，于是 `queued` 为空、循环一次不进、返回 0，
没有别的副作用。

使用方：

- bootstrap `daemonModules/intent.ts` 第 18、22 行从 `composition/graphValidation` 与 `composition/platformInventory` 取两个工厂，第 89、106 行
  调用；第 19、153 行取并调用快照查询，第 15～17、157 行取恢复入口；`maintenanceWorkerGraph.ts` 第 31、270 行取按数据库的维护命令装配。
  intent 的 `composition.ts` 现有 schema、保留期阶段与维护任务处理器三组转出。
- 用例：`rfc349-intent-platform-inventory-composition` 第 15 行取 `composeIntentPlatformInventoryParticipant`；
  `rfc349-intent-integration-maintenance` 直接调 `composeIntentMaintenanceCommands`；其余维护用例只取按 app home / 按数据库的装配。
- 按路径钉着 `platformInventory.ts` 的边账本：`rfc305-architecture-lock` 第 364 行（→ identity-access `public/participants`）、
  `architecture/rfc294-review-offered-edge-dag` 第 357～368 行两条（→ development-automation、→ digital-employee，W4-E 销账）、
  `architecture/rfc376-structural-guards` 第 123～124 行两条，以及 RFC-310 `os-architecture-manifest.json` 里 digital-employee
  `externalImports` 第 47 行一条（→ `public/participants`，由 `rfc310-digital-employee-os-architecture` 逐条等值比对；落档时漏列，集中验证的全仓
  扫描补出，见 plan §集中验证）；`architecture/rfc380-daemon-module-bundles` 第 31、34 行把两个 `compose…` 名字列为成员工厂。`graphValidation.ts` 与 `dispatch.ts` 只有 bootstrap 按路径取。
- `rfc294-review-module-layer-rules` 只禁 domain / application / engine 取 `@/db/schema`、infrastructure 与适配器 / 厂商包；application 取外域
  `public/operations` 的类型有先例（system-operations `application/overview.ts`），取本模块 `public/commands` 的类型有 15 处先例。

清单里的名字在全部生产文件、用例与 e2e 里没有别的顶层同名声明，`optionalText` 除外：identity-access 的
`infrastructure/crewstation/crewStationIdentityToken.ts` 有一份同名的私有函数。

## 2. 机制与落位

### D1 用例落 application

三组都是经传入端口工作的用例：平台清单参与者实现本模块的 `IntentPlatformInventoryParticipant` 端口、只取外域 `public` 的类型；图校验实现
本模块的 `IntentWorkflowGraphValidationPort`、经 resource-catalog 的 exact public 查询工作；维护命令编排本模块的持久化与草稿目录端口，交出本
模块 `public/commands` 的合同。RFC-294 design §3 的 `application/adapters` 是“本域实现他域 consumer-owned required SPI”，这里实现的是本模块
自己的端口，落 `application/`（RFC-501 的启动准入同样取外域 `public/queries`）。

### D2 新文件

- **`application/platformInventoryParticipant.ts`**：第 11～144 行原样迁入；`composeIntentPlatformInventoryParticipant` →
  `createIntentPlatformInventoryParticipant`，`IntentPlatformInventoryCompositionDependencies` → `IntentPlatformInventoryParticipantDependencies`；
  import 按新目录改写。`application/platformInventory.ts`（消费方：渲染清单文件）不动。
- **`application/workflowGraphValidationProvider.ts`**：第 13～50 行原样迁入为 `createIntentWorkflowGraphValidation`；文件头改写 RFC-358 的
  注释——知道“由谁提供”的地方从 composition 换成这个文件，application 的其余代码仍只见端口。`application/graphValidation.ts`（消费方）不动。
- **`application/maintenanceCommands.ts`**：`IntentMaintenanceLog` 与第 64～113 行的命令原样迁入为 `createIntentMaintenanceCommands(dependencies)`，
  依赖 `IntentMaintenanceCommandDependencies`（持久化、草稿目录、可选日志与必填的 `now`）；函数体里两处 `input.now ?? Date.now()` 改为
  `input.now ?? dependencies.now()`，其余逐字。`application/maintenance.ts`（旧函数）不动。

### D3 composition 只装配

- 删除 `composition/platformInventory.ts` 与 `composition/graphValidation.ts`；intent 的 `composition.ts` 转出两个工厂（与已有的维护任务处理器
  转出并列）；bootstrap `daemonModules/intent.ts` 改从 `@/modules/intent/composition` 取，两处调用改名，参数不变。
- `composition/maintenance.ts`：`IntentMaintenanceCompositionDependencies` 改取新文件的 `IntentMaintenanceLog` 类型；`composeIntentMaintenanceCommands`
  留下、只做 `createIntentMaintenanceCommands({ ...dependencies, now: () => Date.now() })`（进程时钟仍在调用时取，与此前相同）；其余逐字。
- `composition/dispatch.ts`：去掉第 13 行的空判断，直接调 application 的同名函数（空列表的行为见 §1，不变）。

### D4 锁、账本与清单

- 用例：`rfc349-intent-platform-inventory-composition` 改从 application 取 `createIntentPlatformInventoryParticipant`；
  `architecture/rfc380-daemon-module-bundles` 的 `FACTORIES` 两个名字换新名字。
- 边账本改钉新文件、上下文对不变：`rfc305-architecture-lock` 一条、`architecture/rfc294-review-offered-edge-dag` 两条（`why` 与销账波次照旧）、
  `architecture/rfc376-structural-guards` 两条、RFC-310 `os-architecture-manifest.json` 的 digital-employee `externalImports` 一条（集中验证补出）。
- `architecture/counts.json`：`composition-control-flow-intent` 23 → 实测（预计 5）。`guard-manifest.json` 登记 RFC-503 用例。
- 不改：只取装配入口的维护用例；`design/` 里的历史记述。

## 3. 清单（退出门）

| 新文件（`modules/intent/application/`） | 声明并交出                                                                                                                               | 只声明不交出                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `platformInventoryParticipant.ts`       | `IntentCapabilityTemplateInventoryQueries`、`IntentPlatformInventoryParticipantDependencies`、`createIntentPlatformInventoryParticipant` | `publishState`、`optionalText`、`sortRows`、`developmentRows` |
| `workflowGraphValidationProvider.ts`    | `createIntentWorkflowGraphValidation`                                                                                                    | —                                                             |
| `maintenanceCommands.ts`                | `IntentMaintenanceLog`、`IntentMaintenanceCommandDependencies`、`createIntentMaintenanceCommands`                                        | —                                                             |

允许的形状：`composition/platformInventory.ts` 与 `composition/graphValidation.ts` 不存在；改名前的 `composeIntentPlatformInventoryParticipant`、
`composeIntentWorkflowGraphValidation` 与 `IntentPlatformInventoryCompositionDependencies` 没有声明；`composition/maintenance.ts` 与
`composition/dispatch.ts` 没有 if / for / while / do / switch / try / throw 语句，前者从新文件取工厂；intent 的 `composition.ts` 从新文件转出两个
工厂，bootstrap 只经它取、各调用一次。

## 4. 用例

新增 `packages/backend/tests/rfc503-intent-use-cases-out-of-composition-boundary.test.ts`（文件名带 `boundary`），登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的新文件声明（`optionalText` 另有 identity-access 的那一份，
  钉住）；改名前的三个名字没有声明；每个新文件恰好声明、交出清单列的名字。
- ② 两个组合文件不存在；`maintenance.ts` 与 `dispatch.ts` 没有控制流语句，`maintenance.ts` 从新文件取工厂；intent 的 `composition.ts` 从新文件
  转出两个工厂，bootstrap 只从 `@/modules/intent/composition` 取它们、各调用一次；带负对照。
- ③ 全部生产文件、用例与 e2e 不从两个删除的位置取任何东西：命名、type-only、默认与副作用 import、re-export、命名空间成员与动态 import 都认，
  带负对照。
- ④ 新文件的依赖面是闭集：只取 `@/auth/actor`、四个外域的 `public` 类型入口与本模块 domain / application / public；不取 infrastructure、
  composition、IO 包，不用进程全局；带负对照。

行为由现有用例对拍：`rfc349-intent-platform-inventory-composition`（平台清单）、意图的图校验与 turn 用例（经 bootstrap 跑图校验）、
`rfc349-intent-integration-maintenance`、`rfc370-m2-retained-scratch`、`rfc359-w12-intent-operations-composition` 等维护用例（两条维护命令）、
`rfc349-intent-boot-resume-authority` 与 `rfc293-intent-state`（开机恢复排队工作集）。

## 5. 失败模式

- **用例走样**：函数体逐字迁移；维护命令的时钟从 `Date.now()` 换成传入的 `now()`，组合文件交的就是 `() => Date.now()`、仍在调用时取。
- **空列表**：`dispatch.ts` 去掉判空后 application 收到空数组——§1 读过它的函数体，不列表、不循环、无副作用。
- **遗留引用**：删除文件后由 `tsc` 与 RFC-503 用例 ③ 覆盖；迁移后按名字、路径片段与代码里的字符串字面量全仓再扫。
- **锁静默变空**：四个边账本改钉新文件，上下文对与销账波次照旧；`rfc380` 的名字表换新名字。

## 6. 取舍（可推翻）

1. **四个文件一个 RFC**：同一个模块、同一种形状（用例写在 composition），清单与用例按文件逐项列。
2. **删除两个组合文件，经 `composition.ts` 转出**：它们没有装配可留（RFC-501 同样处理）；bootstrap 只取 public、模块 `composition.ts` 与
   `composition/*`，不能直接取 application。
3. **图校验的实现进 application**：RFC-358 把“由谁提供”放在 composition，是为了 application 只见端口；S10 要求组合层没有循环，而
   `workflowsUsingAgents` 的查找是逻辑。实现放进单独的 application 文件，其余 application 代码照旧只见端口，domain 仍不见端口。把“哪些工作流
   引用了这些代理”下沉成 resource-catalog 的公共查询会扩大 public surface，不在本步。
4. **维护命令的时钟必填、`composeIntentMaintenanceCommands` 留着**：缺省时钟是装配的选择（RFC-500、RFC-502 同样处理）；留下装配入口，直接调它
   的维护用例不用改。
5. **`dispatch.ts` 只删判空**：恢复入口留作 RFC-384 的组合边界，判空在 application 里本就是无操作。
6. **新文件名**：`platformInventoryParticipant.ts`、`workflowGraphValidationProvider.ts`、`maintenanceCommands.ts` 与同目录已有的消费方文件
   （`platformInventory.ts`、`graphValidation.ts`、`maintenance.ts`）区分开，不合并。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是三组用例，落 application；两个组合文件删除，余下两处只装配、没有控制流；不新增用例入口（bootstrap 照旧各取一份）。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-503 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明与 import，另读 `maintenance.ts`、`dispatch.ts`、intent `composition.ts`、
  bootstrap 文件与新文件；只对这些范围宣告退出门。
- **C13**：`composition-control-flow-intent` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 intent 的第一步——平台清单、图校验与维护命令离开 `composition/`，两个组合文件删除；组合层控制流 23 → 实测。
- **留下**：`resourceCatalog.ts` 解析 actor 时的 `throw`（装配期的绑定守卫；文件取 `@/routes/operationAuthority`，随 S10 收口的登记清单或
  S12 处理）；`crewstationArtifacts.ts` 3 行与 `crewstationScratch.ts` 1 行待 RFC-370 余项；`maintenance.ts` 回落到文件草稿目录的 `??` 随
  S12；`application/maintenance.ts` 的旧函数（直接取 `node:fs`）另立。
