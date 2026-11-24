# RFC-560 技术设计

落在 knowledge-evolution（端口归位、required-ports、值类型归 domain）与 task-execution（指定 adapter）两个 bounded context；另改 RFC-294 的目标 DAG、
几份精确清单、`architecture/counts.json` 与新增一个 RFC-560 用例。数字取 HEAD `83b179ac0`。不改行为。

## 1. 改动

| 位置                                                                                                                                                                    | 做法                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| knowledge-evolution `application/ports/fusionEngineTasks.ts`（新）                                                                                                      | `FusionWorkspaceSeed`、`FusionEngineTaskResult`、`FusionEngineTaskRecord`、`FusionEngineTaskLaunch`、`FusionEngineTaskOperations`（原样挪自 public） |
| knowledge-evolution `domain/fusionTree.ts`（新）                                                                                                                        | `FusionTreeFile`、`FusionResultManifestRead`（原样挪自 `public/types.ts`）                                                                           |
| knowledge-evolution `public/participants.ts`、`public/types.ts`                                                                                                         | 前者删去三个端口类型（技能回滚协调照旧）；后者全部挪走，删除                                                                                         |
| knowledge-evolution `composition/required-ports.ts`（新）                                                                                                               | 类型转出 `FusionEngineTaskLaunch`、`FusionEngineTaskOperations`                                                                                      |
| knowledge-evolution 的 `composition/fusion.ts`、`application/ports/fusionOperations.ts`、`application/ports/fusionPersistence.ts`、`application/fusionOrchestration.ts` | 改从定义处取                                                                                                                                         |
| task-execution `application/adapters/knowledge-evolution-adapter.ts`（新）                                                                                              | 按类型转出这两个类型                                                                                                                                 |
| task-execution `infrastructure/fusionEngineTaskOperations.ts`、`composition/providerRuntime.ts`                                                                         | 改从 adapter 取                                                                                                                                      |
| RFC-294 design §3.1 的 Mermaid、`rfc294Target.ts`                                                                                                                       | 同批加 `TE -. "implements FusionEngineTaskOperations" .-> KE`                                                                                        |

撤出顺序由架构报告的未消费计数逐层确认：端口离开 public 后，种子树与提案结果失去外部消费方；它们挪走后，树文件与结果清单也失去了——于是整份
`public/types.ts` 归入 knowledge-evolution 内部。

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 的 `off-dag-offered-file-context-pairs` 与 `rfc294-review-offered-edge-dag` 的 `OFF_DAG_OFFERED_EDGE_DEBT` 删去 2 条，
  `counts.json` 35 → 33；`rfc317-module-boundary` 的开放 Record 账删去 knowledge-evolution `public/participants.ts` 那条（启动命令的 `inputs` 随端口离开
  public）；`rfc294-design-parity` 的 design 边总数 109 → 110。
- 新增 `tests/rfc560-fusion-engine-task-port-boundary.test.ts`，登记 guard-manifest：① task-execution 全部源码取 knowledge-evolution 的只剩指定 adapter
  按类型取 required-ports（带负对照）；② 端口的位置、required-ports 与 adapter 只交出两个类型、public 不再声明；③ 值类型在 domain、`public/types.ts`
  已删；④ 目标 DAG 的边。

## 3. 失败模式

- **task-execution 又取 knowledge-evolution 的 public 或内部**：RFC-560 用例与 DAG 外 offered 边的精确清单都会红。

## 4. 取舍（可推翻）

1. **required-ports + 指定 adapter**：端口是 knowledge-evolution 向 task-execution 要的启动面，consumer-owned，RFC-294 design §3.5 把它的事实源定在
   consumer 的 required-ports。
2. **值类型撤出 public 而不是留着**：无外部消费方的 public 符号违反 design §3.3「无 consumer 不公开」；按层落位（端口专属的进端口文件，通用值形状进
   domain）。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：端口事实源在 knowledge-evolution 的 required-ports，实现方只经指定 adapter 取；值类型归 domain。**C11**：knowledge-evolution 的 public 收窄
  （端口与无消费方的值类型撤出），task-execution 的 public 不变。**C12**：RFC-560 用例覆盖。**C13**：DAG 外 offered 边 35 → 33，其余计数不升；目标
  DAG 多一条虚线 required 边。
