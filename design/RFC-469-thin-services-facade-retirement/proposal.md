# RFC-469 退役三个薄转出：taskAuthorization、sessionEventSink、taskExecutionCallClosure（RFC-294 W9-D 第十六步）

- **状态**：Done（2026-11-07，落地 `e9fb623f8`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（facade 清仓：consumer 归零后删除）
- **前序**：[RFC-454](../RFC-454-services-one-hop-facade-sweep/proposal.md)（一跳转出清扫，留下的转出按真实消费方逐条登记）；
  [RFC-468](../RFC-468-node-run-mint-split/proposal.md)。
- **落位**：runtime-management `public/participants.ts`；`services/task.ts`。

## 1. 背景

`services/` 里还有三个只转手的文件，合计 5 条 `R1`：

1. `services/taskAuthorization.ts`（3 条 `R1`）：转出 task-execution 旧 SQLite 授权条件与一个任务授权端口的两个小判定。生产里唯一的 import 是
   `services/task.ts` 的一行空导入 `import {} from '@/services/taskAuthorization'`（不取任何名字）；只剩一个用例取它的 `visibleTaskIdsOf`。
2. `services/sessionEventSink.ts`（1 条 `R1`）：转出 runtime-management 会话事件端口的四个类型。消费方是 memory 的两个 infrastructure 文件与
   `services/` 下的两个文件；runtime-management `public/participants` 已转出其中两个，memory 还要 `SessionCaptureTerminalState`。RFC-454 把它列为
   「留下的转出」。
3. `services/execution/taskExecutionCallClosure.ts`（1 条 `R1`）：一个只有一行调用的函数（`resourceAuthority.resources.freezeCallClosure(…)`），
   唯一的调用方是 `services/task.ts`。

## 2. 目标

- **G1** 删除 `services/taskAuthorization.ts`：去掉 `services/task.ts` 的空导入；用例改取 task-execution 的定义处。
- **G2** 删除 `services/sessionEventSink.ts`：runtime-management `public/participants` 补转出 `SessionCaptureTerminalState`（字面量联合）；
  `services/` 的两个消费方改取那里，memory 的两个 infrastructure 文件改取 memory 自己的蒸馏端口（它已经从 runtime-management 取这些类型，
  就地转出），不新增 off-DAG offered 文件对。
- **G1a** 旧 SQLite 任务授权迁入用例树：`services/taskAuthorization.ts` 是 task-execution `infrastructure/legacySqliteTaskAuthorization.ts` 唯一的
  生产 import 方（而它自己只经那行空导入可达），删除后这个文件生产不可达，只剩 RFC-311 徽标计数用例在测；原样迁入 `tests/helpers/`。
- **G3** 删除 `services/execution/taskExecutionCallClosure.ts`：同名同参的函数并入 `services/task.ts`（它唯一的调用方），函数体不变。
- **G4** 账本下降：`R1` 71 → 66；`services/` 67 → 64；RFC-349 provider 切换债务销账两条；不新增 public surface 偏差、capability 归属条目、
  off-DAG 边、跨 context 内部文件对与 `module-layer-violations`，未被消费的 public 符号不升。

## 3. 非目标

- `services/workflow.ts` / `services/workflow.validator.ts` 两个转出：它们转出的是要传库句柄的旧函数，resource-catalog 的 `public/operations`
  是封闭的数据型操作描述，不宜收；留给它们的消费方归位时一起处理。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：三个文件不在，src / 用例 / 脚本零 import；会话 sink 类型的消费方取 runtime-management `public/participants` 或 memory 自己的端口；
  旧 SQLite 任务授权在 `tests/helpers/`；
  `freezeTaskExecutionCallClosure` 在 `services/task.ts`、函数体不变。
- **AC-2**：架构计数按实测（`R1` 71 → 66，账本逐条相等）；越界类计数、public surface 偏差与未被消费的 public 符号不升。
- **AC-3**：受影响用例（任务授权与徽标计数、系统代理运行、记忆蒸馏会话 sink、任务启动的调用闭包冻结）与新增 RFC-469 用例全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **空导入直接删**：`import {} from …` 不取任何名字，被导入的文件也没有副作用（只有声明与转出），删去后行为不变。
2. **会话 sink 类型经 runtime-management `public/participants`**：RFC-461 起 memory 的端口已从那里取 `SystemAgentEventSinkV1`；补转出的
   `SessionCaptureTerminalState` 是闭合的字面量联合，memory 是它的模块外消费方。
3. **memory 经自己的端口取会话 sink 类型**：memory → runtime-management 不是目标 DAG 的边；memory 的蒸馏端口已经从 runtime-management 取
   `SystemAgentEventSinkV1`（既有的一对），在那里一并转出另外两个类型，infrastructure 改取同模块的端口，不多出 off-DAG 文件对。
4. **旧 SQLite 任务授权迁入用例树、不退役**：与 RFC-466 / RFC-467 同理——只剩用例在用的生产代码离开生产树，断言逐字不变；它是否退役（覆盖是否
   已由 provider 中立的授权查询承担）留给后继 RFC（可推翻：原样挪回 `src/` 即恢复）。
5. **一行函数并回唯一调用方**：不为一个调用点保留一个 `services/` 文件；函数名、参数与函数体不变，读它源码的锁改读 `services/task.ts`。
