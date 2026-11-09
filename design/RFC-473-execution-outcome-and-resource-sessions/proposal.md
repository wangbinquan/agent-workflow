# RFC-473 执行结果投影与资源会话归 task-execution：`services/execution/` 的三个文件迁入（RFC-294 W9-D 第二十步）

- **状态**：In Progress（2026-11-08）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 业务实现按 owner 归位）
- **前序**：[RFC-243](../RFC-243-unified-executor/proposal.md)（统一结果投影与执行器合同类型）；
  [RFC-345](../RFC-345-resource-catalog-contract-cutover/proposal.md) T4a（task-execution 消费 Resource Catalog 的资源会话适配器）；
  [RFC-456](../RFC-456-services-single-owner-placement/proposal.md)（只有一个 owner、整体能走的 `services/` 文件迁入 owner，本 RFC 同一做法）。
- **落位**：task-execution `infrastructure/executionOutcome.ts`、`infrastructure/taskExecutionResources.ts`；`public/queries.ts` 只少一个转出；
  装配根 `server.ts` 与 legacy `services/task.ts` 改取 task-execution `public/commands` 已有的两个类型。

## 1. 背景

1. `services/execution/` 下三个文件的 owner 都是 task-execution，生产消费方全在 task-execution 内部或只取 task-execution 已经 public 的类型：
   - `outcome.ts`（309 行）：RFC-243 的统一结果投影——「任务结束后产出了什么」，workflow / agent / code-round / workgroup 四种执行一个答案。
     `projectExecutionOutcome` 是对预取行的纯函数，`getExecutionOutcome` 经 task-execution 自己的读模型取行。它取 task-execution
     `infrastructure/taskExecutionReadModels`，是 1 条 `R1`；生产消费方是 task-execution 的三个 composition 文件（动作执行环境、子调用节点、
     数字员工执行）。
   - `types.ts`（98 行）：RFC-243 T1 的「统一执行器合同」类型。生产上只有 `outcome.ts` 取它的 `ExecutionOutcome`；`ExecutionKind`、
     `ExecutionRef`、`StartExecutionRequest` 全仓零消费（它们描述的任务级执行器 `services/execution/executor.ts` 已由 RFC-359 AC-1 删除）；
     `ExecutionInvoker` 只是 task-execution `public/commands` 的转出，只有两个用例经这里取。
   - `taskExecutionResources.ts`（258 行）：RFC-345 T4a 的资源会话适配器——按一对权威 / 操作者绑定一次只读快照事务，解析任务与 agent 运行的
     注入。它转出 task-execution `application/ports/taskExecutionResourceSnapshots` 的三个类型与 `infrastructure/taskExecutionResourceSnapshots`
     的 `createTaskExecutionResourceBinding`，是 3 条 `R1`；生产消费方是 task-execution 的六个 composition 文件与一个 infrastructure 文件，另有
     装配根 `server.ts`（`TaskExecutionResourceBinding` 类型）与 legacy `services/task.ts`（`TaskExecutionResourceAuthority` 类型）——这两个类型
     task-execution `public/commands` 早已转出。
2. 用例与仓库文件：17 个用例 / helper 经这三个文件 import，另有按路径读或登记它们的：RFC-317 公共内核清单（`architecture/commons-manifest.json`，
   `rfc317-identity-dispatch` 据它扫穷尽分派）、P3 登记 EK-07 的锚点、RFC-395 选择语义账本、`rfc395-task-definition-boundary` 的读点清单、
   `rfc345-resource-catalog-contracts` 的源码锁、`rfc405-agent-single-executor` 的负对照、架构报告 owner 表，以及 `windows-platform` workflow 的
   两份路径过滤。

## 2. 目标

- **G1** `outcome.ts` 迁为 task-execution `infrastructure/executionOutcome.ts`，`types.ts` 里唯一有消费方的 `ExecutionOutcome` 随投影迁入同一文件；
  函数体逐字不变。模块内的 import 改取定义处（不经本模块的 public）。
