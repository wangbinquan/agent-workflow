# RFC-416 task-execution 托管 agent 调用适配器与 MCP 诊断会话迁入 infrastructure/crewstation（RFC-294 S6）

- **状态**：Done（2026-11-01 落档并实施；exact SHA `80b715e95` 主 CI 70/70 与 windows-platform 全绿）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「task-execution `composition/` 只剩装配」；
  review-2026-10-16 F10「执行适配器带逻辑地放在 composition」
- **前序**：[RFC-415](../RFC-415-task-execution-digital-employee-action-application/proposal.md)
- **落位**：task-execution `infrastructure/crewstation/`（托管 provider 适配器）、`composition/`（只把 application 的系统代理核心与托管会话接在一起）

## 1. 背景

RFC-415 之后，本会话于 2026-11-01 盘点了 task-execution `composition/` 的全部 108 个文件（9,197 行）。其中约 11 个文件各含 40 行以上的应用 / 适配器
逻辑，另有少量小块（后继顺序见 §7）。RFC-294 review F10 点名的是托管（CrewStation）provider 的 agent 调用适配器：

- **`composition/crewstationAgentInvocation.ts`（525 行）**：托管 agent 调用准备。
  - 选择与门控：按协议和模型选择托管 profile；native 配置不可用时，阻断 MCP、插件、子代理、权限、frontmatter、运行参数与模型选项。
  - 材料：编译托管 native 材料；技能文件经对象存储暂存，或以 UTF-8 内联；上传材料并检查 1 MiB 上限。
  - 声明与上下文：生成声明清单，冻结托管启动上下文，提供协议与事件解析。
  - 执行：执行时用进程 effect 包住整个过程（beforeSpawn → 启动回执 → settle），托管执行走 run / adopt。
  - 事件下沉：stderr 诊断、usage token 增量、结果终态。
  - 结果映射：超时、取消、脱离与未知结果。
- **`composition/crewstationMcpDiagnosticRunner.ts`（183 行）**：托管 MCP 诊断会话。
  - 会话的任务、执行与目录命名。
  - 工作区存在探测（`api.listFiles`）、清理、执行是否存在。
  - 恢复判定：平台子任务的 attempt 与终态一致时，才 adopt 并结算。
  - 托管工作区（`system-workspace` 准备）与编译。

两者都直接调用 CrewStation 平台 API、托管执行与工作区 helper：它们是 provider 适配器，不是装配。

## 2. 目标

- **G1 托管 agent 调用准备迁入 infrastructure**：原样迁入 `infrastructure/crewstation/agentInvocationPreparation.ts`。composition 的
  `crewstationAgentInvocation.ts` 删除；四个托管 run family 与相关用例改从 infrastructure 取用。
- **G2 托管 MCP 诊断会话迁入 infrastructure**：命名约定、工作区探测、清理、恢复判定、托管工作区与编译，迁入
  `infrastructure/crewstation/mcpDiagnosticSessions.ts`。composition 的 `crewstationMcpDiagnosticRunner.ts` 只负责把 application 的系统代理
  核心（`runSystemAgentCore`）与会话交出的调用接在一起。对外形状不变：bootstrap 与 resource-catalog 的消费方不改。
- **G3 纯结构**：以下全部不变——能力门与错误文本、材料与声明、上传请求键、执行请求与事件下沉、结果映射、恢复判定、工作区路径与 helper 调用。

## 3. 非目标

- 本地（native）agent 调用适配器 `agentInvocation.ts` 与本地 run family：它们引用 runtime-management 的 infrastructure 内部实现，需先补
  runtime-management 的 public 合同，另立 RFC。
- 以下托管部分留给后继 RFC：
  - 托管系统代理 / 冒烟 run family 打开调用的逻辑（与 runtime-management composition 交织）；
  - 托管任务运行选择 `crewstationTaskRunSelection.ts`；
  - 托管执行 owner 装配 `crewstationExecution.ts` 中的逻辑。
- RFC-370 v2 的语义执行端口（review F10 的另一项）。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：两块主体位于 `infrastructure/crewstation/`，composition 不再声明它们，`crewstationAgentInvocation.ts` 已删除（结构锁锁定，
  含负例）。新的 infrastructure 文件不 import composition；MCP 会话不调用 application 的系统代理核心。
- **AC-2 行为不变**：以下既有用例与 P0 变异 lane 全部通过，断言意图不变——托管 agent 材料、调用生命周期、系统代理、MCP 诊断与运行时管理。
- **AC-3 守卫**：按旧路径取语料的锁随 owner 改指（RFC-328 effect 括号锁、RFC-328 执行账本中的托管进程判定）；新结构锁带负例。
- **AC-4 账本**：guard-manifest 与 Windows paths 按实测更新。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **落位 infrastructure 而非 application**：两块逻辑的每一步都是 CrewStation 平台语义——profile 映射、能力版本、材料与上传、托管执行
   run / adopt、平台子任务 attempt——属于 provider 适配器。本地对应物同理，另立 RFC。
2. **legacy 依赖照旧**：托管调用准备用到 `@/services/runtime` 的 driver 能力与 `@/services/execution/agentInjection` 的声明 helper。RFC-317 R2
   只围 application / domain / engine / public 四层，infrastructure 引用 legacy 不增加 R2 边（同目录的 `nativeMaterial.ts` 已有先例），因此原样
   保留，待这两个 legacy 文件归位时再改。
3. **偏离项：进程 effect 协调器仍由适配器调用**。`execute` 内由 `createProcessEffectAttemptObserver`（application）包住 run / adopt，这是
   RFC-328 effect 括号锁锁定的形状。infrastructure 调用本模块 application 协调器已有先例（`executionKernelBinding.ts`、
   `nodeRollbackPersistence.ts`）。不改成注入，以免改动括号锁与执行账本的判据。
4. **MCP 诊断的用例调用留在绑定**：`runSystemAgentCore` 是 application 用例，infrastructure 不调用它。会话只交出 `SystemAgentCoreInvocation`，
   由绑定组装运行参数并调用核心。
5. **不保留 composition 再导出**：composition 可以直接 import infrastructure，因此删除 `crewstationAgentInvocation.ts`，改写四个 run family 的
   import（删除优于 deprecate）。

## 7. 后继顺序（2026-11-01 盘点结论，各自另立 RFC）

1. **托管任务运行选择与执行 owner 中的逻辑**：`crewstationTaskRunSelection.ts`（托管运行范围、helper 观测与输出校验、技能暂存）与
   `crewstationExecution.ts`（执行工作区 owner、能力缓存、恢复证明、命令对账循环、Intent scratch 释放）迁入 `infrastructure/crewstation/`。
2. **本地 agent 调用适配器与本地 run family**：`agentInvocation.ts`、`localSystemAgentRunFamily.ts`、`localTaskAgentRunFamily.ts`、
   `localRuntimeSmokeRunFamily.ts`，连同托管系统代理与冒烟的调用打开逻辑一起处理，先补 runtime-management 的 public 合同。
3. **provider 后台循环**：`providerBackground.ts` 迁入 application，循环体经端口进入。
4. **执行状态绑定里的残余逻辑**：`wrapperMechanics.ts` 中的 `readPort` / `priorFanoutConsumed` / `scopeDriver.drive`、`childCallNodeExecution.ts`
   的小块、`agentNodeExecution.ts` 的 `sourcePortKindOf`，迁入 engine（需要先把 `TaskMechanicsState` 收为端口）。
5. **其余**：恢复管理（`taskExecutionPersistence.ts`）、数字员工启动映射与借用工作区、若干小块；最后补「composition 只剩装配」的收口锁。
