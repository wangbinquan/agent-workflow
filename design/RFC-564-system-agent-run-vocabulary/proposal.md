# RFC-564 系统代理运行的词汇不再被 DAG 外的 context 按 runtime-management 的名字取（RFC-294 S9 第十九步）

- **状态**：In Progress（2026-11-24）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §3.1（目标 DAG 上消费 runtime-management 的只有
  task-execution、run-observability、workspace-insight；memory → task-execution 是 offered 边）与 design §14“DAG 外的 offered 边 → 0”；做法同
  [RFC-563](../RFC-563-content-reference-own-shapes/proposal.md)。

## 1. 背景

`off-dag-offered-file-context-pairs`（7 条）里最后 3 条指向 runtime-management 的，都是为了给一次系统代理运行的请求写类型：

| 文件                                                                   | 取的 runtime-management 类型                                                          | 实际用到的                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| resource-catalog `application/ports/mcpDiagnosticExecution.ts`         | `AgentMaterialIntent`（取八个字段）、`SystemAgentEventSinkV1`、`RuntimeUsageSnapshot` | 一个 MCP、诊断代理的人设与六个运行参数；事件接收；原样转手的用量 |
| resource-catalog `infrastructure/crewstation/mcpDiagnosticsEffects.ts` | `HostedRuntimeCapabilities`                                                           | 发布号与每个档位的三项已测能力                                   |
| memory `application/ports/distillWorkStore.ts`                         | 协议、观察身份、内容引用、事件接收与它的两个状态类型                                  | 蒸馏那次系统代理运行的入参                                       |

resource-catalog 的本机诊断端口（RFC-488）早就全用本模块的词汇；本模块也已有自己的事件接收类型。memory 的蒸馏器本来就经 task-execution 的
`SystemAgentRunFamily` 发起运行，上面每个类型都是那份运行合同里某个字段的类型。

## 2. 目标

- **G1**：resource-catalog 的托管诊断端口用本模块的形状声明诊断意图、运行参数与用量快照，事件接收用本模块已有的 `McpDiagnosticEventSink`；托管诊断
  读的托管能力也写成本模块的形状。
- **G2**：memory 的蒸馏端口从 task-execution 的 `SystemAgentRunRequest`（public）上取这六个类型，不再点名 runtime-management。
- **G3**：bootstrap、task-execution 的两个诊断运行器与 runtime-management 不改；形状对得上由编译器检查。
- **G4**：DAG 外的 offered 边 7 → 4；此后按名字取 runtime-management 的只有目标 DAG 上的消费方与 resource-catalog 的指定 adapter；其余计数不升。
- **G5 结局不变**：只换类型的出处；诊断请求、事件、用量与蒸馏运行的值逐字段相同。

## 3. 非目标

- 其余 4 条 DAG 外 offered 边（development-automation 取 integration 的两条；source-control 取 task-execution 终态维护认领类型的一条与
  system-operations 取 source-control 备份准备参与者的一条仍暂不动）。
- 把诊断意图的组装从 resource-catalog 挪进运行器。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：memory 与 resource-catalog 的生产文件不再按 public 取 runtime-management；全部模块里按名字取它的只属于目标 DAG 上的消费方与
  resource-catalog 的指定 adapter。
- **AC-2**：行为不变；这些形状与 runtime-management 的合同对得上，由编译器检查。
- **AC-3**：DAG 外 offered 边 7 → 4，精确清单与减速带随之更新；新增 RFC-564 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
