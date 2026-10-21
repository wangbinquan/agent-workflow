# RFC-386 设计：任务驱动协调器工厂

研究基线 HEAD `9382675a0`（行号以实施时源码为准）。`T:` = `services/task.ts`，`B:` = `cli/daemonModules/taskExecution.ts`，
`A:` = `cli/daemonModules/adapters.ts`，`TE/` = `modules/task-execution/`，`T/` = `packages/backend/tests/`；其余路径相对
`packages/backend/src/`。

## 1. 现状

### 1.1 会话协调器（RFC-382）

B:341-405 每会话一个：每次提交实时 `runConfiguration()`（B:214-232：appHome、configPath、执行世代、实时子 Agent 捕获、克隆超时与基线窗口、
`runtimeConfigOpts` 含提炼观察者）；生命周期来自适配器（A:93-101 / A:177-189）；门控续跑前置步骤带真实提炼入队器（B:346-350）；延后仓库
准备读实时设置（B:351-363）；引擎异常进失败上报（任务 `failed`、`task drive failed`，意图以 `task-drive-failed` 按 `claimedOwnerEpoch`
终结，B:376-404）；`ensureWorkspaceProfiles` 为 false。

### 1.2 本 RFC 处理的每次调用协调器

| # | 位置 | 运行配置 | 其余差异 |
| --- | --- | --- | --- |
| C11 子任务启动 | `TE/infrastructure/childExecutionLaunchOperations.ts:380-425`（提交在 :746-750），两个 provider | 父任务可继承键快照（`nodeMechanics.ts:1992-1998`，键表 `taskExecutionTopology.ts:95-116`）：无提炼、无提交推送 / 合并 Agent 设置 | 会话生命周期；引擎为请求带来的 `schedulerDriver`；失败摘要 `child task launch failed`、原因 `postgresql-child-launch` |
| C12 续跑 | `TE/infrastructure/childTaskLifecycleParticipant.ts:1129-1191`，两个 provider，所有根续跑（`providerRuntime.ts` 的路由、自动续跑、生命周期修复、托管恢复）与子任务续跑（`nodeMechanics.ts:1669`） | 根续跑取会话实时配置（B:285），子任务续跑取父快照 | 带续跑回滚的前置步骤（唯一真正按次不同）；`ensureWorkspaceProfiles: true`（:1130-1133）；失败摘要 `task resume failed`；无门控前置（对非门控意图本就是空操作，`gateContinuationPreDrivePersistence.ts:44-49`） |

C7（融合启动）、C8（人工门唤醒，`T:3131-3194`，强制 `ensureWorkspaceProfiles`）、C10（仓库准备重试）、C13（PostgreSQL 融合）不在本 RFC。

### 1.3 门控续跑的排除配置重建

SQLite 的人工门续跑走 C8 并强制重建（`T:3139` → `:1290`、`:1347`）；PostgreSQL 的门控续跑走会话协调器（`gateContinuationDriver.ts:12-24`），
不重建（B:214-232、`taskDriveTypes.ts:30-35`）。RFC-308 要求续跑与续写重新确认排除配置（`design/RFC-308-unified-task-git-commit-exclusions/design.md:240`、`:725`）。

## 2. 设计

### 2.1 工厂与画像（取舍 1、4）

`TE/application/drive/taskDriveCoordinatorFactory.ts`：

```ts
interface TaskDriveProfile {
  runConfig?: { kind: 'inherit-parent'; parent: InheritableRunConfig }
  admittedContinuation?: AdmittedContinuationStep
  failure?: { errorSummary: string; failureCode: string; reason: string }
  engine?: SchedulerDriverPort
}
interface TaskDriveCoordinatorFactory {
  readonly session: TaskDriveCoordinator
  coordinatorFor(profile: TaskDriveProfile): TaskDriveCoordinator
}
createTaskDriveCoordinatorFactory({
  runConfiguration, lifecycle, gateContinuationPreDrive, repositoryPreparation,
  engine: () => SchedulerDriverPort, failures, log,
}): TaskDriveCoordinatorFactory
```

- 不给 `runConfig` 即实时会话配置；`inherit-parent` = 实时会话配置之上叠加父任务的可继承键（父值覆盖会话值）。
- 失败上报只有一个，按画像取摘要 / 失败码 / 原因名，**总是**带 `claimedOwnerEpoch` 终结；缺省画像即会话现行的
  `task drive failed` / `task-drive-failed` / `task-drive`。
