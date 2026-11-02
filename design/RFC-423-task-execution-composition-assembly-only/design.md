# RFC-423 技术设计

路径缩写：

| 缩写 | 路径                       |
| ---- | -------------------------- |
| `S`  | `packages/backend/src`     |
| `TE` | `S/modules/task-execution` |
| `C`  | `TE/composition`           |
| `T`  | `packages/backend/tests`   |

行号以 RFC-422 落库后的源码（`465fa2087`）为准。

## 1. 文件

| 来源                                                  | 去向                                                                                                                         | composition 留下                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `C/triggerExecution.ts`（触发器参与者、定时任务启动） | `TE/infrastructure/taskExecutionTrigger.ts`                                                                                  | 无（文件删除，`C/providerRuntime.ts` 改从 infrastructure 取用）                                                                        |
| `C/taskRecoverySelection.ts`（恢复选择的三个类型）    | `TE/infrastructure/taskRecoverySelection.ts`                                                                                 | 只再导出 bootstrap 的 `deploymentProfile.ts` 用到的 `TaskRecoveryDeploymentSelection`；`C/providerRuntime.ts` 改从 infrastructure 取用 |
| `C/crewstationRecovery.ts` 的主体                     | `TE/infrastructure/crewstation/hostedRecoverySelection.ts` 的 `createHostedRecoverySelection`                                | `composeCrewStationRecovery` 原样转交（bootstrap 的 import 不变）                                                                      |
| `C/workspacePreparationMaintenance.ts` 的两个主体     | `TE/infrastructure/workspacePreparationGc.ts` 的 `createWorkspacePreparationMaintenance`、`createWorkerWorkspaceMaintenance` | `composeWorkspacePreparationMaintenance`、`createWorkerWorkspaceMaintenanceCommand` 原样转交（RFC-389 按这两个名字计次）               |

主体逐字迁移，只改相对 import。

## 2. 收口锁

`T/architecture/rfc423-composition-assembly-only.test.ts` 以 TypeScript AST 扫描 `TE/composition/` 下全部 `.ts` 文件：

- **循环与分支形态**：不得出现 `for` / `for…of` / `for…in` / `while` / `do…while` / `switch`。
- **`try`**：只允许出现在 `C/taskEngineApplication.ts` 的 `driveTaskEngineApplication`（任务级许可注册项的回收）。
- **`throw`**：含 `throw` 的文件与各自次数是精确账本，为本 RFC 落地后的实测值（多为注入实现完整性检查的 `TypeError`）；增减都要改账本，
  并在注释里写明理由。
- **负例**：在合成单元里写入循环、`switch`、账本外的 `try` / `throw`，各自被报出。

## 3. 必须保持

| 不变量                                                                                  | 现有锁 / 用例                                                                                       |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 定时任务启动：三种载荷的解析与目标、调用人记作 `scheduled`；触发器参与者的启动 / 取消   | `rfc165-scheduled-kinds`、`rfc287-t13-deferred-prep`、Webhook 用例（`webhookTaskExecution` helper） |
| 托管恢复：数据库换代报错、owner 任务、请求人解析、任务状态与续跑、只有执行权持有者消费  | 迁移前没有直接用例（`rfc370-m3-recovery-consumer` 只测下层 consumer）；本 RFC 的端口绑定用例补上    |
| 准备维护：只接管 orphan / scratch 阶段；worker 每个阶段设置受保护任务集合并在结束时清空 | `rfc363-task-preparation-admission`、`rfc414-port-bindings`、RFC-389 维护 worker 根锁               |

## 4. 守卫与账本

- **RFC-328 provider 桥接债**：`integration/application/ports/webhookExecution` 一条改指 `TE/infrastructure/taskExecutionTrigger.ts`。
- **RFC-294 预检**：跨模块边一条、能力 owner 启发式一条（`#createTaskExecutionTriggerParticipant`）改指新文件。
- **RFC-376**：跨模块边一条改指新文件。
- **RFC-305 identity-access 合同消费方账本**：`crewstationRecovery.ts`、`taskRecoverySelection.ts` 两条改指新文件。
- **用例与 helper 的 import**：`rfc165`、`rfc287-t13`、`webhookTaskExecution` 改指新文件；`rfc363`、`rfc414` 仍取 composition 的同名绑定。
- **guard-manifest 与 Windows**：guard-manifest 新增一条；Windows `paths:` 与 suite 补上。

## 5. 测试

- 收口锁本身（含负例）。
- **端口绑定用例** `T/rfc423-port-bindings.test.ts`：
  - 触发器参与者的启动与取消（定时任务三种载荷由 `rfc165-scheduled-kinds` 覆盖）；
  - 托管恢复对换代的数据库报错；在真实数据库（SQLite 与 PostgreSQL）上，未持有执行权时不向平台发任何请求，持有时经业务闭包从
    托管工作区找到 owner 任务、按请求人身份准入并续跑，journal 记为成功（下层 consumer 的各分支由 `rfc370-m3-recovery-consumer` 覆盖）；
  - worker 维护在阶段结束后清空受保护集合（含失败路径）；准备 GC 只接管 orphan / scratch 阶段。
- 搬迁涉及的既有用例只改 import。
