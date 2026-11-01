# RFC-408 task-execution 任务控制面迁入 engine/task（RFC-294 S6，design §5.5 第 4 步之二）

- **状态**：In Progress（2026-11-01 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你
  可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，
  无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6；design §5.2、§5.5 第 4 步
- **前序**：[RFC-407](../RFC-407-task-execution-fanout-assembly-lines/proposal.md)（design §5.5 第 4 步之一）
- **落位**：task-execution `engine/task/`（任务控制面主体）、`engine/scope/`（DAG 结构图，scope 解释器层的第一个文件）、`application/ports`
  （任务控制面端口）、`composition/`（端口绑定与执行状态装配）

## 1. 背景

design §5.2 把任务控制面（任务级推进、暂停 / 恢复 / 取消、终态）放在 `engine/task/`，并禁止「engine 里一行委托、composition 里写主体」。
现状（行号以 RFC-407 落库后的 `C` = `TE/composition/taskEngineApplication.ts` 为准，898 行）：

- 任务控制面整个写在 `C` 的 `runTaskEngineOrchestratorInner`（`C:196-898`）里：载入任务快照、核对持久 owner、执行授权、工作区排除配置、
  解析工作流快照与触发器预检、CAS 认领 running、人工提问 park、节点 kind / id / 容器 / 顶层环校验、装配 `TaskMechanicsState`、合并恢复、
  引擎选择与驱动、只读成员巡检，以及按结果结算终态（failed / canceled / awaiting_review / awaiting_human / done，含人工提问 park 的重试循环）；
  `failRuntimeTask` / `cancelRuntimeTask`（`C:70-169`）是它的两个终态写入 helper。
- `engine/task/` 下的 `DagTaskEngine` / `WorkgroupTaskEngine` / `DynamicWorkflowTaskEngine` 各 12 行，都是对 `C` 里闭包的一行委托。
- DAG 结构图的两个纯函数 `buildScopeUpstreams` / `findScopeCycle` 在 `composition/taskDagGraph.ts`，任务控制面的顶层环预检与 scope 解释器
  （`composition/taskDagScope.ts` 的 `runScope`）共用。

## 2. 目标

- **G1 任务控制面迁入 engine**：`C:196-898` 的流程与两个终态写入 helper 迁入 `engine/task/`，经 task-execution 自有端口执行；engine 不再读
  `BoundRunTaskOptions` / `TaskMechanicsState`。
- **G2 composition 只装配**：`C` 只剩 `driveTaskEngineApplication`（执行上下文包装与许可回收）和端口绑定；`TaskMechanicsState` 的装配与三个
  引擎的构造经端口的「准备驱动」能力交给 engine，engine 只拿回驱动句柄。
- **G3 DAG 结构图归 scope 层**：`taskDagGraph.ts` 原样迁为 `engine/scope/dagGraph.ts`，任务控制面与 `runScope` 共用。
- **G4 端口不新增跨层依赖**：端口只用 task-execution 自有的结构类型（persistence 分组类型本就在 `application/ports`）；`services/`、
  infrastructure 与其他 context 的能力由绑定接入；不新增 R2 边或 off-DAG 文件边。
- **G5 纯结构**：每一次 CAS 写入的目标状态、from 集合、reason、错误摘要 / 文本，检查与结算的顺序，日志措辞与字段，cancel 优先、
  人工提问 park 的重试循环、ownerless 测试接缝，全部不变。

## 3. 非目标

- DAG scope 解释器（`runScope`、`deriveFrontier`）迁入 `engine/scope/`：下一个 RFC。
- workgroup 轮次引擎、动态工作流引擎迁入 task-execution（三个引擎类仍委托给端口）：后续 RFC。
- 协调器构造点、`TaskMechanicsState` 的拆分；ownerless 测试接缝的退役。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：任务控制面主体与终态写入 helper 在 `engine/task/`，只 import 允许的层；`C` 不再含载入 / 认领 / 校验 / 结算流程
  （结构锁锁定，含负例）。
- **AC-2 端口**：新增端口不 import `services/`、infrastructure 或其他 context；`dagGraph.ts` 在 `engine/scope/` 且 owner 唯一。
- **AC-3 行为不变**：任务生命周期、恢复、人工门 park、取消、动态工作流与 workgroup 的既有用例，P0 变异 lane 全部通过，断言意图不变。
- **AC-4 守卫**：RFC-317 站点 / allowTerminal 账本、RFC-328 账本、RFC-333 / RFC-359 等按 `C` 路径取语料的锁随 owner 改指；新结构锁带负例。
- **AC-5 账本**：counts / commons-debt / guard-manifest / Windows paths 按实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **准备驱动经端口完成**：校验通过后 engine 把算好的事实（快照、定义、仓库挂载、触发上下文、输入、scope 索引）交给端口的
   `prepare`，绑定在那里装配 `TaskMechanicsState`、合并恢复与三个引擎，返回驱动句柄。装配留在 composition，与 S6 退出门
   「`TaskMechanicsState` 只出现在装配」一致。
2. **执行授权与资源会话由绑定合成**：engine 只看到「授权是否可用」，资源会话随准备驱动交给装配。
3. **`taskDagGraph.ts` 进 `engine/scope/`**：它是 scope 解释器的结构图，scope 层由下一个 RFC 补齐。
4. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」。
