# RFC-514 任务执行组合层余下的 try / throw 迁出 composition（RFC-294 S10 第二十一步）

- **状态**：Done（2026-11-19，落地 `6be6ac4e3`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推进RFC294」：本会话按
  2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。
  设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）。
- **前序**：[RFC-513](../RFC-513-code-history-and-package-recovery-throws-out-of-composition/proposal.md)（S10 第二十步）：RFC-370 之外的组合层
  `throw` 只剩 task-execution 的三处。本 RFC 把它们连同驱动入口的 `try` / `finally` 迁出 task-execution 的 `composition/`；三个组合文件的装配
  入口与导出的名字、签名与位置不变；不碰 `crewstation*`（RFC-370 余项）。

## 1. 背景

S10 的门要求组合层的 `try` / `throw` 只在登记清单内、例外清单最终为空。`architecture/rfc423-composition-assembly-only` 的 throw 账本记着
task-execution 组合层仅剩的三个 `throw`，它们与驱动入口的 `try` 都是运行期的用例逻辑，不是装配：

- `taskEngineApplication.ts`：驱动入口 `driveTaskEngineApplication` 在执行上下文里（或不带上下文）跑任务控制面，并在 `finally` 里回收该任务的
  写锁与扇出池登记；`dynamicWorkflowPorts` 在选了动态工作流生成引擎、却没有交入它的操作时 fail-closed 抛
  `dynamic-workflow-operations-not-composed`；
- `localTaskRunSelection.ts`：单机的配置引用桥按不透明引用找回驱动请求，找不到抛 `local-task-run-configuration-unavailable`；
- `digitalEmployeeExecution.ts`：数字员工执行的 `tasks.cancel` 取消任务后再读回，读不到抛 `task-not-found`。

## 2. 目标

- **G1 归位**（判据、错误与次序逐字不变）：驱动入口的 `try` / `finally` 与执行上下文选择迁入新的 `engine/task/driveTaskRun.ts`
  （`driveTaskRun`）；动态工作流操作的 fail-closed 迁入新的 `application/dynamicWorkflowOperations.ts`
  （`requireDynamicWorkflowOperations`）；配置引用的登记与找回并入既有的 `application/taskRunSelection.ts`
  （`createTaskRunConfigurationReferences`）；取消后读回并入既有的 `application/digitalEmployeeExecution.ts`（`cancelAndReadTask`）。
- **G2 composition 只装配**：三个组合文件改为调用新位置；task-execution 组合层控制流 17 → 11（按实测），`composition/` 目录不再有 `try` / `throw`（模块根的 `composition.ts` 不在此列，见 design §8）。
- **G3 账本与锁**：`composition-control-flow-task-execution` 收紧到实测；`rfc423-composition-assembly-only` 的 throw 账本清空；
  `rfc359-w5-t19b-composition-root-complete` 里 `taskEngineApplication.ts` 的一条 `not-composed` 记录随 fail-closed 迁走销账；新增 RFC-514 用例。

## 3. 非目标

- task-execution 组合层其余的装配期选择与端口绑定（`createTaskRunPorts`、`prepareTaskDrive` 的装配、准入的空值分支等）；`crewstation*`（RFC-370
  余项）；其余模块。
- 改写任何判据、错误类型与错误串；任何行为变化、接口与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的位置声明；三个组合文件不再有 `try` / `throw`，装配入口与导出的名字、签名不变。
- **AC-2**：同样输入下，驱动仍在（或不在）执行上下文里跑控制面、无论成败都回收两项登记；三处 fail-closed 接受与拒绝相同的输入、抛出相同的错误；
  次序与时机不变。
- **AC-3**：新位置的依赖面是闭集（engine 只取 engine 与本模块 application 的上下文与端口类型；application 只取本模块的端口与 `@/util/errors`），
  不用进程全局；public surface 不升；`composition-control-flow-task-execution` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
