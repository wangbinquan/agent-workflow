# RFC-428 部署选择项删死槽：启动锁、预打开恢复、节点提示与端口制品四项（RFC-294 S2c）

- **状态**：In Progress（2026-11-02 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你可以
  不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，无用户
  可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2c「部署 profile」余项第 1 项（单机默认值集中、选择项改
  必填、死槽 / 被遮蔽槽 / 可派生槽清理）的第一步
- **前序**：[RFC-394](../RFC-394-typed-deployment-profile/proposal.md) §3 非目标第 1 条；72 项盘点见同目录 [inventory.md](./inventory.md)
- **落位**：`bootstrap/`（选择项类型、键表、启动序列、应用装配）、system-operations composition（启动锁装配）、task-execution composition
  （托管执行选择）。

## 1. 背景

`DeploymentSelections` 有 72 个可选项。按 [inventory.md](./inventory.md)，其中四项在生产里要么从不被设置，要么设置了也永远读不到：

| 选择项                        | 现状                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `startupLease`                | 两个 profile 都不设；`composeDaemonStartupLease` 的 `selected` 分支只有测试走到 |
| `databasePreOpenRecovery`     | 两个 profile 都不设；`startCommand` 里对应的分支从不执行                        |
| `nodeRunPromptContentEffects` | 两个 profile 都不设；托管的节点提示经 `taskRunSelection` 提供                   |
| `portArtifactContentEffects`  | 托管设置，但托管同时设置 `taskRunSelection`，后者优先，这一项从不被读           |

它们让部署选择看起来比实际多出四种可配置面，测试也借它们绕过生产路径。

## 2. 目标

- **G1 删除四项**：`DeploymentSelections` 与键表删去这四项（72 → 68；托管设置的 69 项 → 68 项）。
- **G2 生产行为不变**：
  - 启动锁总是本地原生锁；
  - 未选数据库安装时照旧处理本地待恢复；
  - 本地执行的节点提示与端口制品照旧落在本地文件；
  - 托管的端口制品照旧经 `taskRunSelection`。
- **G3 随之死掉的生产分支一并删除**：`composeDaemonStartupLease` 的 `selected` 参数、`startCommand` 的预打开恢复选择分支、托管执行选择里那个被遮蔽的
  属性。
- **G4 锁住删除**：新增结构锁，这四个名字不得再成为部署选择项。

## 3. 非目标

- 其余七项死槽 / 被遮蔽槽 / 可派生槽：`evidenceDocumentCommands` 与 evidence 一组的 `evidenceRead` / `attemptContext` / `missionInputBlobs`、`historyRestrictions`、
  `resourcePackageSkillContent`、`automationWorkspaceEffects`。它们各自牵动模块内的回落链与较多测试，另立。
- 单机默认值集中、选择项改必填（inventory「后继分步」第 2～4 步）。
- 模块级 API（`composeNodeRunPromptOperations` / `composePortArtifactOperations` 的可选内容参数）：它们被托管装配与大量测试直接使用，保持不变。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`DeploymentSelections` 与 `DEPLOYMENT_SELECTION_KEYS` 不含这四项；`composeDaemonStartupLease` 不再接受被选的锁；`startCommand` 不再读
  预打开恢复选择；托管执行选择不再给出 `portArtifactContentEffects`。结构锁锁定，含负例。
- **AC-2**：启动锁协议用例（获取确认先于启动、失败时等待释放确认、诊断读取失败）改为直接覆盖 `acquireDaemonStartupLease`，断言不变；托管键集合
  用例改为 68 项。
- **AC-3**：既有启动序列、启动锁、节点提示、端口制品、托管任务根与部署 profile 用例，以及 P0 变异 lane 全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **先删这四项**：它们只牵动 bootstrap 与少量测试；其余七项涉及模块内的回落链，分开做更容易逐项核对等价性。
2. **启动锁的协议用例改测应用层函数**：被选锁的协议（确认顺序、释放、诊断）由 `acquireDaemonStartupLease` / `runDaemonStartupWithLease` 实现，
   用假锁直接测它们，覆盖不减；装配函数只剩本地原生锁一条路径。
