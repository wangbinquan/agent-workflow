# RFC-530 设计：任务执行模块不在 import 期构造

## 1. 现状（HEAD，源码实读）

- `modules/task-execution/composition.ts:40`：`export const taskExecutionModule = new TaskExecutionModule(DAEMON_GENERATION)`。执行模块
  （`infrastructure/taskExecutionModule.ts`）持有可变的认领闸门（`TaskClaimGate`：许可、封存与暂停）与内存驱动登记表
  （`InMemoryTaskRuntimeRegistry`），`dispose()` 一次性封存闸门。`DAEMON_GENERATION` 是 `platform/execution/daemonGeneration.ts` 在加载时生成的
  进程代次。导入 task-execution 组合层的进程都会造一份：daemon、每个 CLI 命令（`main.ts` → `daemonStart.ts` → `daemonSession.ts`）与维护 worker 线程
  ——后两者不用它，构造本身不做 IO、不起计时。
- 生产里真正用单例的只有 SQLite 的执行绑定：`composition/taskExecutionBinding.ts` 的 `composeProcessTaskExecutionBinding(db)` 把它作为绑定的
  `module`，认领走 `taskExecutionModule.claim`。bootstrap 的适配器（`daemonModules/adapters.ts`）在 SQLite 一支交 `execution: () =>
composeProcessTaskExecutionBinding(db)`，PostgreSQL 一支交 `composeSessionTaskExecutionBinding({ daemonGeneration: DAEMON_GENERATION, persistence })`
  ——后者每次构造一份。daemon 的任务执行装配（`daemonModules/taskExecution.ts`）每个会话调一次 `execution(...)`，之后驱动生命周期、活动、停止、后台、
  源终止与会话关停都经注入拿到同一份模块。
- 生产里走不到的读点：
  - `composition/taskCancellation.ts` 的 `composeTaskCancellation`：唯一的生产调用在 `composition/digitalEmployeeExecution.ts` 的
    `composeDatabaseDigitalEmployeeExecutionPorts` 交出的 `tasks.cancel` 里，而它唯一的调用方（`bootstrap/daemonModules/digitalEmployee.ts`）展开之后
    用 `tasks: taskExecution.routes.tasks` 覆盖了 `tasks`——这一支在 daemon 里从不被用到。
  - `infrastructure/sourceTerminationParticipant.ts`：`input.runtimeRegistry ?? taskExecutionModule.runtimeRegistry`，生产总给会话的登记表，回落只服务用例。
  - `infrastructure/taskDriverLifecycle.ts` 的 6 个导出函数（`activeTaskDriverController`、`isTaskDriverActive`、`awaitTaskDriverReleasedSettled`、
    `awaitTaskDriverIdle`、`clearTaskDriverLifecycleForTesting`、`createDatabaseTaskDriverLifecyclePort`）读单例，生产没有调用方（只在注释里出现）；
    `composition.ts` 的 `createTaskExecutionTestModule` 也只有用例调用。
- 锁：`architecture/rfc385-execution-generation-guard` 要求 `composition.ts` 含 `new TaskExecutionModule(DAEMON_GENERATION)`；`rfc388-task-execution-runtime`
  钉 SQLite 的执行模块就是单例、两次装配相同；`rfc359-w8-runtime-participants-conformance` 钉绑定源码含 `taskExecutionModule.claim({ db, intentId })`；
  `rfc517` 钉 `composition.ts` 的导入与转出。用例里直接取单例的 11 个文件、靠源终止回落的 7 处、经测试助手取单例的大量用例（任务执行测试拓扑助手
  被 114 个用例导入）。

## 2. 机制与落位

### D1 绑定时构造

- `composeProcessTaskExecutionBinding({ db, daemonGeneration })` 在绑定时构造 `new TaskExecutionModule(daemonGeneration)`，与 PostgreSQL 的会话绑定一样每次
  一份；bootstrap 的适配器在 SQLite 一支交入 `DAEMON_GENERATION`（与 PostgreSQL 一支同一个值）。
- `composition.ts` 删去单例与 `createTaskExecutionTestModule`，不再在 import 期构造。
- 一个会话里照旧只有一份：任务执行装配每个会话调一次绑定，下游都经注入取用。生命周期由此按会话：会话关停时 `dispose()` 封存的是这个会话的闸门，
  之后同一进程里再开的 SQLite 会话拿到新的模块（此前拿到的是已封存的单例）。

### D2 只服务用例的入口

- `composition.ts` 的 `createTaskExecutionTestModule` 改为生产的构造入口 `createProcessTaskExecutionModule(daemonGeneration)`（SQLite 绑定调它，代次必给）；
  用例要的缺省代次版本在测试助手里。
