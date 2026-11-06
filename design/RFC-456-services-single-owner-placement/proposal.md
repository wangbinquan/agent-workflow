# RFC-456 `services/` 单一 owner 的零散实现归位（RFC-294 W9-D 第三步）

- **状态**：Done（2026-11-06，落地 `fe9618337`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-455](../RFC-455-resource-package-family-to-resource-catalog/proposal.md)（资源包一族归 resource-catalog，`services/` 123 → 107）。
- **落位**：task-execution、resource-catalog、collaboration 各自的 `domain` / `application` / `infrastructure` / `composition`，以及
  `platform/execution`、`platform/background`。

## 1. 背景

RFC-455 之后 `services/` 剩 107 个 TS 文件。按「生产 importer 只在一个模块（或装配根）、对外依赖都在目标 DAG 给出的边上、迁走后不新增
legacy ↔ 模块的边」三条筛（`R1` 不升、`R2` 不升），能整体迁走的是下面 14 个文件（约 1.4K 行），它们各自只有一个 owner：

- task-execution 6 个：会话续接回退判定（`sessionModeFallback`）、人工门续跑的预驱动步骤
  （`humanGateContinuationEffects`）、运行时二进制配置冻结（`execution/runtimeConfigFreeze`）、子任务预算（`execution/childBudget`）、
  任务终态等待（`execution/executionWatch`）；以及只作进程身份的 `daemonGeneration`（task-execution 的租约围栏与装配根都用）；
- resource-catalog 5 个：脚本与 code-host 调用两道作者门（`scriptAuthorGate`、`codeHostAuthorGate`）、复制名（`resourceCopyName`）、
  定时任务引用（`scheduledTaskRefs`）、插件代际 GC 的兼容包装（`pluginGenerationGc`，包着 resource-catalog 自己的 composition）；
- collaboration 1 个：人工门决定的 e2e 崩溃屏障（`humanGateDecisionE2eBarrier`）；
- system-operations 与 `agent-workflow stop` CLI 共用的停机控制通道（`controlListener`：控制文件、本机 HTTP 与硬杀兜底）；
- source-control 用、但内容是通用定时机制的 `managedPeriodicJob`。

代理依赖闭包 `services/agentDeps.ts` 也只有 task-execution 一个使用者，但它是 RFC-345 登记的兼容债（继任合同是 resource-catalog 的
`AgentDependencyQueries`，归 W4-E1）：挪进 task-execution 等于把债挪走而不是还掉，不在本 RFC。其余文件或带着目标 DAG 不给的依赖（如 `services/limits.ts` 取 system-operations 的审计端口类型、`services/demoSeed.ts` 组合四个模块、
`services/ownerScopedName.ts` 取 identity-access 的 composition），或依赖仍留在 `services/` 的文件（运行时驱动一族、`envelope`、
`agentLaunch` 等），留给后续步骤。

## 2. 目标

- **G1 归位**：14 个文件迁出 `services/`，按内容落层：纯判定进 `domain`，用例与步骤进 `application`，带进程级状态或文件 / 进程副作用的进
  `infrastructure`，只做装配的进 `composition`；无业务语义的通用机制进 `platform`。
- **G2 不新增越界**：不新增目标 DAG 之外的边；`R1` / `R2` 只降不升；装配根不直接取模块的 `infrastructure/`（task-execution 的三个进程级
  钩子经它的 `composition.ts` 给装配根）；不新增 public surface、`module-layer-violations`、跨 context 内部文件对与不可达生产文件。
- **G3 行为不变**：只换位置与 import，函数体原样；`pluginGenerationGc` 的兼容包装并入 resource-catalog 的同名 composition（包装函数本身
  就是对它的恒等转发）。
- **G4 账本收口**：`R1` 按实测销账；架构报告的 legacy 归属表删去这些文件。

## 3. 非目标

- 运行时驱动一族（`services/runtime/**`）：迁入 runtime-management 需要重画 task-execution ↔ runtime-management 的驱动接缝（驱动合同
  是开放类型，直接进 public 会抬高 public surface 偏差；memory / intent / resource-catalog / system-operations 经 `services/` 取驱动的
  地方要先解开），单独立 RFC。
- `services/limits.ts`、`services/demoSeed.ts`、`services/ownerScopedName.ts`、`services/taskLaunchGate.ts`、`services/task.ts`（E1）
  等带越界依赖或依赖仍留在 `services/` 的文件；余下 6 个一跳转出；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：14 个文件不在 `services/`，`src/` 与用例零引用旧路径；装配根不取 task-execution 的 `infrastructure/`。
- **AC-2**：架构计数按实测：`services/` 107 → 93，`legacy-horizontal-files` 与 `legacy-service-implementations` 下降，`R1` 下降、`R2` 不升
  （账本逐条相等；`R2` 只数 application / domain / engine / public 取 `@/services/` 的边，这 14 个文件的消费方都在
  infrastructure / composition）；off-DAG 值边 0、值环 0、平台 → 模块 0、跨 context 内部文件对、off-DAG offered 文件对、public surface 偏差、
  `module-layer-violations`、不可达生产文件不升。
- **AC-3**：受影响用例（子任务预算与终态等待、会话续接、人工门续跑、作者门、复制名、定时任务引用、插件代际 GC、e2e 屏障、停机控制、
  定时机制、守护进程代际）全部通过；新增 RFC-456 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **`daemonGeneration` 进 `platform/execution`，不进 task-execution**：它是「本守护进程这一代」的进程身份（模块加载时铸一次），
   task-execution 的租约围栏、committed-events worker 的 id、恢复证明都用它；进 task-execution 的 `infrastructure` 会让四个装配根文件
   直取模块内部。
2. **`managedPeriodicJob` 进 `platform/background`，不进 source-control**：内容是与业务无关的定时作业机制（可注入的计时器 API、
   下次延迟的上下限校验、停止句柄），source-control 只是目前唯一的使用者；`platform/background` 已是维护作业机制的所在。
3. **task-execution 的三个进程级钩子经 `composition.ts` 给装配根**：`setChildTaskBudgetCapacity`、`notifyChildBudgetTaskStatus`、
   `notifyTaskTerminal` 是装配根在启动与 committed-events 回调里调用的，装配根此前不直接取任何模块的 `infrastructure/`，保持这一点。
4. **`pluginGenerationGc` 的兼容包装并入 resource-catalog composition**：它只有装配根两处使用，`createPluginGenerationFilesystemGcPort`
   是对 composition 同名函数的恒等转发，`runPluginGenerationGc` 补默认宽限期与回执映射；并入后装配根直接取 composition。
5. **`controlListener` 进 `platform/execution/local`，不进 system-operations**：它是守护进程的停机控制通道，监听端被
   system-operations 的宿主生命周期启动，客户端被 `agent-workflow stop` CLI 与 system-operations 的切换 / 启动租约使用；进
   system-operations 的 `infrastructure` 会让 CLI 直取模块内部（`R1` 新增一条），而它不含业务语义，与 `platform/execution/local` 里的
   进程机制同类。
6. **只迁「整体能走」的一批**：带越界依赖的文件逐个需要端口决定（如 `limits` 的审计端口归谁），不在本 RFC 里顺手决定。
