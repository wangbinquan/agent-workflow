# RFC-477 节点回滚、资源限额、agent 启动快照与触发预检按 owner 归位（RFC-294 W9-D 第二十四步）

- **状态**：In Progress（2026-11-09）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达）：本会话调研、设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本
  会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.7（W9-D 余项按 owner 族成批）的 task-execution
  一族（W4-E1）。
- **前序**：RFC-098 / RFC-333 / RFC-395（节点回滚的检查点规划与 effect 记账）；RFC-395 II-b O3（资源限额的 task 事实与 system-operations
  审计端口）；RFC-165 / RFC-218（agent 启动的宿主快照）；RFC-292 / RFC-345（触发预检与冻结调用闭包）；RFC-282 / RFC-284（停用资源的处置
  策略）；[RFC-476](../RFC-476-task-delete-and-review-mutation-queue-owners/proposal.md)（consumer 自有端口由 bootstrap 注入）。

## 1. 背景

`services/` 余 53 个文件、`R1`（非模块文件取模块内部）余 30 条。RFC-294 plan §4.7 把 task-execution 一族列为 9 个文件：`task.ts`、
`agentLaunch.ts`、`systemAgentRun.ts`、`nodeRollback.ts`、`limits.ts` 与 `execution/` 下的 `resourcePolicy.ts`、
`taskExecutionResourceDependencies.ts`、`triggerPreflight.ts`、`workspaceBoundary.ts`。按源码、消费方与目标 DAG（RFC-294 design §3.1）
逐个核对后，这一族并不都归 task-execution，也不宜一次做完：

1. **`execution/triggerPreflight.ts`**（70 行，纯函数）的消费方是 task-execution（六个文件）、integration 的两个 composition 与
   resource-catalog 自己的 `composition/workgroupTaskRoom.ts`；它评估的是工作流定义（含冻结调用闭包，用 resource-catalog 的
   `parseCallClosure`）对触发上下文的依赖。DAG 上 resource-catalog → task-execution 不是 offered 边，放进 task-execution 就让
   resource-catalog 越界；放进 resource-catalog，task-execution 与 integration 都经 offered 边取。
2. **`execution/resourcePolicy.ts`**（93 行，纯数据）是停用 MCP / 插件的处置策略，常量与报错码都属 resource-catalog（`PLUGIN_DISABLED_ERROR_CODE`
   本就从 resource-catalog public 转出，resource-catalog 自己的 legacy 校验器绕道 `services/` 取它）；`architecture/commons-manifest.json`
   也记 owner 为 resource-catalog。
3. **`systemAgentRun.ts`** 与 **`execution/taskExecutionResourceDependencies.ts`** 取 `@/services/runtime*`：在运行时驱动一族
   （`services/runtime/**`）迁入 runtime-management 之前把它们放进模块，就是模块取 legacy 的新边。**`execution/workspaceBoundary.ts`**
   的六个消费方里四个在 runtime-management（其中两个是 `services/runtime/opencode/*`）。三者随运行时驱动一族一起迁。
4. **`task.ts`**（1793 行）一个文件占这一族七成的行数，63 个用例文件取它、约 45 个源码文本守卫读它；它的延后仓库准备与 source-control
   已有的 provider 中立 legacy 回收是一对孪生，要先收敛再归位，工作流同步预览要成 application 查询。单独立 RFC-478。

本 RFC 做余下的五个文件（约 715 行）：

- **`nodeRollback.ts`**（172 行，`R1` 3 条：取 task-execution `infrastructure/nodeRollbackPersistence` 的值与类型、`application/ports/taskRollbackQueries`
  的类型）。节点回滚的目标装载、检查点规划、git 回滚与 RFC-328 effect 记账，全是 task-execution 的事；task-execution 自己的两个文件与
  collaboration 的评审（`review.ts`）、反问自动派发（`clarify/autoDispatch.ts`）直接调它。
- **`limits.ts`**（136 行）：资源限额的执行策略（扫描运行中任务、判时长与 token 超限、取消并记原因与审计），端口早已是 task-execution 的
  `TaskResourceLimitFacts` 加 system-operations 的审计端口，由 bootstrap 组装；只有策略本身还在 `services/`。
