# RFC-514 设计：任务执行组合层余下的 try / throw 迁出 composition

## 1. 现状（HEAD，源码实读）

| 文件（`modules/task-execution/composition/` 下） | 内容（HEAD 行）                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `taskEngineApplication.ts`                       | `dynamicWorkflowPorts` 的 fail-closed（195～198）；驱动入口 `driveTaskEngineApplication` 的注释与 `try` / `finally`（277～294） |
| `localTaskRunSelection.ts`                       | `localConfigurationBridge` 的请求登记表（57）、按引用找回请求（62～66）与登记新引用（69～73）                                   |
| `digitalEmployeeExecution.ts`                    | `tasks.cancel`：取消后读回、读不到抛 `task-not-found`（139～142）                                                               |

F13 口径 6 行：`taskEngineApplication.ts` 第 196、197、283、286 行，`localTaskRunSelection.ts` 第 64 行，`digitalEmployeeExecution.ts` 第 141
行。钉着它们的锁：

- `architecture/rfc423-composition-assembly-only`：task-execution 组合层的 throw 账本（三个文件各 1 条）、`driveTaskEngineApplication` 是唯一允许
  的 `try`（`DRIVE_ENTRY`），负对照用 `localTaskRunSelection.ts`。
- `architecture/rfc359-w5-t19b-composition-root-complete`：组合根占位账本里 `taskEngineApplication.ts: marker=1`（那句
  `dynamic-workflow-operations-not-composed`；账本逐字相等，application 不在它的扫描面）。
- `rfc408-port-bindings`：不带动态工作流操作的端口跑 `dw-generate` 抛 `dynamic-workflow-operations-not-composed`（经装配入口对拍，不改）。
- `rfc359-w8-runtime-participants-conformance`：`infrastructure/taskExecutionRuntimeParticipants.ts` 从组合文件取 `driveTaskEngineApplication`
  （名字与位置不变，不改）。

## 2. 机制与落位

### D1 归位

- **`engine/task/driveTaskRun.ts`**（新）：`driveTaskRun({ taskId, executionContext, executionPermits, ports })`，函数体是 HEAD 第 277～294 行
  （注释同迁）；替换只有 `opts.` → `input.` 与 `createTaskRunPorts(opts, topology, runtimeComponents)` → `input.ports()`（端口仍在控制面启动时、
  执行上下文里构造）。取 `./runTask`、本模块 `application/taskExecutionContext` 的 `runWithTaskExecutionContext` 与
  `application/ports` 的类型（engine 取 application 已有先例：`runTask.ts` 等）。
- **`application/dynamicWorkflowOperations.ts`**（新）：`requireDynamicWorkflowOperations(dynamicWorkflow)` 返回交入的操作，缺省时抛原文错误
  （HEAD 第 196～198 行逐字）。
- **`application/taskRunSelection.ts`**（增）：`createTaskRunConfigurationReferences()` 返回 `configurationFor` 与 `requestFor`，请求登记表、
  找回与登记逐字取自 HEAD 第 57、62～66、69～73 行。
- **`application/digitalEmployeeExecution.ts`**（增）：`cancelAndReadTask({ cancel, read }, taskId)`，先取消再读回、读不到抛原文 `NotFoundError`
  （HEAD 第 139～142 行，`composeTaskCancellation(…).cancel` → `steps.cancel`、`getTask(db, …)` → `steps.read`）。

### D2 composition 只装配

- `driveTaskEngineApplication` 名字与签名不变，只把 `taskId`、`executionContext`、`executionPermits` 与按需构造端口的闭包交给 `driveTaskRun`；
  `dynamicWorkflowPorts` 改为 `const dynamicWorkflow = requireDynamicWorkflowOperations(opts.dynamicWorkflow)`。
- `localConfigurationBridge` 从 `createTaskRunConfigurationReferences()` 取 `configurationFor` 与 `requestFor`，内容命名空间与两个运行族的转交
  原样保留。
- `tasks.cancel` 改为 `cancelAndReadTask`：取消步骤仍在每次取消时装配 `composeTaskCancellation(…)`，读回仍是 `getTask(db, …)`。

### D3 锁与账本

- `architecture/counts.json`：`composition-control-flow-task-execution` 17 → 实测（预计 11）。`guard-manifest.json` 登记 RFC-514 用例
  （`assertsAbsence: true`，“不存在”写成 `toEqual([])` 的字面形态）。
