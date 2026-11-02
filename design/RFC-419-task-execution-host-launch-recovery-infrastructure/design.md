# RFC-419 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`DEE` = `TE/composition/digitalEmployeeExecution.ts`，
`AEE` = `TE/composition/actionExecutionEnvironment.ts`，`TEP` = `TE/composition/taskExecutionPersistence.ts`。行号以 RFC-418 落库后的源码（`c91c711ac`）为准。

## 1. 文件

| 来源                                                 | 去向                                                                                    | 说明                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `AEE` 的 `borrowedPostgresqlWorkspace`               | `TE/infrastructure/hostTaskLaunch.ts`                                                   | 原样迁移                                                                                                   |
| `AEE` 的 `launchHostTask` 主体                       | `TE/infrastructure/hostTaskLaunch.ts` 的 `launchActionHostTask(deps, input)`            | 原样迁移；`deps` = `{ resolveActor, resourceAuthorityFor, launch }`                                        |
| `DEE` 的 `launchDigitalEmployeeHost`                 | `TE/infrastructure/hostTaskLaunch.ts`                                                   | 原样迁移；`deps` 类型改为同文件的 `HostTaskLaunchDependencies`（原为 composition 依赖接口的 `Pick`，同形） |
| `TEP` 的 `createRecoveryAdministration` 及其文档注释 | `TE/infrastructure/taskRecoveryAdministration.ts` 的 `createTaskRecoveryAdministration` | 原样迁移，改名                                                                                             |

迁移后：

- `AEE` 的环境绑定为 `launchHostTask: (input) => launchActionHostTask(deps, input)`；
- `DEE` 的端口绑定为 `launchHost: (request) => launchDigitalEmployeeHost(deps, request)`；
- `TEP` 调用 `createTaskRecoveryAdministration(db, runtimeLifecycle, humanGates)`。

各用例与测试 helper 对 `borrowedPostgresqlWorkspace` / `launchDigitalEmployeeHost` 的 import 改指 infrastructure。

## 2. 依赖规则

- `TE/infrastructure/hostTaskLaunch.ts` 与 `taskRecoveryAdministration.ts` 不 import composition。唯一例外是 `taskRecoveryAdministration.ts` 对
  `composition/required-ports` 的类型 import（`TaskRecoveryHumanGateFactsPort`），沿用 `taskRecoveryOperations.ts` 的既有先例。
- `AEE` / `DEE` / `TEP` 不再含：
  - 启动请求的组装（`catalogVisibility: 'internal'`、`invoker: { type: 'user'`）；
  - 借用工作区的状态机（`borrowed-workspace-already-`）；
  - 恢复管理的方法体（`interruptBootOrphanTask`、`reapOrphanRuns`）。

## 3. 必须保持

| 不变量                                                                                         | 现有锁 / 用例                                                  |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 数字员工启动：两种主体的 `builtin` / 版本、internal 事实、仓库场景的借用工作区与输入挂载       | `rfc415-port-bindings`、RFC-319 / RFC-310 源码锁、数字员工用例 |
| 动作启动：任务名、输入、`maxDurationMs`、合成宿主主体、`platformInputPaths`、借用工作区        | `rfc359-t3`、`rfc382` 用例                                     |
| 借用工作区：准备字段、`admit` 参数、commit / rollback 的状态机与错误文本                       | `rfc359-t3`、`eachProviderTaskExecution` helper 驱动的用例     |
| 恢复管理：守卫中断与同事务终态化、节点中断失败返回 false、lease 修复、周期空闲中断的判据与时钟 | RFC-359 AC-10 用例、孤儿对账 / 开机恢复 / 生命周期用例         |

## 4. 守卫与账本

- RFC-319（两处语料）、RFC-310 两个锁、RFC-368、RFC-370 V4：读 `DEE` 的语料补入 `TE/infrastructure/hostTaskLaunch.ts`。
- RFC-415 锁：`launchDigitalEmployeeHost` 的 owner 改为新文件。
- `T/architecture/architectureReport.ts` 的 `INTERNAL_CATALOG_VISIBILITY_WRITERS`：`AEE` 与 `DEE` 两条合为新文件一条。
- guard-manifest 新增一条；Windows `paths:` 与 suite 补上。

## 5. 测试

- **新增结构锁** `T/architecture/rfc419-host-launch-recovery-infrastructure.test.ts`，各项都带负例：
  - 被迁符号的 owner 唯一；
  - `AEE` / `DEE` / `TEP` 不含 §2 的记号；
  - 新文件不 import composition（`required-ports` 类型除外）。
- **端口绑定用例** `T/rfc419-port-bindings.test.ts`：
  - 动作启动的请求映射（`wallTimeMs` 为空 / 非空、输入拷贝、合成宿主、借用工作区）；
  - 环境绑定的 `launchHostTask` 返回启动 ID；
  - 借用工作区的状态机（重复 commit / rollback 报错）。
- 搬迁涉及的既有用例只改 import 与源码锚点。
