# RFC-566 技术设计

落在 development-automation（装配根、两个装配文件、交付 provider）、integration（public 撤一个类型）与 bootstrap（声明研发用途选择）。另改两份精确
清单、`architecture/counts.json`，新增一个 RFC-566 用例。数字取 HEAD `ff3442970`。不改行为。

## 1. 改动

| 位置                                                                                                           | 做法                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bootstrap `developmentPurposeRoot.ts`                                                                          | 声明 `RequirementPurposeSelection`、`PipelinePurposeSelection`、`DevelopmentPurposeSelection`、`SelectedDevelopmentPurposeRoot`（原文照搬）；它本来就从 integration 的 public 取适配绑定类型 |
| bootstrap `deploymentProfile.ts`、`daemonModules/developmentAutomation.ts`、`daemonModules/digitalEmployee.ts` | 这几个类型改从 `developmentPurposeRoot` 取                                                                                                                                                   |
| development-automation `composition.ts`                                                                        | 删去四个接口、对 integration public 的 import 与 `SelectedPipelineEvidenceExecution` 的转出；把 `PipelineStagingFactories` 作为类型交给 bootstrap（用途选择的流水线暂存要用）                |
| development-automation `composition/pipelineEvidence.ts`、`composition/developmentDelivery.ts`                 | 流水线执行面的入参类型改用本模块的 `SelectedPipelineEvidenceRunnerPort`（`application/ports/reconcilerPorts.ts`，它们转交的 `createSelectedPipelineEvidence` 本来就收这个端口）              |
| development-automation `infrastructure/developmentDeliveryProvider.ts`                                         | provider 持有的流水线执行面同样改用 `SelectedPipelineEvidenceRunnerPort`                                                                                                                     |
| integration `public/participants.ts`                                                                           | 撤出 `SelectedPipelineEvidenceExecution`（模块外不再有读者；类型本身留在 `application/developmentPipelineAdapter.ts`，本模块的装配与实现照用）                                               |

bootstrap 把 integration 的 `composeSelectedPipelineEvidenceRunnerFor(...)` 的结果交给 development-automation 的装配函数，是结构绑定：integration 的执行面
三个方法的入参、成功与失败两支都能赋给 development-automation 的端口（端口只写了它读到的字段）。

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 的 `off-dag-offered-file-context-pairs` 与 `rfc294-review-offered-edge-dag` 的 `OFF_DAG_OFFERED_EDGE_DEBT` 删去 2 条，
  `counts.json` 4 → 2。
- 取 `SelectedPipelineEvidenceExecution` 的用例改从 integration 的定义处取。
- 新增 `tests/rfc566-development-purpose-selection-bootstrap-boundary.test.ts`，登记 guard-manifest：① development-automation 全部源码取 integration 的
  只剩指定 adapter 按类型取 `composition/required-ports`（带负对照）；② 四个用途选择接口只声明在 bootstrap 的 `developmentPurposeRoot.ts`，
  development-automation 的装配根不再声明或转出它们，也不转出流水线执行类型；③ 三个文件用本模块的端口；integration 的 public 不再交出
  `SelectedPipelineEvidenceExecution`；④ 编译期断言：integration 的执行面交得进 development-automation 的端口，bootstrap 的用途选择就是部署选择里那一格
  的类型。

## 3. 失败模式

- **integration 改了流水线执行面的形状而 development-automation 的端口还按旧的读**：bootstrap 的交接处与 RFC-566 用例的编译期断言报类型错误。
- **development-automation 重新按名字取 integration 的 public**：RFC-566 用例 ① 与两份精确清单同红。

## 4. 取舍（可推翻）

1. **用途选择声明在 bootstrap，而不是留在 development-automation 换一套自己的形状**：这四个接口把 integration 的适配绑定（配置解析、效果）与
   development-automation 的暂存、文档写入、证据存储拼在一起，读它们的只有 bootstrap（部署档案、用途核对与两个 daemon 模块装配）。它是“部署选了
   什么”的记录，归装配层；放在任一业务模块里都要点名另一个模块。
2. **流水线执行面用 development-automation 已有的端口**：`SelectedPipelineEvidenceRunnerPort` 是 RFC-508 起应用层消费的端口，装配文件与 provider 只是
   转交；目标 DAG 上这条关系就是 integration 实现 development-automation 的 `development-effect-spi`，不需要新的边。
3. **integration 的 public 撤出那个类型**：撤掉模块外的读者后它成了未消费的 public 符号；类型留在定义处供本模块用。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：部署选择的类型归 bootstrap；流水线执行面的合同归消费方 development-automation 的 `application/ports`。**C11**：integration 的 public 撤 1 个
  类型；development-automation 的装配根撤 5 个名字、交出 1 个类型（装配根不是 public 入口）。**C12**：RFC-566 用例覆盖 development-automation 全部
  源码与两处结构绑定。**C13**：DAG 外 offered 边 4 → 2，其余计数不升；目标 DAG 不变。
- **留下的债**：其余 2 条 DAG 外 offered 边（都属暂不动的能力 / 凭据类合同）。
