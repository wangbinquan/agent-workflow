# RFC-501 设计：集成的 webhook 启动准入与触发器校验迁出 composition

## 1. 现状（HEAD `ea271ecac`，源码实读）

integration 组合层控制流（F13 口径，按语法树计数）实测 74 行，`composition/webhookAdmission.ts` 占 17 行。

`composition/webhookAdmission.ts`，191 行：

- 第 1～24 行 import：`@/auth/actor` 的类型 `Actor`；本模块 application 的 `ports/webhookConfiguration`（类型）、`scheduledTasks`（三个
  函数与类型 `ScheduledTaskOperations`）、`ports/scheduledTaskPersistence`（类型）、`webhookDispatch`（`renderWebhookLaunch` 与两个类型）、
  `webhookTriggers`（类型）；domain 的 `webhookTriggerValidation`（`rehearsalEvent`、`staticTriggerIssues` 与类型）；resource-catalog
  `public/types` 的类型与 `public/queries` 的 `assertTriggerPreflight`；`@/util/errors` 的 `ValidationError`；shared 的
  `webhookPayloadTemplateSchemaFor` 与类型 `WorkflowDefinition`。
- 第 26～58 行 `composeWebhookLaunchAdmission(operations)`：返回 `admitLaunch`——数字员工目标按定义取资源快照并校验，其余目标按种类校验
  定时目标。
- 第 60～170 行 `assertWebhookTriggerSaveable(operations, actor, resourceAuthority, candidate, defaultRuntime)`：保存触发器前的校验——
  校验 launch payload 的 schema，工作流 / 数字员工目标取资源快照（工作流另冻结调用闭包），汇总静态问题，工作流做预检，演练渲染一次后
  按渲染结果校验目标。
- 第 172～191 行 `composeWebhookTriggerValidation(operations, configuration)`：返回 `validateSaveable`——读配置里的默认运行时（读失败
  视为未设），再调 `assertWebhookTriggerSaveable`。

文件不取 infrastructure 与 composition，没有进程全局。

使用方：

- `infrastructure/webhookDispatchRuntime.ts` 第 11 行取 `composeWebhookLaunchAdmission`，第 13～17 行的 `createWebhookLaunchAdmission`
  只把它原样转手——infrastructure 取 composition，RFC-294 design §2 的依赖表不许。
- `composition/webhookDispatch.ts` 第 10 行从 infrastructure 取 `createWebhookLaunchAdmission`，第 91 行交给派发的 `admitLaunch`；第 54 行的
  注释提到 `composeWebhookTriggerValidation`。
- bootstrap `daemonModules/integration.ts` 第 22 行取 `composeWebhookTriggerValidation`，第 215 行交给触发器服务。
- 用例：`webhook-trigger-digital-employee-validation` 与 `webhook-trigger-validation-acl-order` 取 `assertWebhookTriggerSaveable`；
  `rfc370-webhook-configuration`（第 10、111 行）与 `rfc359-w7-integration-composition-roots`（第 55、340 行）取并调用
  `composeWebhookTriggerValidation`；`rfc359-w4-b4a-adapters`（第 21、464 行）从 infrastructure 取 `createWebhookLaunchAdmission`。

按路径或名字读这些文件的锁：`rfc345-resource-catalog-contracts` 第 739 行读 `composition/webhookAdmission.ts`，要求含
`kind: 'webhook-workflow'` 与 `kind: 'webhook-digital-employee'`；`architecture/rfc380-daemon-module-bundles` 的 `FACTORIES`（第 160、164 行）
列着两个 `compose…` 名字（不许出现在根装配里的成员工厂）；`rfc257-source-locks`、`rfc243-executor-facade` 与 `rfc321` 读
`webhookDispatchRuntime.ts`，只看执行运行时与两个参与方的转交，不涉及被删的转手函数。`composition-forbidden-import-files` 的 12 个文件
不含它。清单里的名字在全部生产文件、用例与 e2e 里没有别的顶层同名声明（`createWebhookLaunchAdmission` 除外：它在 infrastructure 的转手
函数随本 RFC 删除）。

