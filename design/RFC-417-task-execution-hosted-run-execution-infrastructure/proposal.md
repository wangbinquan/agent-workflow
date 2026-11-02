# RFC-417 task-execution 托管任务运行范围与执行 owner 逻辑迁入 infrastructure/crewstation（RFC-294 S6）

- **状态**：Done（2026-11-01 落档并实施；exact SHA `ffde0e5f6` 主 CI 70/70 与 windows-platform 全绿）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「task-execution `composition/` 只剩装配」
- **前序**：[RFC-416](../RFC-416-task-execution-hosted-agent-invocation-infrastructure/proposal.md)（其 proposal §7 后继顺序第 1 项）
- **落位**：task-execution `infrastructure/crewstation/`（托管 provider 适配器）、`application/`（provider 中立的任务材料准备）、`composition/`
  （只剩构造与注入）

## 1. 背景

RFC-416 把托管 agent 调用准备与 MCP 诊断会话迁出 composition 之后，托管侧还有两个 composition 文件带着适配器逻辑。

`composition/crewstationTaskRunSelection.ts`（209 行）有两块：

- 每个 agent 节点运行的托管范围：运行目录 `/work/runs/<task>/<nodeRun>`、经工作区 helper 写种子文件、git 控制面观测与输出校验的 helper 调用、
  调用 ID、技能暂存规则（项目技能不暂存，托管技能必须带版本，按 `<name>/<path>` 读出）、材料选择与托管诊断；
- 托管材料引用：`hosted-skill:` / `project-skill:` 引用，插件 `file://` 前缀剥除。

`composition/crewstationExecution.ts`（297 行）里有这些逻辑：

- 逻辑子执行的物理工作区 owner 判定；
- 按 owner 改写的工作区 helper；
- 平台能力的 30 秒缓存与并发去重，以及按 profile 判定能力版本；
- 托管恢复证明（由执行权租约铸成；按 RFC-328 只能经 composition 铸造，留在原处，见 §6.3）；
- 工作区命令对账循环（60 秒间隔，失败只记日志）；
- Intent scratch 的释放（先确认执行已结算，再经 helper 释放）。

另外，`composition/taskAgentMaterialPreparation.ts`（116 行）是 provider 中立的任务材料准备，本地与托管 run family 共用，只有类型 import。

## 2. 目标

- **G1 托管运行范围迁入 infrastructure**：运行范围迁入 `infrastructure/crewstation/taskAgentRunScope.ts`，材料引用迁入
  `taskMaterialReferences.ts`。`composeCrewStationTaskRunSelection` 只剩装配：确保物理工作区，交出运行范围。
- **G2 执行 owner 中的逻辑迁入 infrastructure**：
  - 工作区 owner 判定与 owner 改写的 helper → `executionWorkspaces.ts`；
  - 能力缓存与能力判定 → `hostedCapabilities.ts`；
  - 命令对账循环 → `workspaceCommandReconciliation.ts`；
  - Intent scratch 释放 → `intentScratchRelease.ts`。

  `composeCrewStationExecutionOwner` 与 `composeCrewStationIntentScratchRelease` 只剩构造与注入。

- **G3 任务材料准备迁入 application**：`createTaskAgentMaterialPreparation` 迁入 `application/taskAgentMaterialPreparation.ts`，资源与诊断两个
  接口并入 `application/ports/taskAgentMaterial.ts`，composition 文件删除。
- **G4 纯结构**：以下全部不变——路径、helper 操作名与参数、`operationId`、错误文本、缓存窗口与去重、能力判据、证明字段、对账间隔与日志、
  释放顺序。

## 3. 非目标

- 本地 agent 调用适配器与本地 run family、托管系统代理 / 冒烟 run family 的调用打开逻辑（RFC-416 proposal §7 第 2 项）。
- 把命令对账循环接入唯一生命周期程序（RFC-294 design §14「后台作业无私设 timer」）：本 RFC 只换落位，循环形状不变。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：上述主体位于 infrastructure / application，composition 不再声明它们；`taskAgentMaterialPreparation.ts` 删除（结构锁锁定，
  含负例）。新的 infrastructure 文件不 import composition；新的 application 文件不 import infrastructure / composition。
- **AC-2 行为不变**：以下既有用例与 P0 变异 lane 全部通过，断言意图不变——托管 agent 材料、继承工作区、任务启动清单、任务 agent 材料准备、
  任务 agent 选择、托管执行与恢复。
- **AC-3 守卫**：按旧路径取语料的锁随 owner 改指（RFC-414 工作区读锚点）；新结构锁带负例。
- **AC-4 账本**：guard-manifest 与 Windows paths 按实测更新。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **任务材料准备归 application，托管运行范围直接调用它**：`createTaskAgentMaterialPreparation` 只组合端口对象，不做 I/O，provider 中立。
   托管运行范围（infrastructure）调用这个 application 构造器，与 RFC-416 保留 effect 协调器调用同理（已有先例），不另设注入。
2. **Intent scratch 释放把执行实例交给绑定构造**：infrastructure 的释放逻辑接收 `executions.workspaceSettled`；store 与托管执行的构造（含
   `workspaceTaskId` 的映射）留在 composition。这样逻辑可以单测，composition 仍只是构造。
3. **恢复证明留在 composition（集中验证中由 RFC-328 守卫发现）**：RFC-328 的 `FACTORY_ALLOWLIST` 只允许 `composition/bootRecovery.ts`
   铸造 `ExclusiveDaemonLockProof`。最初设计把证明闭包迁入 infrastructure 并直接调用 domain 构造，`rfc328-architecture-guards` 当即拒绝。
   因此 `CXE` 保留原闭包：把 boot recovery 的 `proof` 端口绑到唯一授权的铸造点 `createDaemonRecoveryAuthorityProof`，属于装配。
4. **改名随落位**：infrastructure 里不用 `compose*` 前缀。`createCrewStationExecutionWorkspaces` 改为 `createHostedExecutionWorkspaces`，
   `composeHostedTaskMaterialReferences` 改为 `createHostedTaskMaterialReferences`；bootstrap 消费的 `composeCrewStationExecutionOwner` /
   `composeCrewStationIntentScratchRelease` 名字不变。
