# RFC-599 员工工作区与平台工作项装配的效果选择必填（RFC-294 S12 余项）

- **状态**：Done（2026-11-25，落地 `84be64f92`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话自行裁定落位（见
  design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S12 第 1 项（装配的回落改为必填注入，单机默认值只留在 standalone
  profile）；与 [RFC-598](../RFC-598-development-automation-stated-composition-inputs/proposal.md) 同一做法，落在 development-automation 的另两个装配上。

## 1. 背景

development-automation 除了模块装配，还有两个由 bootstrap 调用的装配：员工工作区（`composeDevelopmentEmployeeWorkspace`）与平台工作项
（`composeDevelopmentEmployeePlatformWorkItems`）。它们的效果选择是可选成员——员工工作区的 `automationWorkspaceEffects`，平台工作项的
`automationWorkspaceEffects` 与 `repositoryBaselines`。没给时 infrastructure 的 `select*` 造本机文件实现。daemon 两处都给全（`digitalEmployee` 模块装配
交入部署的选择）；靠缺省的只有用例。

## 2. 目标

- **G1**：两个装配入参里的这三个效果选择是必填成员；装配照旧用 `select*` 与基线读取核对、使用它们，不再走本机回落。
- **G2**：用例显式给出本机实现（与此前的回落相同：自动化效果 `createFileAutomationWorkspaceEffectsFactory()`、基线效果
  `createFileRepositoryBaselineEffectsFactory()`）。
- **G3**：行为不变；架构计数都不升。

## 3. 非目标

- 两个装配从 application 继承的可选 provider（员工工作区的 `graphDelivery`，平台工作项的 `approvalGateway`、`pipelineEvidence`、`graphDelivery` 等）：
  与 RFC-597 同类，用例有按“没给”断言的（如 `rfc396-mr-lifecycle` 的门缺失），另立。
- `select*` 助手对 infrastructure 其他调用方的本机回落（RFC-598 design §5）。
- 任何用户可见行为。

## 4. 能力影响清单

无。daemon 本来就给全这三个选择。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：两个装配入参里的 `automationWorkspaceEffects`（与平台工作项的 `repositoryBaselines`）没有 `?`；装配只把它们交给核对与使用它们的调用，不按“给没给”
  分支。
- **AC-2**：daemon 装配不变；调用这两个装配的用例显式给出本机实现，行为与此前相同。
- **AC-3**：架构计数都不升；新增 RFC-599 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
