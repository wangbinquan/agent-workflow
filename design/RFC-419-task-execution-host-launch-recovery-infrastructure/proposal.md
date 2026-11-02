# RFC-419 task-execution 宿主任务启动适配、借用工作区与恢复管理迁入 infrastructure（RFC-294 S6）

- **状态**：Done（2026-11-01 落档并实施；exact SHA `1cd551c10` 主 CI 70/70 与 windows-platform 全绿）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「task-execution `composition/` 只剩装配」
- **前序**：[RFC-418](../RFC-418-task-execution-provider-background-application/proposal.md)；对应 RFC-416 proposal §7 第 5 项中的三块。
- **落位**：task-execution `infrastructure/`（启动适配、借用工作区参与者、恢复管理）、`composition/`（只剩构造与注入）

## 1. 背景

RFC-416 的盘点列出了 composition 里三块 infrastructure 层的实现：

- **宿主任务启动适配**：把 application 端口的窄请求映射为根启动内核（infrastructure 的 `RootTaskLaunchKernel`）的请求。
  - 数字员工 `launchDigitalEmployeeHost`（`composition/digitalEmployeeExecution.ts`，约 50 行）：按主体种类给出 `builtin` 与版本，带上
    internal 事实，有仓库场景时借用工作区。RFC-415 当时把它作为「绑定」留在 composition；按 RFC-294 design 常驻规则 8（composition 只允许
    构造与注入）的口径，这是带分支的请求映射，属于适配器。
  - 动作执行 `launchHostTask`（`composition/actionExecutionEnvironment.ts`，约 30 行）：组装任务选项与合成宿主主体，借用工作区。
- **借用工作区参与者** `borrowedPostgresqlWorkspace`（同文件，约 45 行）：实现 infrastructure 的 `TaskRouteWorkspaceParticipant`，含
  open / committed / rolled-back 状态机与 `admitTransferredWorkspace`。
- **恢复管理** `createRecoveryAdministration`（`composition/taskExecutionPersistence.ts`，约 65 行）：开机孤儿任务的守卫中断及同事务意图终态化、
  节点运行中断、lease 修复、周期空闲中断，全部是持久化层操作。

## 2. 目标

- **G1 启动适配与借用工作区迁入 infrastructure**：三者迁入 `infrastructure/hostTaskLaunch.ts`。`launchDigitalEmployeeHost` 原样迁移，
  `launchHostTask` 的主体成为 `launchActionHostTask(deps, input)`。composition 只把它们绑进端口（`launchHost` / `launchHostTask`）。
- **G2 恢复管理迁入 infrastructure**：`createRecoveryAdministration` 原样迁入 `infrastructure/taskRecoveryAdministration.ts`（改名
  `createTaskRecoveryAdministration`）。`createTaskExecutionPersistence` 只构造与注入。
- **G3 纯结构**：以下全部不变——启动请求的全部字段（主体、`builtin`、版本、internal 事实、借用工作区）、借用工作区的状态机与错误文本、
  恢复管理四个方法的判据 / 时钟 / 事务。

## 3. 非目标

- 根启动内核类型（`RootTaskLaunch*`）的落位。
- composition 里其余的小块（RFC-416 proposal §7 第 5 项的其余部分）与收口锁。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：三块主体位于 infrastructure，composition 不再声明它们（结构锁锁定，含负例）；新的 infrastructure 文件不 import composition
  （`required-ports` 的类型除外，沿用既有先例）。
- **AC-2 行为不变**：以下既有用例与 P0 变异 lane 全部通过，断言意图不变——数字员工执行、动作执行、借用工作区、开机恢复 / 孤儿对账 / 生命周期。
- **AC-3 守卫**：读源码的锁随 owner 改指，各锁判据不变：
  - RFC-319 / RFC-310 / RFC-368 / RFC-370 数字员工锁的语料补入新文件；
  - RFC-415 锁中 `launchDigitalEmployeeHost` 的 owner 改指；
  - 架构报告中 internal 目录可见性的写入点改指。

  新结构锁带负例。

- **AC-4 账本**：guard-manifest 与 Windows paths 按实测更新。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **推翻 RFC-415 §6.1 的落位**：RFC-415 把到 `RootTaskLaunchRequest` 的映射留在 composition 的绑定里。RFC-416 的盘点以常驻规则 8 为口径，
   这类带分支的映射属于适配器，因此迁入 infrastructure；端口 `launchHost` 本身不变。
2. **两个启动适配放在一个文件**：二者都映射到同一个根启动内核，都借用同一种工作区。合在 `hostTaskLaunch.ts`，internal 目录可见性的写入点
   因此从两个文件变为一个。
3. **保留 `borrowedPostgresqlWorkspace` 的名字**：它在测试 helper 与多个用例里被直接使用；本 RFC 只换落位，不改名。