- 驱动生命周期里读单例的 5 个导出函数移进测试助手（函数体原样，取测试助手自己的执行模块）；生产的 `clearTaskDriverLifecycleForTesting` 只清心跳
  （心跳 `Map` 属 S12 第 4 项，照旧），测试助手的同名函数另清测试模块的登记表。
- `composeDatabaseDigitalEmployeeExecutionPorts` 删去被覆盖的 `tasks` 与只为它存在的三个参数，`composeTaskCancellation` 随之删去；函数体原样移进
  测试助手，另给依赖此前 `tasks` 缺省的用例一份同样的组合。
- 源终止参与者的 `runtimeRegistry` 必填，删去回落到单例（daemon 集成装配的同名字段随之去掉多余的 `NonNullable`）。

### D3 用例与锁

- 测试助手持有一份测试用的执行模块（用例照旧按文件在 `afterEach` 里重置）与一份建在它上面的 SQLite 执行绑定：直接组合运行期的测试助手驱动与观察
  同一份模块，与此前用单例时相同；组合真实 daemon 的用例改取会话自己的执行模块（`application.taskExecution.selected.executionModule`），把测试助手里的
  取消组合用在已装配会话上的用例显式交入会话的登记表（缺省是测试模块的）。直接取单例的用例改取测试助手的；靠源终止回落的用例显式给登记表。
- 锁随改：rfc385 改钉绑定按交入的代次构造、bootstrap 两支交同一个 `DAEMON_GENERATION`；rfc388 改钉 SQLite 每次装配一份（与 PostgreSQL 一致）、同一装配里
  下游共用；rfc359-w8 改钉绑定经自己的模块认领；rfc526 的三处随删去的参数与文件改。
- 新增 `packages/backend/tests/rfc530-task-execution-module-construction-boundary.test.ts`，登记 guard-manifest：生产代码里没有模块级的
  `new TaskExecutionModule(`（只在函数体里）；task-execution 组合层不导出执行模块；删去与移走的名字不在生产代码里；SQLite 绑定每次构造、两次绑定
  的模块不同；带负对照。

## 3. 清单（退出门）

| 名字                                                                                            | 之后                                                                                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `taskExecutionModule`（import 期单例）                                                          | 删去                                                                                      |
| `createTaskExecutionTestModule`                                                                 | 改为生产的构造入口 `createProcessTaskExecutionModule`（代次必给）；缺省代次版本在测试助手 |
| 驱动生命周期里读单例的 5 个导出函数                                                             | 移进测试助手                                                                              |
| `composeTaskCancellation`、`composeDatabaseDigitalEmployeeExecutionPorts` 的 `tasks` 与三个参数 | 删去（函数体移进测试助手）                                                                |
| 源终止参与者的 `runtimeRegistry`                                                                | 必填                                                                                      |
| `composeProcessTaskExecutionBinding`                                                            | 入参加 `daemonGeneration`                                                                 |

## 4. 用例

- ① 门（D3）；② 行为：SQLite 绑定按交入的代次构造、每次一份，认领经该份模块；关停一个会话（`dispose()`）只封存它自己的模块，之后的绑定拿到
  未封存的闸门（单例缺陷的回归用例：此前第二次绑定拿到的是已封存的同一份）；③ 既有用例覆盖认领、驱动、停止、后台与源终止（经测试助手）。

## 5. 失败模式

- **同一会话里出现两份模块**：任务执行装配每个会话只调一次绑定，下游经注入；用例钉住同一装配里下游共用。
- **用例之间串状态**：测试助手的执行模块照旧按文件重置。
- **漏改读单例的用例**：`tsc` 列出全部导入点；按被改文件在 `src/` 里的调用方再选用例（`docs/dev-gotchas.md` RFC-527 的第二条教训）。

## 6. 取舍（可推翻）

1. **执行模块按会话构造，而不是 bootstrap 每进程造一份再交给每个会话**：PostgreSQL 一直按会话；会话关停会封存闸门，按会话构造让后开的会话拿到干净的
   模块；design §10.2 的“每进程一次”针对模块工厂图，执行模块是会话的运行期状态。
2. **删去被覆盖的 `tasks` 与任务取消组合，而不是保留**：删除优于留着一支生产走不到的实现。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层不在 import 期构造。**C11**：public 不变。**C12**：RFC-530 用例覆盖全部生产代码。**C13**：计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 3 项：`taskExecutionModule` 不在 import 期构造，由工厂图（每个会话的执行绑定）构造并注入。
- **留下**：驱动生命周期的心跳 `Map` 与其余模块级可变单例（S12 第 4 项）；S12 第 6 项。