- 工厂是后端唯一的 `new DefaultTaskDriveCoordinator(`（RFC-387 删除的 `createTaskDriveCoordinator` 除外）。

### 2.2 子任务启动与续跑（取舍 2）

- C11 → `coordinatorFor({ runConfig: { kind: 'inherit-parent', parent }, failure: CHILD_LAUNCH, engine: request.schedulerDriver })`，原因名改为
  中立的 `child-launch`。
- C12 → 根续跑 `coordinatorFor({ admittedContinuation: rollback, failure: TASK_RESUME, engine: topology })`；子任务续跑再加
  `runConfig: { kind: 'inherit-parent', parent }`。
- 工厂由会话组合构造一次，经 provider 运行时交给子任务启动与生命周期参与者；两个 provider 运行时函数仍分开（合一属 RFC-388）。
- RFC-284 T20 的处置表与说明随之更新：提交推送 / 合并 Agent 设置与提炼由会话配置提供，不经可继承键下传（避免「设置改了但在跑链
  未变」）。

### 2.3 按意图类型重建排除配置（取舍 3）

认领结果带出执行意图类型，进入 `TaskDriveContext`；`TE/domain` 的执行意图模块给出纯函数：续跑、重试节点、同步工作流、门控续跑、
恢复类意图 → 重建；启动、仓库准备重试 → 不重建。协调器据此设置 `ensureWorkspaceProfiles`，删除 C12 等调用点的标志（C8 留到
RFC-387）。

### 2.4 装配

`cli/daemonModules/taskExecution.ts` 在持久化与执行模块之后、provider 运行时之前构造工厂（引擎以惰性回边取 provider 运行时的
`schedulerDriver`）；`session` 即现在的会话协调器（`B.coordinator` 输出不变）。适配器表不变。

## 3. 失败模式

- 子任务启动 / 续跑的引擎异常：经统一上报，任务 `failed`，只终结认领世代的意图；启动前的失败（未认领）沿用现有路径。
- 画像的 `runConfig` 读取失败：同会话协调器（`contextFor` 失败即上报并释放）。

## 4. 与 RFC-294 目标架构的对齐

工厂位于 task-execution `application/drive`，重建规则位于 `domain`，装配在 bootstrap 层（暂居 `cli/daemonModules/`）。本 RFC 把每次调用的
协调器收敛到一个应用层工厂，向「`createTaskDriveCoordinator` 无生产调用方」（RFC-294 出口判据）推进一大步；剩余调用方由 RFC-387 清理。

## 5. 测试策略

1. 工厂（双引擎）：`session` 与 `coordinatorFor` 共用生命周期、门控前置、延后准备与上报；`inherit-parent` 的优先级（父键覆盖会话值）。
2. 子任务配置（双引擎，含「旧接线」对照）：调用节点产生的子任务读取设置页的提交推送 / 合并 Agent 设置并挂上提炼观察者；对照显示
   旧接线为缺省值、无观察者。
3. 门控续跑重建（双引擎，含对照）：评审打回 / 澄清回答之后的续跑重建排除配置；对照显示旧 PostgreSQL 接线不重建。
4. 失败上报（双引擎）：子任务启动与续跑失败只终结认领世代的意图，原因名中立。
5. 结构锁：工厂外无 `new DefaultTaskDriveCoordinator(`（`createTaskDriveCoordinator` 豁免到 RFC-387）；子任务启动与生命周期参与者不再自建协调器。
6. 旧锁（改指，不放宽）：`T/rfc332-task-engine-contracts.test.ts:85-95`、`:168-184`；`T/rfc103-launch-config-passthrough.test.ts:240-255`；
   `T/scheduler-subagent-live-capture-passthrough.test.ts:54-80`；`T/rfc319-cfg45-default-runtime-hot-read.test.ts`；
   `T/rfc359-w5hn-drive-coordinator-runtime-config.test.ts:17-20`；`T/architecture/rfc380-daemon-module-bundles.test.ts`；
   `T/rfc284-t20-child-inheritance.test.ts`；`T/architecture/rfc359-w7-task-insert-lineage-completeness.test.ts:61-88`（按行号的锁，
   行号会移动）；`T/rfc382-gate-continuation-bundle.test.ts`。账本：`architecture/commons-debt.json`、`architecture/guard-manifest.json`、
   `BOOTSTRAP_FILES`（若新增 bootstrap 文件）；`architecture/counts.json` 不升。
