# RFC-566 development-automation 不再按 integration 的名字取适配绑定与流水线执行类型（RFC-294 S9 第二十一步）

- **状态**：In Progress（2026-11-24）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §3.1（integration → development-automation 是目标 DAG 上的
  offered 边，integration 实现 development-automation 的 `development-effect-spi`；反方向不是）与 design §14“DAG 外的 offered 边 → 0”。

## 1. 背景

`off-dag-offered-file-context-pairs`（4 条）里有 2 条是 development-automation 取 integration 的 public——方向与目标 DAG 相反：

| 文件                                                                   | 取的 integration 类型                                                           | 用在哪                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| development-automation `composition.ts`                                | `RequirementAdapterBinding`、`PipelineAdapterBinding`、`ApprovalAdapterBinding` | 声明四个“研发用途选择”接口——它们只被 bootstrap 用（每个部署选三种用途、bootstrap 核对后分发） |
| development-automation `composition.ts`（再转出给本模块两个装配文件）  | `SelectedPipelineEvidenceExecution`                                             | 流水线证据执行面的入参类型                                                                    |
| development-automation `infrastructure/developmentDeliveryProvider.ts` | `SelectedPipelineEvidenceExecution`                                             | 交付 provider 持有的流水线执行面                                                              |

两处都有现成的归属：研发用途选择是部署装配的概念——它把 integration 的适配绑定与 development-automation 的暂存、文档写入拼在一起，只有 bootstrap
读它；流水线证据执行面在 development-automation 里早就有自己的端口 `SelectedPipelineEvidenceRunnerPort`（RFC-508，`createSelectedPipelineEvidence`
的入参就是它），integration 的实现结构上满足它。精确清单给这两条登记的后继就是“收敛 required SPI 归属”。

## 2. 目标

- **G1**：四个研发用途选择接口（`RequirementPurposeSelection`、`PipelinePurposeSelection`、`DevelopmentPurposeSelection`、
  `SelectedDevelopmentPurposeRoot`）声明在 bootstrap（部署选择的装配处），development-automation 的装配根不再声明它们。
- **G2**：development-automation 的装配文件与交付 provider 用本模块的 `SelectedPipelineEvidenceRunnerPort` 作流水线执行面的类型。
- **G3**：development-automation 的生产文件不再取 integration 的 public；integration 的 public 撤出不再有模块外读者的
  `SelectedPipelineEvidenceExecution`。
- **G4**：DAG 外的 offered 边 4 → 2；其余计数不升。
- **G5 结局不变**：只换类型的声明处；bootstrap 交入的对象、各用途的核对与流水线证据的收集 / 触发 / 重跑逐字段相同。

## 3. 非目标

- 其余 2 条 DAG 外 offered 边（source-control 取 task-execution 终态维护认领类型的一条与 system-operations 取 source-control 备份准备参与者的
  一条仍暂不动）。
- 调整适配绑定或流水线执行面的形状。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：development-automation 的全部源码不取 integration 的 public；四个用途选择接口只声明在 bootstrap。
- **AC-2**：行为不变；integration 的流水线执行面仍交得进 development-automation 的端口，由编译器检查。
- **AC-3**：DAG 外 offered 边 4 → 2，精确清单与减速带随之更新；新增 RFC-566 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
