# RFC-601 员工工作区与平台工作项装配的 provider 必填（RFC-294 W4-E8：可选 provider 的装配边界，员工一侧）

- **状态**：Done（2026-11-25，落地 `ed283f335`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话自行裁定落位（见
  design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §3 的 development-automation 一行（按用例的必填端口）；与
  [RFC-597](../RFC-597-development-automation-required-providers/proposal.md) 同一做法，落在 [RFC-599](../RFC-599-employee-compositions-stated-effects/proposal.md)
  §3 留下的员工两个装配上。

## 1. 背景

development-automation 的员工工作区装配（`composeDevelopmentEmployeeWorkspace`）与平台工作项装配（`composeDevelopmentEmployeePlatformWorkItems`）从
application 的入参继承了可选 provider：员工工作区的 `graphDelivery`，平台工作项的 `approvalGateway`、`pipelineEvidence`、`graphDelivery`、`mrFacts`。
没给时 application 给出“未接入”的结果（如“外部审批程序尚未接入平台”、图研发 v2 发布的 `graph-mr-verification-binding-missing`），或者跳过图验证。
daemon（唯一的生产调用方）都给：图研发的 MR 照看、集成的审批网关、开发交付组装的流水线证据与 MR 事实。“没给”只在用例里出现——与 RFC-597 之前的
开发自动化装配同一类遗漏风险。

## 2. 目标

- **G1**：两个装配入参里的这 5 个 provider 是必填成员，漏给就是编译错误。
- **G2**：application 的入参与它的“未接入”分支不变（RFC-396 要求的“缺图验证绑定是可见的阻塞”照旧由 application 保证，仍有用例直接覆盖）。
- **G3**：用例里不用的 provider 给测试替身：图交付给“这个案例没有图设计”的替身（发布前验证通过、没有修复材料——与真实图照看对没有图设计的案例的回答
  相同），审批网关、流水线证据与 MR 事实给调用即抛错的替身。
- **G4**：生产行为不变；架构计数都不升。

## 3. 非目标

- application 入参的可选性与“未接入”分支（按用例拆分必填端口时一并处理，见 RFC-597 design §5）。
- `directPublicationSubject`（没给时取执行上下文的发布主体，是选项而不是 provider）。
- 任何用户可见行为。

## 4. 能力影响清单

无。daemon 本来就给全这 5 个 provider。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：两个装配入参里的 5 个 provider 没有 `?`；daemon 装配不变。
- **AC-2**：RFC-396 的“缺图验证绑定”用例照旧覆盖 application 的阻塞（装配上不能再漏给，用例以类型断言复现那种输入）；其余用例给替身，行为与此前相同。
- **AC-3**：架构计数都不升；新增 RFC-601 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