## 2. 机制与落位

### D1 准入落 application

两道准入编排本模块 application 的定时任务校验与派发渲染、domain 的触发器静态校验与 resource-catalog 的 public 预检，经传入的端口工作，
属于 application；同目录的 `webhookDispatch.ts`、`webhookTriggers.ts` 与 `scheduledTasks.ts` 就是它们取的东西。
`rfc294-review-module-layer-rules` 只禁 application 取 infrastructure（值与类型）、composition 与传输层。

### D2 新文件 `application/webhookAdmission.ts`

- 第 1～191 行原样迁入，只改两处：两个工厂改名（`composeWebhookLaunchAdmission` → `createWebhookLaunchAdmission`、
  `composeWebhookTriggerValidation` → `createWebhookTriggerValidation`）；import 按新目录改写路径（`../application/…` → `./…`，
  `../domain/…` 照旧）。
- `assertWebhookTriggerSaveable` 名字、签名与函数体不变；两个工厂的函数体逐字。

### D3 composition 不再有这个文件，infrastructure 不再取 composition

- 删除 `composition/webhookAdmission.ts`。
- `infrastructure/webhookDispatchRuntime.ts` 删去转手的 `createWebhookLaunchAdmission` 与它取 composition 的 import，其余逐字。
- `composition/webhookDispatch.ts` 第 10 行改为从 `../application/webhookAdmission` 取 `createWebhookLaunchAdmission`（与同文件取
  application 类型的 import 并列），第 91 行不变；第 54 行的注释改名。
- integration `composition.ts` 转出 `createWebhookTriggerValidation`（与已有的 application 转出并列）；bootstrap 第 22 行改为从
  `@/modules/integration/composition` 取它，第 215 行改调新名字，参数不变。

### D4 锁、账本与清单

- 用例改取新位置：`webhook-trigger-digital-employee-validation`、`webhook-trigger-validation-acl-order` 改取 application 的
  `assertWebhookTriggerSaveable`；`rfc370-webhook-configuration`、`rfc359-w7-integration-composition-roots` 改取并调用 application 的
  `createWebhookTriggerValidation`；`rfc359-w4-b4a-adapters` 改从 application 取 `createWebhookLaunchAdmission`。
- `rfc345-resource-catalog-contracts` 改读 `application/webhookAdmission.ts`（两句断言照旧成立）；`rfc380-daemon-module-bundles` 的
  `FACTORIES` 里两个名字换成新名字。
- `architecture/counts.json`：`composition-control-flow-integration` 74 → 实测（预计 57）。
- `guard-manifest.json` 登记 RFC-501 用例。
- 不改：`rfc257-source-locks`、`rfc243-executor-facade` 与 `rfc321` 读的内容不受影响；`design/` 里的历史记述不改。

## 3. 清单（退出门）

- **`application/webhookAdmission.ts`**：交出 `createWebhookLaunchAdmission`、`assertWebhookTriggerSaveable`、
  `createWebhookTriggerValidation`。

允许的形状：`composition/webhookAdmission.ts` 不存在；改名前的 `composeWebhookLaunchAdmission`、`composeWebhookTriggerValidation` 没有
声明；`infrastructure/webhookDispatchRuntime.ts` 不声明 `createWebhookLaunchAdmission`、不取 composition；`composition/webhookDispatch.ts`
从新文件取启动准入；bootstrap 只经 integration 的 `composition.ts` 取校验器工厂。

## 4. 用例

