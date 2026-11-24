# RFC-563 source-control 与 resource-catalog 用自己的形状声明任务代理的内容引用与资源材料（RFC-294 S9 第十八步）

- **状态**：Done（2026-11-24，落地 `b2a26ea9b`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §3.1（目标 DAG：runtime-management → resource-catalog 是 offered
  边，反向不画；source-control → runtime-management 也不画）与 design §14“DAG 外的 offered 边 → 0”；做法同
  [RFC-561](../RFC-561-aggregate-read-source-ports/proposal.md)（用自己的类型点名，bootstrap 结构绑定）。

## 1. 背景

`off-dag-offered-file-context-pairs`（11 条）里有 4 条是内容 owner 为了给自己发出的东西写类型，按名字取 runtime-management 的材料意图
`AgentMaterialIntent`：

| 文件                                                                     | 用它写什么                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| source-control `infrastructure/local/taskAgentWorkspaceContents.ts`      | 工作目录与任务挂载的内容引用（`['workspace']`）               |
| resource-catalog `application/ports/taskAgentMaterialReferences.ts`      | 技能 / 插件材料清单（`['injection']['skills' \| 'plugins']`） |
| resource-catalog `infrastructure/local/taskAgentMaterialReferences.ts`   | 自己发出的内容引用（`['workspace']`）                         |
| resource-catalog `infrastructure/crewstation/crewstationNativePlugin.ts` | 托管插件读取的入参（一条插件材料）                            |

这些引用与材料正是这两个 owner 自己发出、自己解释的（意图里引用的 `owner` 字段就写着 `'source-control' | 'resource-catalog' | …`）；它们的对象由
bootstrap 结构绑定到 task-execution 的本机端口，task-execution 再把材料放进意图（task-execution → runtime-management 是目标 DAG 上的边）。

## 2. 目标

- **G1**：resource-catalog 在 `application/ports/taskAgentMaterialReferences.ts` 声明自己的内容引用、技能材料与插件材料，`TaskAgentResourceMaterial`
  改用它们；本机引用实现与托管插件读取随之不再取 runtime-management。
- **G2**：source-control 的工作区内容只声明自己读写的两个形状（读入的引用只读 `reference`，发出的挂载引用以 `'source-control'` 为 owner）。
- **G3**：bootstrap 与 task-execution 不改：这些形状结构上仍是材料意图对应部分的子集，交接处由编译器检查。
- **G4**：DAG 外的 offered 边 11 → 7；resource-catalog 的 public 不再经材料引用够到意图里的日志器类型——那一条 public 类型偏差改记在意图 owner
  （runtime-management）自己的 public 根上，条数不变；其余计数不升。
- **G5 结局不变**：只换类型的出处，发出的引用、材料与读取结果逐字节相同。

## 3. 非目标

- resource-catalog 的 MCP 诊断仍取 runtime-management 的两处（诊断请求里的整份意图子集、事件接收与用量快照，另立）；其余 5 条 DAG 外 offered 边。
- 材料意图本身的形状。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：source-control 的生产文件不取 runtime-management；resource-catalog 取它的只剩 MCP 诊断的两处与指定 adapter。
- **AC-2**：行为不变；两个 owner 的形状仍能交给材料意图与 task-execution 的本机端口，由编译器检查。
- **AC-3**：DAG 外 offered 边 11 → 7，精确清单与减速带随之更新；`PUBLIC_SURFACE_DEBT` 里那一条按新的归属登记；新增 RFC-563 用例并登记
  guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
