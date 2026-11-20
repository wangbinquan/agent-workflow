# RFC-517 设计：模块根装配文件的运行期逻辑迁出（二）

## 1. 现状（HEAD，源码实读）

| 文件（`packages/backend/src/modules/` 下） | 内容（HEAD 行）                                                                                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `digital-employee/composition.ts`          | 清单参与者（302～406：行与授权面两个类型、`inventoryText`、`sortInventoryRows`、`composeDigitalEmployeePlatformInventoryParticipant`）；员工定义视图投影 `employeeView`（593～633，闭包只用 `store`） |
| `system-operations/composition.ts`         | 文件库启动准备（210～219 两个类型；238～251 持锁段）；schema 计划核对（355～357）；暂存还原后释放工件（586～597）                                                                                     |
| `task-execution/composition.ts`            | 两个归属期常量（35～36）、`ClaimedTaskExecution`（38～43）、`TaskExecutionModule`（45～139）、`ProviderTaskExecutionModule`（141～185）、`createTaskExecutionShutdownController`（215～247）          |

按被迁的每一行原文（含正则里转义的写法，RFC-514 的教训）全仓搜用例。钉着原文或位置的锁：`rfc328-architecture-guards` 的工厂白名单把
`createWorkerIdentity` 的调用方钉在 task-execution 模块根；`rfc305-architecture-lock` 的 identity-access 入口导入清单逐文件列着
`digital-employee/composition.ts`；RFC-515 门的例外清单。其余读这三个模块根原文的用例读的是留在模块根的文字，不受影
响：`rfc385-execution-generation-guard` 钉 `new TaskExecutionModule(DAEMON_GENERATION)`，另有
`rfc310-digital-employee-os-architecture`、`rfc349-digital-development-provider-boundary` 与
`rfc359-w5-t19b-composition-placeholders-removed`；`rfc349-postgresql-system-operations-composition` 按错误串断言 schema 计划核对，行为不
变。

## 2. 机制与落位

### D1 归位

- **`digital-employee/application/platformInventoryParticipant.ts`**（新）：HEAD 第 302～406 行逐字（授权面类型改由这里导出）；取本模块
  `application/ports/digitalEmployeeModule` 与 `public/participants` 的类型、identity-access public 的 `DirectAuthenticatedAuthority`。它实
  现的是本模块 public 里提供给 Intent 的参与者，属 application。
- **`digital-employee/application/employeeDefinitionView.ts`**（新）：`createEmployeeDefinitionViewProjection(store)` 返回 HEAD 第
  594～633 行的投影函数（逐字，闭包变量 `store` 改为工厂参数）；取本模块 `application/authoringService` 与两个端口的类型。
- **`system-operations/infrastructure/local/fileDatabaseProviderBoot.ts`**（新）：两个类型（HEAD 第 210～219 行，改为导出）与
  `prepareFileDatabaseProviderForBoot(input)`，函数体是 HEAD 第 238～251 行逐字。锁（`@/util/lock`）、epoch 准入
  （`infrastructure/epochSwitch/bootAdmission`，模块根经 `composition/epochBootAdmission` 取的就是它）、迁库恢复与运行时准备都是单机 profile
  的机制，落 `infrastructure/local/`。
- **`system-operations/application/postgresqlSchemaPlanAdmission.ts`**（新）：`requirePostgresqlSchemaPlanForContract(plan, contract)`，函数
  体是 HEAD 第 355～357 行逐字；只取 platform persistence 的两个类型（system-operations 的 application 已有同样的取法）。
- **`system-operations/application/stageRestoreArtifactRelease.ts`**（新）：`releaseArtifactAfterStageRestore(command, artifacts)` 返回 HEAD
  第 586～597 行的命令对象（`application.commands.stageRestore` 换成参数 `command`，`deps.artifacts` 换成只带 `release` 的参数）；取本模块
  public 的两个类型。
- **`task-execution/infrastructure/taskExecutionModule.ts`**（新）：HEAD 第 35～43、45～185 与 215～247 行逐字。两个类组装 application 的
  `TaskClaimGate` 与 infrastructure 的 `InMemoryTaskRuntimeRegistry`、`DrizzleTaskOwnershipPersistence`；application 不能取
  infrastructure，engine 不能取具体 DB，按 RFC-294 design §3 只能落 infrastructure（同模块 infrastructure 取 application 已有先例，如
  `inMemoryTaskRuntimeRegistry.ts`）。关停控制器只驱动这个模块，是 application 端口 `TaskExecutionShutdownController` 的实现，同放一处。

### D2 模块根只装配

- digital-employee：转出清单参与者与授权面类型；`const employeeView = createEmployeeDefinitionViewProjection(store)`，其余不变。
- system-operations：`prepareDatabaseProviderForBoot` 保留“托管安装 / 文件库”的二选一，文件库一支改为
  `return await prepareFileDatabaseProviderForBoot(input)`；`composePostgresqlSystemOperations` 在缺省计划之后调
  `requirePostgresqlSchemaPlanForContract(plan, contract)`；暂存还原命令改为
  `releaseArtifactAfterStageRestore(application.commands.stageRestore, deps.artifacts)`。
