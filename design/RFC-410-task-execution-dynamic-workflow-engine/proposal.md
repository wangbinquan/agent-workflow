# RFC-410 task-execution 动态工作流生成引擎迁入 engine/task（RFC-294 S6）

- **状态**：Done（2026-11-01；AC-6 以后继 CI 证据关闭，见 plan「CI（AC-6）」）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你
  可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，
  无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6；design §5.2（「动态工作流引擎迁出 `services/`，归 task-execution」）
- **前序**：[RFC-408](../RFC-408-task-execution-task-control-plane/proposal.md)（任务控制面迁入 `engine/task/`）、[RFC-409](../RFC-409-task-execution-dag-scope-interpreter/proposal.md)
- **落位**：task-execution `engine/task/`（生成引擎）、`domain/`（编排代理与生成判定的纯函数）、`application/ports`（生成引擎端口）、
  `composition/`（端口绑定）；`@agent-workflow/shared` 的 `dynamicWorkflow.ts`（第二层 v1 约束校验）；删除 `services/dynamicWorkflowRunner.ts`
  与 `services/orchestratorAgent.ts`

## 1. 背景

RFC-408 后三类任务引擎都由 `engine/task/runTask.ts` 选择，DAG 引擎的 scope 解释器也已在 `engine/scope/`（RFC-409）。动态工作流的生成引擎
仍在 legacy 层：

- `services/dynamicWorkflowRunner.ts`（492 行）：一次生成 pass——载入 `dw` 检查点、解析代理池、铸造编排代理 run、构造提示词、经工作组宿主
  钩子运行、两层校验与触发器预检、写检查点、开确认门。它直接 import `services/orchestratorAgent.ts`、`services/workflow.validator.ts`
  （resource-catalog 的校验器门面）与 `services/execution/triggerPreflight.ts`；`composition/taskEngineApplication.ts` 的 `dw-generate`
  主体调用它。
- `services/orchestratorAgent.ts`（349 行，纯函数）：内建编排代理、生成阶段快照、编排提示词、代理池 token，以及第二层 v1 约束校验
  `validateDynamicWorkflowDef`。后者还被 resource-catalog 的工作组任务房（确认前复核）使用；resource-catalog 不能依赖 task-execution 的
  public（task-execution 依赖 resource-catalog，反向是 off-DAG 边）。
- 校验上下文以 `DynamicWorkflowValidationContextSource`（类型取自 resource-catalog 校验器的参数）从参与者一路传到引擎，task-execution 的
  composition / infrastructure 因此 import 这个 services 文件。

## 2. 目标

- **G1 生成引擎迁入 engine**：生成 pass 迁入 `engine/task/dynamicWorkflowGenerate.ts`，经 task-execution 自有端口执行（检查点与代理读取、
  NodeRun 铸造与转移、第一层校验、触发器预检、宿主运行）。
- **G2 纯函数归位**：编排代理、生成阶段快照、提示词与代理池 token 迁入 `domain/`；生成判定（常量、JSON 载荷提取、call 节点拒绝、两层
  校验的组合）迁入 `domain/`，第一层校验以函数注入；第二层 v1 约束校验迁入 `@agent-workflow/shared` 的 `dynamicWorkflow.ts`，两个
  上下文各自从 shared 取用。
- **G3 校验经端口**：参与者交给引擎的是「载入一个第一层校验函数」的端口（只用 shared 类型），由 resource-catalog 的 composition 构造；
  task-execution 不再出现 resource-catalog 校验器的类型。
- **G4 删除两个 services 文件**：`services/dynamicWorkflowRunner.ts`、`services/orchestratorAgent.ts` 删除，调用方改指新 owner。
- **G5 端口不新增跨层依赖**：不新增 R2 边或 off-DAG 文件边；legacy → 模块内部的文件边只减不增。
- **G6 纯结构**：生成次数、重试与拒绝上限、提示词字节、校验错误文本与顺序、确认门与检查点的写入次序不变。

## 3. 非目标

- 动态工作流确认 / 拒绝 / 另存为（resource-catalog 工作组任务房）的行为与位置。
- `services/execution/triggerPreflight.ts` 的归位（引擎经端口取用，同 RFC-408）。
- workgroup 轮次引擎迁入 task-execution（后续 RFC）。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：生成 pass 在 `engine/task/`，编排代理与生成判定在 `domain/`，第二层校验在 shared；两个 services 文件删除（结构锁锁定，含负例）。
- **AC-2 端口**：生成引擎与其端口不 import `services/`、infrastructure 或其他 context；task-execution 不再引用 resource-catalog 校验器类型。
- **AC-3 行为不变**：动态工作流生成 / 确认 / 恢复 / e2e 与编排代理的既有用例、P0 变异 lane 全部通过，断言意图不变。
- **AC-4 守卫**：按旧路径取语料的锁随 owner 改指；新结构锁带负例。
- **AC-5 账本**：counts / commons-debt / RFC-345 门面账本 / guard-manifest / Windows paths 按实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **第二层校验进 shared**：它只依赖 shared 的 DW 类型与校验码，被 task-execution 与 resource-catalog 共用；放在 shared 的
   `dynamicWorkflow.ts`（DW schema 与 token 转换同处）避免 resource-catalog → task-execution 的反向边。
2. **第一层校验以函数注入**：`evaluateGeneratedWorkflow` 的第三个参数由「校验上下文」改为「第一层校验函数」，引擎从端口取得它；
   校验函数仍由 resource-catalog 的校验器与当次载入的库存上下文构成，结果与现状相同。
3. **任务控制面去掉编排节点常量端口**：RFC-408 为避开 services 依赖而设的 `rules.dynamicWorkflowOrchestratorNodeId`，在常量迁入
   `domain/` 后改为直接 import。
4. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」。