- `rfc423-composition-assembly-only`：throw 账本清空、`DRIVE_ENTRY` 的豁免去掉（组合层没有 `try`）；负对照改为“原先在账本里的文件现在记 0”，另增
  一例：驱动入口里再写 `try` 会被报出。
- `rfc359-w5-t19b-composition-root-complete`：删去 `taskEngineApplication.ts: marker=1` 一条，按既有体例写销账说明（同 RFC-506）。

## 3. 清单（退出门）

| 位置（`packages/backend/src/modules/task-execution/` 下） | 声明并交出                             |
| --------------------------------------------------------- | -------------------------------------- |
| `engine/task/driveTaskRun.ts`（新）                       | `driveTaskRun`                         |
| `application/dynamicWorkflowOperations.ts`（新）          | `requireDynamicWorkflowOperations`     |
| `application/taskRunSelection.ts`（增）                   | `createTaskRunConfigurationReferences` |
| `application/digitalEmployeeExecution.ts`（增）           | `cancelAndReadTask`                    |

允许的形状：三个组合文件不再有 `try` / `throw`（task-execution 的 `composition/` 目录整体没有），也不再构造错误。

## 4. 用例

新增 `packages/backend/tests/rfc514-task-execution-composition-try-throw-out-boundary.test.ts`，登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的位置声明；新文件恰好声明、交出清单列的名字。
- ② task-execution `composition/` 目录的每个文件没有 `try` / `throw`、不构造错误；四个名字在生产代码里只被预期的组合文件调用（实参钉住）；带负对照。
- ③ 两个新文件的依赖面是闭集（import 逐条钉住），不用进程全局；带负对照。
- ④ 行为：`driveTaskRun` 带与不带执行上下文都在上下文里（或外）跑控制面，成功、抛错与端口构造抛错时都回收两项登记，端口在控制面启动时才构造；
  三处 fail-closed 的接受与拒绝与原文错误。

## 5. 失败模式

- **走样**：按 HEAD 原行切片生成，用词法单元比对复核。
- **端口构造的时机**：`ports` 是闭包，仍在 `try` 里、执行上下文内构造；构造抛错时仍回收登记。
- **账本**：两个按语料比对的账本（rfc423 的 throw 账本与 try 豁免、t19b 的占位账本）随迁移同步改，已预查。
- **按原文钉住被迁行的锁**（集中验证查出）：`rfc408-task-control-plane` 与 `rfc332-task-engine-contracts` 经 `source()` 一类辅助函数读组合文件原文、钉着 `runTask(createTaskRunPorts(opts, topology, runtimeComponents))` 这一行，按文件路径的预查找不到；`rfc266-task-fanout-pools` 钉着 `finally` 里两句回收的原文；RFC-510 用例钉着 `application/taskRunSelection.ts` 交出的名字与 import。这些锁随迁移改为钉新位置（绑定交出端口闭包、驱动在端口上跑控制面），断言的意图不变。

## 6. 取舍（可推翻）

1. **驱动入口落 engine**：它是任务控制面的驱动（`runTask` 在 `engine/task/`），不是用例；组合文件只交端口。
2. **动态工作流的 fail-closed 单独成文件**：它是条件依赖的守卫，与端口绑定无关；放进 `engine/task/dynamicWorkflowGenerate.ts` 会让引擎认识
   “没装配”这一装配期概念。
3. **配置引用并入 `application/taskRunSelection.ts`**：它实现的是同一个运行选择协议里的配置引用（RFC-510 的核对也在这里）。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是驱动与运行期判断，落 engine 与 application；组合文件只装配与选择。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-514 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读 task-execution 组合层的全部文件与新位置。
- **C13**：`composition-control-flow-task-execution` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 task-execution 的第二步：组合层不再有 `try` / `throw`，`rfc423` 的 throw 账本清空、驱动入口不再是豁免。至此 RFC-370 之外的
  组合层都没有 `try` / `throw`。
- **留下**：模块根的 `composition.ts`（模块生命周期的 `try` / `throw`）不在 F13 与 `rfc423` 的扫描面，由 S10 的全模块门一并裁定；各模块的装配期选择按 S10 的分支上限处理；`crewstation*` / `taskImage*` 待 RFC-370 余项；S10 的全模块门（无循环与 switch、`try` /
  `throw` 只在登记清单内、分支上限写入减速带）另立。