- **G2** `types.ts` 删除：零消费的 `ExecutionKind` / `ExecutionRef` / `StartExecutionRequest` 删掉，`ExecutionInvoker` 的转出删掉（两个用例改取
  `public/commands`）。
- **G3** `taskExecutionResources.ts` 迁为 task-execution `infrastructure/taskExecutionResources.ts`，函数体逐字不变；它的四个转出删掉，消费方改取
  定义处；`server.ts` 与 `services/task.ts` 改取 `public/commands` 的同名类型。
- **G4** public 只减不增：迁移后失去全部模块外消费方的 public 转出（`public/queries` 的 `workgroupLaunchMode`，生产上只有结果投影取它）
  收回，定义不动。
- **G5** 账本与清单随迁：`R1` 53 → 49（按实测销账）；公共内核清单、EK-07 锚点、选择语义账本、路径锁与 workflow 路径过滤改指新位置。
  `services/` 60 → 57、`legacy-horizontal-files` 180 → 177；不新增跨 context 内部文件对、off-DAG 边与文件对、public surface 偏差、不可达生产文件与
  `module-layer-violations`，未被消费的 public 符号不升。

## 3. 非目标

- `services/nodeRollback.ts`（owner task-execution，3 条 `R1`）：collaboration 的评审与反问直接调它的三个函数，迁入后要么在 task-execution
  public 上开出带数据库句柄与日志器的签名（public surface 偏差会升），要么给 collaboration 一个自有的回滚端口、穿过 `review.ts` /
  `autoDispatch.ts` 的深层调用链接线——后者是另一个 RFC 的量。
- `services/execution/` 其余五个文件（`agentInjection` / `resourcePolicy` / `taskExecutionResourceDependencies` / `triggerPreflight` /
  `workspaceBoundary`）：消费方跨 resource-catalog、runtime-management、source-control、integration，不能整体迁进 task-execution。
- 结果投影与资源会话的语义：投影的种类分派、警告、错误三元组、读点选择，资源会话的快照事务、注入解析与错误码逐字不变。
- EK-07 的处置：投影仍取 `services/agentLaunch` / `services/codeRoundContract` 的节点 id 常量（登记的「跨域取常量」仍在），只改锚点位置。
- `services/task.ts`、`services/systemAgentRun.ts`、`services/runtime/**`。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：三个旧文件不在，四个包的源码、用例、脚本与 workflow 零 import、零按路径读；新位置的函数体与旧文件逐字相同；`server.ts` 与
  `services/task.ts` 的那两个类型取自 task-execution `public/commands`。
- **AC-2**：架构计数按实测（§2 G5），账本逐条相等；越界类计数、public surface 偏差与未被消费的 public 符号不升。
- **AC-3**：受影响用例（结果投影四种执行、子调用与动作执行取结果、资源会话与注入解析、任务启动资源绑定、公共内核穷尽分派、选择语义账本）
  与新增 RFC-473 用例全部通过；四个包的用例都跑。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **落 infrastructure 而非拆出 application**：`getExecutionOutcome` 经本模块读模型取行、资源会话开只读快照事务，都是适配层；纯投影
   `projectExecutionOutcome` 与它的装配器同文件、被三处 composition 按名取，拆开只多一层 import 而不改依赖方向。逐字迁移让「行为不变」可逐行核对。
2. **`types.ts` 删除而非迁入**：四个类型里只有 `ExecutionOutcome` 有生产消费方，它是投影的返回形状，跟投影放在一起；其余三个零消费，
   `ExecutionInvoker` 本就是 public 的转出。面向代码最合理，删除优于搬运死代码。
3. **`nodeRollback` 不随本 RFC 走**：见 §3。它与 collaboration 的回滚调用链一起处理，才能不在 public 上开出数据库句柄。
