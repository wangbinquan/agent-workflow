# RFC-564 技术设计

落在 resource-catalog（一个端口文件、一个托管 infrastructure 文件）与 memory（一个端口文件）；bootstrap、task-execution 与 runtime-management 不改代码。
另改两份精确清单、`architecture/counts.json` 与新增一个 RFC-564 用例。数字取 HEAD `b2a26ea9b`。不改行为。

## 1. 改动

| 位置                                                                   | 做法                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| resource-catalog `application/ports/mcpDiagnosticExecution.ts`         | 新增 `McpDiagnosticProfile`（六个运行参数）、`McpDiagnosticIntent`（协议、一个 MCP 与参数、提示词与人设、是否新开、续接会话）、`McpDiagnosticUsageSnapshot`（及其按模型的一行）；`run` 的请求改用它们，`eventSink` 用 `McpDiagnosticEventSink` |
| resource-catalog `infrastructure/crewstation/mcpDiagnosticsEffects.ts` | `capabilities()` 的返回写成文件内的 `HostedDiagnosticCapabilities`（发布号、档位 id 与 `events / mcp / startupInventoryVersion`）；选中的档位照旧整条写进运行时目标快照                                                                        |
| memory `application/ports/distillWorkStore.ts`                         | 六个类型改成 `SystemAgentRunRequest` 上对应字段的类型（协议、`runtimeObservationIdentity`、`runtimeBinding`、`eventSink` 与它 `markTerminal` 的两个参数）；照旧转出事件接收与两个状态类型给本模块的 infrastructure 用                          |

task-execution 的托管与本机诊断运行器、bootstrap 交给 resource-catalog 的观察器与托管能力读取，都是结构绑定：诊断意图是材料意图那八个字段的子集，
本模块的事件接收比 runtime-management 的更宽（`kind` 收任意字符串），用量快照两边同形。

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 的 `off-dag-offered-file-context-pairs` 与 `rfc294-review-offered-edge-dag` 的 `OFF_DAG_OFFERED_EDGE_DEBT` 删去 3 条，
  `counts.json` 7 → 4。
- 钉着旧位置的三个用例随改：`rfc469-thin-services-facade-retirement`（memory 的端口原先从 runtime-management 转出三个会话类型，改成断言它从运行合同上
  取、且不取 runtime-management）、`rfc519-hosted-implementations-out-of-composition-boundary`（托管诊断文件的声明名单多一个文件内接口）、RFC-563 的边界
  用例（resource-catalog 取 runtime-management 的只剩指定 adapter）。
- 新增 `tests/rfc564-system-agent-run-vocabulary-boundary.test.ts`，登记 guard-manifest：① runtime-management 以外全部模块的源码里，取它的文件只属于
  目标 DAG 上的消费方（从 `OFFERED_CONTEXT_EDGES` 取名单），此外只剩 resource-catalog 的指定 adapter；memory 全部源码不取它（带负对照）；② 诊断端口的
  导出名单与请求里的三个类型、托管能力的形状；③ memory 端口的五条别名；④ 十条编译期断言（诊断意图、事件接收、用量来回、托管能力、蒸馏的事件接收
  来回、协议、观察身份、内容引用）。
- memory 端口里三个文件内别名取名 `DistillRuntime*`：架构报告按名字开头的动词（含 `run`）普查“变更入口”，沿用 `RuntimeKind` 这类名字会被误记两条。

## 3. 失败模式

- **runtime-management 改了材料意图、事件接收、用量快照或托管能力的形状**：RFC-564 用例的编译期断言与 bootstrap / 运行器的交接处报类型错误。
- **memory 或 resource-catalog 重新按名字取 runtime-management**：RFC-564 用例 ① 与两份精确清单同红。

## 4. 取舍（可推翻）

1. **resource-catalog 用自己的形状，而不是经 runtime-management 的 required-ports + 指定 adapter 取**：诊断端口是 resource-catalog 向运行器提的请求
   （consumer 自有、task-execution 实现），请求该用它自己的词汇；本机那一半（RFC-488）与本模块的事件接收类型已经是这样。它组装的意图只有八个字段、
   其中 `injection` 只放一个 MCP 与运行参数。
2. **memory 从 task-execution 的运行合同上取，而不是自己重写一遍**：memory 消费 task-execution 是目标 DAG 上的边，蒸馏器本来就按这份合同发起
   运行；从字段上取类型，合同变了这里自动跟着变，也不多出一份要对齐的声明。
3. **用量快照重写一份同形的**：resource-catalog 只转手不读，但观察器由 bootstrap 提供、由运行器调用，两头都要对得上，同形最简单。
4. **托管能力只写读到的三项**：选中的档位整条进快照是运行期的事，类型上只需要它读的字段。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：诊断请求的词汇归 resource-catalog 的 `application/ports`，蒸馏的运行词汇取自 task-execution 的 public 合同。**C11**：两个 context 的 public
  导出名单不变（诊断端口经 required-ports 交给 task-execution）。**C12**：RFC-564 用例覆盖 runtime-management 以外全部模块的源码、三处形状与十条结构
  绑定。**C13**：DAG 外 offered 边 7 → 4，其余计数不升；目标 DAG 不变。
- **留下的债**：其余 4 条 DAG 外 offered 边。
