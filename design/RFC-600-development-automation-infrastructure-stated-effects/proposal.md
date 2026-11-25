# RFC-600 development-automation 的 infrastructure 不再替调用方造本机效果（RFC-294 S12 余项）

- **状态**：In Progress（2026-11-25）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话自行裁定落位（见
  design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S12 第 1 项（单机默认值只留在 standalone profile）；接
  [RFC-598](../RFC-598-development-automation-stated-composition-inputs/proposal.md) design §5 与 [RFC-599](../RFC-599-employee-compositions-stated-effects/proposal.md)
  留下的一项。

## 1. 背景

RFC-598、RFC-599 之后，development-automation 的装配都显式拿到效果选择，但 infrastructure 里一组助手仍在“没给”时自己造本机文件实现：
三个选择核对函数（`selectedAutomationWorkspaceEffects`、`selectActionWorkspaceEffects`、基线的 `selectedRepositoryBaselineEffects`）与收可选工厂的
包装（工作区校验适配器、业务树快照、工作区结果校验、受保护根快照、带效果执行、四个基线解析 / 读取）。生产上还在走这条回落的只有托管任务镜像里
的执行器（`infrastructure/crewstation/taskImageWorkspace.ts`，在镜像里对自己的文件跑树操作，本来就该用本机实现）；任务操作的装配
（`composeDevelopmentMissionOperations`）的基线效果也仍是可选，daemon 给，两个用例没给。

## 2. 目标

- **G1**：三个核对函数只核对、不再造本机实现；收工厂的包装与基线解析 / 读取的工厂参数都必填；任务操作装配的 `repositoryBaselines` 必填。
- **G2**：唯一靠回落的生产调用方——镜像里的执行器——显式给本机实现；用例显式给本机实现（与此前的回落相同）。
- **G3**：生产代码里只有 standalone profile、本机实现一族自身与镜像里的执行器调用本机效果的构造。
- **G4**：行为不变；架构计数都不升。

## 3. 非目标

- `selectDevelopmentWorkspaceEffectBinding` 在没给自动化效果时取动作效果的 `contents`：这是从同一个选择推出另一半，不是本机回落，保留。
- 员工两个装配继承来的可选 provider（RFC-599 §3）。
- 任何用户可见行为。

## 4. 能力影响清单

无。生产装配本来就给全；镜像里的执行器改为显式给它一直在用的本机实现。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：三个核对函数不调用任何本机构造；development-automation 的 infrastructure 里没有可选的效果工厂参数；任务操作装配的 `repositoryBaselines` 必填。
- **AC-2**：生产代码里调用本机效果构造的只有 `bootstrap/standalone.ts`、`infrastructure/local/` 与 `infrastructure/crewstation/taskImageWorkspace.ts`。
- **AC-3**：用例显式给本机实现，相关用例通过；架构计数都不升；新增 RFC-600 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
