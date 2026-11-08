# RFC-470 退役最后两个薄转出 workflow / workflow.validator 与 taskLaunchGate：任务启动资源适配器归 resource-catalog（RFC-294 W9-D 第十七步）

- **状态**：In Progress（2026-11-07）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（facade 清仓：consumer 归零后删除）
- **前序**：[RFC-345](../RFC-345-resource-catalog-contract-cutover/proposal.md)（兼容转出登记表）；[RFC-466](../RFC-466-resource-acl-and-workgroups-facade-retirement/proposal.md)
  （task-execution 启动资源端口的 `canViewWorkflow`）；[RFC-469](../RFC-469-thin-services-facade-retirement/proposal.md)。
- **落位**：resource-catalog `infrastructure/agentLaunchResourceOperations.ts`、`infrastructure/workflowSnapshotLaunchGate.ts`、
  `composition/agentLaunchResources.ts`；task-execution `application/ports/agentLaunchResourceOperations.ts`。

## 1. 背景

1. `services/workflow.ts` 与 `services/workflow.validator.ts` 是 RFC-345 的兼容转出（`export *` 转出 resource-catalog 的旧函数），架构报告的
   `legacy-thin-facades` 只剩这两个（到期波次 W9-D）。生产消费方三处：task-execution `infrastructure/taskRouteOperations.ts` 两处 `getWorkflow`
   （工作流同步预览与同步门读工作流行）、`services/task.ts` 的同步预览静态校验、`services/taskLaunchGate.ts` 的快照校验；另有 69 个用例文件经它们取
   resource-catalog 的旧函数。RFC-469 因为它们转出的是要传库句柄的旧函数而留下。
2. `services/taskLaunchGate.ts`（`legacy-service-implementations` 之一）只剩一个函数 `assertWorkflowSnapshotLaunchable(db, wf)`：对一份已授权的
   工作流快照跑 resource-catalog 的静态校验，不过就抛 `workflow-invalid`。生产唯一的调用方是装配根给 integration 定时任务运行时的
   `assertWorkflowLaunchable`。
3. task-execution 的启动资源端口（`AgentLaunchResourceOperations`：可见 agent、工作流可见性、工作流静态校验）由 task-execution
   `infrastructure/agentLaunchResourceOperations.ts` 实现，它直取 resource-catalog 的三个内部文件（旧 agent、旧 validator、ACL composition），
   是 3 个跨 context 内部文件对。给这个端口补「按 id 读工作流行」若仍在 task-execution 实现，就要再取 resource-catalog 的旧 workflow，多出第 4 对。

## 2. 目标

- **G1** 启动资源适配器归 resource-catalog：resource-catalog 实现 task-execution 的启动资源端口（按结构满足，不经 public 导出），装配根注入；
  task-execution 的实现与组合文件删除。跨 context 内部文件对 46 → 43。
- **G2** 端口补 `readWorkflow(workflowId)`（按 id 读工作流行，不判可见性；可见性仍由 `canViewWorkflow` 判，`workflow-deleted` 与
  `workflow-not-visible` 的区分不变）；静态校验的候选补可选的 `frozenClosureJson`；校验问题带 `code`。
- **G3** `taskRouteOperations.ts` 两处经端口读工作流行；`services/task.ts` 的同步预览经注入的 `validateHostWorkflow` 校验（同一份实现：
  `validateWorkflowDef(definition, await loadWorkflowValidationContext(db, candidate))`）。
- **G4** 快照校验门原样迁入 resource-catalog（`infrastructure/workflowSnapshotLaunchGate.ts`，经 composition 给装配根）；`services/taskLaunchGate.ts` 删除。
- **G5** 两个薄转出删除；用例改取 resource-catalog 的定义处；`PLUGIN_DISABLED_SITES` 里指向转出的锚点改指定义处。
- **G6** 账本下降：`services/` 64 → 61、`R1` 66 → 64、`legacy-thin-facades` 2 → 0、`export-star-barrels` 3 → 1、`legacy-service-implementations`
  63 → 62、跨 context 内部文件对 46 → 43；不新增 public surface 偏差、off-DAG 边与文件对、不可达生产文件与 `module-layer-violations`，未被消费的
  public 符号不升。

## 3. 非目标

- RFC-345 登记表给这三条边点名的继任合同（同步预览的工作流查找 → task-execution `TaskExecutionResourceBinding`；两处校验 → resource-catalog
  `WorkflowValidationQueries`）不在本 RFC 用：前者按「可启动性」装载（内置工作流先被挡住），同步预览要的是「可见性」（`taskRouteOperations.ts`
  的注释给了取可见性的理由）；后者要求用户权威、不带冻结调用闭包，定时任务门没有用户权威，同步预览要按候选的冻结闭包判 call 规则。按 RFC-466
  的先例改经 task-execution 的启动资源端口，登记表的注释记明。
- `services/task.ts` 本身的去处；`services/runtime/**`。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：三个文件不在，src / 用例 / 脚本零 import；task-execution 的启动资源实现与组合文件不在，resource-catalog 的实现与 task-execution 端口
  逐项相同（编译期锁）；装配根与用例取 resource-catalog 的 composition；同步预览与同步门经端口读工作流行、经注入的校验判静态规则。
- **AC-2**：架构计数按实测（§2 G6），账本逐条相等；越界类计数、public surface 偏差与未被消费的 public 符号不升。
- **AC-3**：受影响用例（任务启动与定时任务、工作流同步预览与同步、工作流校验与 YAML、两个引擎的任务路由对拍）与新增 RFC-470 用例全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **适配器归提供方**：端口归消费方（task-execution），实现归提供方（resource-catalog），装配根接线——比在 task-execution 里再加一个跨 context
   文件对正确，且把既有的 3 对一并还掉。
2. **按结构满足、不经 public 导出**：resource-catalog 在实现文件里写同形的类型，用例编译期锁两边逐项相同；不导出成 public，避免校验问题的索引签名
   （`[key: string]: unknown`）成为 public surface 的 unsafe/open 偏差，也不新增无模块消费方的 public 符号。
3. **`readWorkflow` 不带可见性**：与被替换的 `getWorkflow` 同语义，可见性判定留在 `canViewWorkflow`，两个错误码的区分原样保留。
4. **快照校验门归 resource-catalog**：函数只用 resource-catalog 的静态校验与通用的 `ValidationError`，没有 task-execution 的概念；登记表写的
   目标（task-execution application）是 RFC-345 时的预估，本 RFC 按内容定。
5. **用例直取 resource-catalog 旧函数的定义处**：已有 33 个用例文件这样取；不另设测试专用转出。