- **`agentLaunch.ts`**（244 行，纯函数）：agent 启动的宿主工作流快照合成与启动参数校验，task-execution 的路由启动与执行结果投影在用，
  integration 的定时任务校验也调。
- 上面的 `triggerPreflight.ts` 与 `resourcePolicy.ts`。

## 2. 目标

- **G1 节点回滚归 task-execution**：失败合并说明与结果类型进 `domain/`，目标装载、规划与带 effect 记账的回滚进 `infrastructure/`；
  task-execution 自己的调用方直接取。collaboration 新增自有端口 `NodeRunWorkspaceRollbackPort`（按任务装载一个回滚作用域，作用域上
  规划与执行），经 `TaskExecutionParticipantBindings` 由 bootstrap 交 task-execution 的实现；collaboration 不再取 `services/`，也不取
  task-execution 内部。
- **G2 资源限额策略归 task-execution application**：`enforceLimits` 与它的操作合同进 `application/`；审计一半改为 task-execution 自有端口
  （与 system-operations 的审计端口结构相同，bootstrap 照旧交 system-operations 的实现），task-execution 不取 system-operations。
- **G3 agent 启动快照归 task-execution domain**：纯函数与常量进 `domain/`；integration 经 task-execution public 取启动参数校验。
- **G4 触发预检与停用资源策略归 resource-catalog domain**：经 resource-catalog public 交给 task-execution、integration 与仍在 `services/`
  的两个消费方；resource-catalog 自己的 composition 与校验器改取本模块定义处。
- **G5 public 收口**：迁移后失去模块外消费方的 public 符号当场撤出（RFC-294 design §3.3），新增的 public 符号都有模块外消费方、
  不报 public surface 偏差。
- **G6 账本与减速带**：`R1` 30 → 27（按实测销账）；`services/` 53 → 48；本 RFC 触及的减速带收口时收紧到实测（RFC-294 C13）。

## 3. 非目标

- `task.ts`（RFC-478）；`systemAgentRun.ts`、`execution/taskExecutionResourceDependencies.ts`、`execution/workspaceBoundary.ts`（随运行时
  驱动一族）；其余 `R1`。
- 行为：回滚的预检、逐仓 warn-and-continue、effect 记账与失败文案，限额的判定、取消、原因与审计，宿主快照的形状与校验报错，触发预检的
  判定与报错，停用资源的处置，全部逐字不变。
- 纯逻辑的进一步拆分（如把限额判定抽成 domain 纯函数）留给 RFC-294 S13。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：五个 `services/` 文件不在、零引用（import、路径字面量、Markdown 链接）；`R1` 里没有它们的边。
- **AC-2**：行为不变——回滚、限额、启动快照、触发预检与停用资源处置由既有用例覆盖；collaboration 的评审回滚规划与反问自动派发的
  自回滚经新端口走同一份实现。
- **AC-3**：架构计数按实测（`R1` 30 → 27），账本逐条相等；public surface 偏差、未被消费的 public 符号与越界类计数不升；触及的减速带
  收紧到实测。
- **AC-4**：受影响用例与新增 RFC-477 用例全部通过；四个包的用例都跑。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **一族拆成三处落地**：本 RFC 五个文件；`task.ts` 单独一个 RFC（规模与守卫面都超过其余八个之和，延后仓库准备要先与 source-control
   的孪生收敛）；三个依赖或主要服务于运行时驱动的文件随运行时驱动一族。plan §4.7 的「每族一个 RFC」按此调整，理由见 §1。
2. **按 DAG 定 owner**：触发预检与停用资源策略归 resource-catalog，而不是 plan §4.7 表里的 task-execution。
3. **collaboration 用自有端口取回滚**（consumer 拥有 required SPI，RFC-294 design §3.3）：task-execution public 上不新增收数据库句柄的
   工厂（那是 public surface 偏差）；端口按任务给出作用域（`load(taskId)` → `plan` / `rollback`），目标里的数据库句柄与 effect 记账不
   出 task-execution。
4. **限额的审计端口由 task-execution 声明**：DAG 上没有 task-execution → system-operations 的 offered 边，类型边也不加；bootstrap 照旧
   交 system-operations 的实现（结构相同）。
5. **按内容分层**（RFC-294 C10）：纯函数进 domain、策略进 application、git 与 effect 记账进 infrastructure；一个文件里混的就拆。
