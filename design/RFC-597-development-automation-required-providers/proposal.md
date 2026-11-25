# RFC-597 development-automation 的装配不再接受缺省的 provider（RFC-294 W4-E8 第一步：可选袋的装配边界）

- **状态**：Done（2026-11-25，落地 `8cc1e0ff3`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话自行裁定落位（见
  design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §3 的 development-automation 一行（“按用例拆分的 non-optional
  required SPI（由可选袋 `ReconcilerPorts` 拆出），provider adapter 各实现一小面”）与债务表里 “`ReconcilerPorts` 可选袋 → W4-E8” 一行。

## 1. 背景

`composeDevelopmentAutomation` 的入参 `DevelopmentAutomationCompositionOptions` 里有 11 个由别的模块实现的 provider，都是可选成员：需求源
（`requirementSource`）、Agent 与脚本动作的启动器（`agentLauncher`、`scriptLauncher`）、审批网关（`approvalGateway`）、候选派生、发布链与冲突合并
（`changeCandidate`、`candidateDelivery`、`conflictMerge`）、仓库远端、MR 效果、流水线证据与 MR 事实采集（`repoRemote`、`mrEffects`、`pipelineEvidence`、
`mergeRequestFacts`）。没给的那一个不进 `ReconcilerPorts`，mission 走到用它的那一步时被 `*-not-wired` 挡下。

生产上唯一的调用方是 daemon 的模块装配（`bootstrap/daemonModules/developmentAutomation.ts`），它 11 个都给。“没给”这种状态只在用例里出现，
而它在生产上出过事：dual-provider-parity-audit-2026-09-04 F-H2-2——PostgreSQL daemon 装配时漏了两个启动器，开发 mission 的每个动作都被
`*-launcher-not-wired` 挡下，类型检查看不出来（`01e4b1b7b` 修复；RFC-359 的 P0 变异 `p0-9-launchers` 在运行期复现这次遗漏）。

## 2. 目标

- **G1**：11 个 provider 在装配入参里是必填成员（归在具名的 `DevelopmentAutomationProviders` 下），漏给一个就是编译错误。
- **G2**：装配把每个 provider 原样交给 `ReconcilerPorts`（需求源交给需求物化器），不再按“给没给”分支。
- **G3**：daemon 的装配不变（本来就都给）；只用到部分 provider 的用例显式给出其余 provider 的测试替身——替身的每个方法一被调用就抛错，
  而不是静默落到 `*-not-wired`。
- **G4**：生产行为不变；架构计数都不升。

## 3. 非目标

- `ReconcilerPorts` 本身（仍是可选袋）与 reconciler 里的 `*-not-wired` 分支：按用例拆成必填端口是 W4-E8 的下一步（直接构造端口的 19 个
  RFC-310 用例与三个夹具 helper 随那一步改）。
- 装配入参里另外 6 个可选成员（三组工作区与基线效果、三个证据读取的覆盖）：生产也都给或不需要，但缺省值落在 infrastructure 的 `select*`
  助手里、与别的调用方共用，属 S12 一类的余项，另立（design §5）。
- 任何用户可见行为。

## 4. 能力影响清单

无。生产装配本来就给全部 11 个 provider；本 RFC 只把“可以不给”从类型里去掉。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：`DevelopmentAutomationProviders` 恰好是这 11 个成员、都不可选，`DevelopmentAutomationCompositionOptions` 继承它；装配里没有按 provider
  是否给出的条件分支与非空断言。
- **AC-2**：daemon 装配不变、照常通过类型检查；用例的替身对 11 个 provider 都给全、每个方法被调用时抛出带名字的错误；P0 变异 `p0-9-launchers`
  在运行期照旧得到 `*-launcher-not-wired`。
- **AC-3**：架构计数都不升；新增 RFC-597 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
