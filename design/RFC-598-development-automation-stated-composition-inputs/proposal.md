# RFC-598 development-automation 的装配入参全部显式给出（RFC-294 S12 余项：装配不再有缺省）

- **状态**：Done（2026-11-25，落地 `e98136958`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话自行裁定落位（见
  design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S12 第 1 项（装配的回落改为必填注入，单机默认值只留在 standalone
  profile）与 RFC-431 的“部署选择显式给出”；接 [RFC-597](../RFC-597-development-automation-required-providers/proposal.md) design §5 留下的一项。

## 1. 背景

RFC-597 之后，`composeDevelopmentAutomation` 的入参还剩 6 个可选成员：

- **三组效果选择**（`actionWorkspaceEffects`、`automationWorkspaceEffects`、`repositoryBaselines`）：daemon 三个都给（前两个经
  `selectDevelopmentWorkspaceEffectBinding`，后一个是部署选择的必填成员）。没给时，infrastructure 的 `select*` 助手造本机文件实现——只有用例靠它。
- **三个证据读取的覆盖**（`evidenceContents`、`evidenceRead`、`attemptContext`）：RFC-429 起证据的读取、下载、文档与尝试上下文都是部署的
  `evidenceArtifacts` 的成员，生产一个都不给。`evidenceRead` 与 `attemptContext` 谁都不给；`evidenceContents` 只有一个用例在给。`evidenceRead` 的类型
  `composition/evidenceReadBinding.ts` 在生产代码里只被这个死选项引用。

## 2. 目标

- **G1**：三组效果选择是必填成员；装配不再依赖 `select*` 的本机回落（只用它们核对选择是否完整）。
- **G2**：三个覆盖删去：证据的读取、下载、文档与尝试上下文只从 `evidenceArtifacts` 取；`composition/evidenceReadBinding.ts` 删去，用例改用
  证据端口的同名成员（`Pick`）。
- **G3**：RFC-524 的测试助手连这三组效果的本机实现一起给（与此前装配的回落相同），调用装配的用例照旧；唯一给 `evidenceContents` 的用例改经
  `evidenceArtifacts` 给。
- **G4**：行为不变；架构计数都不升。装配入参从此没有可选成员。

## 3. 非目标

- `select*` 助手对它们其他调用方的本机回落（`attemptSupport`、`workspaceValidator`、`protectedSnapshot`、两处组合文件）：另立。
- `ReconcilerPorts` 本身（W4-E8 下一步）。
- 任何用户可见行为。

## 4. 能力影响清单

无。生产装配本来就给全部选择；删去的三个覆盖生产从不使用。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：`DevelopmentAutomationCompositionOptions`（连同继承的 provider）没有可选成员；装配把三组效果选择原样交给 `select*` 核对，不按“给没给”分支。
- **AC-2**：装配里没有 `deps.evidenceRead`、`deps.evidenceContents`、`deps.attemptContext`；`composition/evidenceReadBinding.ts` 不在、全仓无 import。
- **AC-3**：测试助手给出的三组效果与此前的回落相同（给了的原样交出）；相关用例通过；架构计数都不升；新增 RFC-598 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