新增 `packages/backend/tests/rfc501-integration-webhook-admission-out-of-composition-boundary.test.ts`（文件名带 `boundary`），登记
guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在新文件声明；改名前的两个名字没有声明。
- ② `composition/webhookAdmission.ts` 不存在；`webhookDispatchRuntime.ts` 不声明 `createWebhookLaunchAdmission`、不取 composition；
  `composition/webhookDispatch.ts` 从新文件取 `createWebhookLaunchAdmission`；integration `composition.ts` 从新文件转出
  `createWebhookTriggerValidation`，bootstrap 只从 `@/modules/integration/composition` 取它；带负对照。
- ③ 全部生产文件、用例与 e2e 不从旧位置取任何东西：命名 import、type-only、默认与副作用 import、re-export、命名空间成员与动态 import
  都认，带负对照。
- ④ 新文件的依赖面是闭集：只取 shared、`@/util/errors`、`@/auth/actor` 的类型、resource-catalog 的 `public` 与本模块 domain /
  application；不取 infrastructure、composition、IO 包，不用进程全局；带负对照。

行为由现有用例对拍：`webhook-trigger-digital-employee-validation`、`webhook-trigger-validation-acl-order`（保存校验的分支与 ACL 次序）、
`rfc370-webhook-configuration`（校验器读配置与读失败）、`rfc359-w7-integration-composition-roots`、经派发跑启动准入的 webhook 用例
（`rfc257-webhook-ingress`、`rfc268-webhook-scratch-launch`、`rfc269-webhook-code-host-context-e2e`、`rfc300-webhook-workspace-cleanup-e2e`
等）与 `rfc345-resource-catalog-contracts`。

## 5. 失败模式

- **准入走样**：三个函数体逐字迁移；派发拿到的启动准入此前经 infrastructure 转手、现在直接取，是同一个函数。
- **遗留引用**：删除文件后由 `tsc` 与 RFC-501 用例 ③ 覆盖；迁移后按文件名（含路径片段）与代码里的字符串字面量全仓再扫。
- **锁静默变空**：`rfc345` 改读新文件、断言照旧；`rfc380` 的名字表换成新名字；全仓再扫同样覆盖。

## 6. 取舍（可推翻）

1. **删除，不留装配文件**：三个函数都是用例，没有要装配的东西；唯一取它的 composition（`webhookDispatch.ts`）直接从 application 取，
   bootstrap 经 `composition.ts` 的转出取校验器工厂。
2. **删去 infrastructure 的转手函数**：它只把 composition 的工厂原样转手，留着就要么继续反取 composition、要么改取 application 再转手
   一次；派发的装配直接取 application 更直接。
3. **工厂改名为 `create…`**：与同层的 `createGraphDeliveryBridge`、`createDevelopment…EventObserver` 一致，`compose…` 留给 composition 的
   装配；改名后 `createWebhookLaunchAdmission` 正好接替被删的转手函数的名字，测试只改 import 路径。
4. **文件名** `webhookAdmission.ts`：同目录按职责命名（`webhookDispatch.ts`、`webhookTriggers.ts`），内容不变、名字随迁。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是两道准入用例与校验器工厂，落 application；composition 不再有这个文件；infrastructure 不再取 composition；不新增用例
  入口（派发与触发器服务照旧各取一份）。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-501 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明与 import，另读 `webhookDispatchRuntime.ts`、`webhookDispatch.ts`、
  `composition.ts`、bootstrap 文件与新文件；只对这些范围宣告退出门。
- **C13**：`composition-control-flow-integration` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 integration 的第二步——webhook 的两道准入离开 `composition/`，一条 infrastructure → composition 的反向边消失；组合层
  控制流 74 → 实测。
- **留下**：integration 其余组合文件的控制流：`developmentAdapterConfigOperations.ts` 12 行、`codeHostEffects.ts` 11 行、`approvalGateway.ts`
  10 行、`digitalEmployeeToolConnections.ts` 7 行、`webhookIngress.ts` 1 行；`taskImageDevelopmentAdapter.ts` 13 行与
  `crewstationDevelopmentAdapters.ts` 3 行待 RFC-370 余项；`webhookDispatch.ts` 其余的装配随 S10 收口与 S12 处理。