- task-execution：从新位置取两个类并照旧转出六个名字；进程级单例 `taskExecutionModule`、`createTaskExecutionTestModule` 与
  `createProviderTaskExecutionModule` 留在模块根。顺手把 `infrastructure/childTaskLifecycleParticipant.ts` 对 `ProviderTaskExecutionModule`
  的类型 import 从 `../composition` 改指新位置（infrastructure 不取 composition）。

### D3 锁与账本

- RFC-515 门的例外清单删去这 3 个模块根（30 → 27），后继常量 `ROOTS` 随之删除，清单长度断言随改。
- `rfc328-architecture-guards`：`createWorkerIdentity` 的白名单把模块根换成 `infrastructure/taskExecutionModule.ts`。
- `rfc305-architecture-lock`：identity-access 入口导入清单里 `digital-employee/composition.ts` 那一条换成
  `digital-employee/application/platformInventoryParticipant.ts`（模块根不再取该入口）。
- guard-manifest 登记 RFC-517 用例；改动过的条目行数随改。`counts.json` 不变（F13 不计模块根）。

## 3. 清单（退出门）

| 位置（`packages/backend/src/modules/` 下）                                 | 声明并交出                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `digital-employee/application/platformInventoryParticipant.ts`（新）       | `composeDigitalEmployeePlatformInventoryParticipant`、`DigitalEmployeePlatformInventoryAccess`（另有不导出的 `inventoryText`、`sortInventoryRows`、`DigitalEmployeePlatformInventoryAclRow`） |
| `digital-employee/application/employeeDefinitionView.ts`（新）             | `createEmployeeDefinitionViewProjection`                                                                                                                                                      |
| `system-operations/infrastructure/local/fileDatabaseProviderBoot.ts`（新） | `prepareFileDatabaseProviderForBoot`、`FileDatabaseBootPreparation`、`PreparedFileDatabase`                                                                                                   |
| `system-operations/application/postgresqlSchemaPlanAdmission.ts`（新）     | `requirePostgresqlSchemaPlanForContract`                                                                                                                                                      |
| `system-operations/application/stageRestoreArtifactRelease.ts`（新）       | `releaseArtifactAfterStageRestore`                                                                                                                                                            |
| `task-execution/infrastructure/taskExecutionModule.ts`（新）               | `TaskExecutionModule`、`ProviderTaskExecutionModule`、`ClaimedTaskExecution`、`DEFAULT_OWNERSHIP_LEASE_MS`、`DEFAULT_OWNERSHIP_HEARTBEAT_MS`、`createTaskExecutionShutdownController`         |

允许的形状：三个模块根 `composition.ts` 不再声明这些名字（只转出），没有循环、`try` 与 `throw`。

## 4. 用例

新增 `packages/backend/tests/rfc517-module-root-runtime-logic-out-boundary.test.ts`，登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的位置声明；新文件恰好声明、交出清单列的名字；三个模块根不
  再声明它们。
- ② 三个模块根没有循环、`try`、`throw` 与错误的构造；新名字在生产代码里只被预期的模块根与文件调用；带负对照。
- ③ 六个新文件的依赖面是闭集（import 逐条钉住），application 不取 infrastructure 与 composition，infrastructure 不取 composition；带负对照。
- ④ 行为：清单参与者按语言取文本、按名字与 id 排序、按授权面过滤；员工视图对四种缺失各抛原错误、齐全时给出绑定来源；文件库启动准备在需要时取
  锁、无论成败都释放；schema 计划不符时抛原错误；暂存还原无论成败都释放工件、结果与错误照传；任务执行模块认领失败时退还许可并重抛、暂停与销
  毁缺理由时拒绝；关停控制器无预算时直接中止、有预算时等到期或停完。

## 5. 失败模式

- **走样**：按 HEAD 原行切片生成，用词法单元比对复核。
- **按原文钉住被迁行的锁**：已按原文全仓搜（§1）。
- **门的例外清单**：随本 RFC 删 3 条；陈旧例外会让 RFC-515 门红，所以必须同提交。

## 6. 取舍（可推翻）

1. **任务执行模块落 infrastructure**：两个类同时组装 application 部件与 infrastructure 实现，只有 infrastructure 层合法；注入端口改落
   application 要改类的构造形状与几十个调用方，留待合并两份认领体时一并考虑。
2. **文件库启动准备落 `infrastructure/local/`，二选一留在模块根**：持锁段只是单机 profile 的机制；托管安装与文件库的选择是装配。
3. **两处核对与一个包装落 application**：schema 计划核对与暂存还原后的释放是装配时与命令执行的规则，不是 IO；只取类型。
4. **员工视图用工厂收 store**：投影只依赖 authoring store；工厂形状让函数体逐字保留，模块根里的使用点不变。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是运行期部件与用例，按层落 application 或 infrastructure；模块根只装配与选择。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-517 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读三个模块根与新位置；RFC-515 门覆盖全模块。
- **C13**：计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 模块根收口完成：RFC-515 门的例外清单 30 → 27，模块根全部只装配；顺手去掉 `childTaskLifecycleParticipant.ts` 对模块根的一条类
  型 import。
- **留下**：RFC-370 的 27 个例外文件与 `composition-forbidden-import-files` 的 12 个；两份同形认领体的合
  并；`infrastructure/taskDriverLifecycle.ts` 仍从模块根取进程级单例（随 S12 替换进程级登记表时处理）。
