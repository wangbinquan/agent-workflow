# RFC-491 task-execution 与运行时驱动一族互不 import（RFC-294 §4.7 运行时驱动一族第四步）

- **状态**：Done（2026-11-13，落地 `18189b794`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.7（运行时驱动一族归 runtime-management
  infrastructure；先把经 `services/` 取驱动的其他 context 换成 runtime-management 的端口或装配，再整族迁入）、S9 第 5 项（跨 context 内部
  文件对的余债）与 design §3.1（context DAG、consumer 自有端口、bootstrap 唯一装配；runtime-management 不反向依赖上层业务 context）。
- **前序**：[RFC-487](../RFC-487-runtime-family-forbidden-consumers/proposal.md)、[RFC-488](../RFC-488-local-mcp-diagnostic-execution-port/proposal.md)、
  [RFC-489](../RFC-489-run-family-providers-bound-by-bootstrap/proposal.md)（Done）——DAG 外四个 context 对一族的 import 已归零，
  task-execution 对 runtime-management 只取 `public/`。

## 1. 背景

运行时驱动一族（`services/runtime/**`、`services/execution/{agentInjection,workspaceBoundary,taskExecutionResourceDependencies}`、
`services/{driverLease,runtimeSmoke,systemAgentRun}`）整族迁入 runtime-management infrastructure 之后，一族之外的模块只能经
runtime-management 的 `public/` 或自己的端口用它。现在还有两类依赖挡着这一步：

- **task-execution 的 16 个生产文件直接 import 一族**：
  - 只取类型：归一化事件、运行时种类、插件与技能内容、编译出的本机计划、系统代理运行的入参与结果；
  - 驱动的静态事实：种类判定、驱动声明的能力、「续会话目标不存在」的 stderr 判据；
  - 声明清单的纯构造：托管准备与托管材料编译用的空清单、MCP 分拣、技能声明；
  - 两个本机实现：运行中的启动清单读取（运行根布局与 opencode 清单文件）、插件加载失败的 stderr 识别；
  - 本机兼容运行：MCP 诊断的本机执行体经一族的系统代理运行器（`runSystemAgent`）跑一轮，并直接取驱动的会话策略、默认可执行文件与清单
    读取。
- **一族指回 task-execution 的两条边**：`services/systemAgentRun.ts` 与 `services/runtimeSmoke.ts` 取 task-execution 的本机调用与
  application 的运行核心，实为 task-execution 的本机运行器。runtime-management 不反向依赖上层业务 context，整族迁入时它们不能跟着进
  runtime-management。前者是 MCP 诊断在用的本机系统代理运行；后者只剩用例在用（runtime-management 探测夹具缝的取值）。

另有两个只供 RFC-370 契约用例使用的生产文件（`infrastructure/local/nativeTaskAgentRun.ts`、`nativeTaskAgentRunOptions.ts`，架构门的
不可达生产文件清单登记在案）也直接取一族。

## 2. 目标

- **G1 类型改取 owner 的合同或 task-execution 自有类型**：已有 public 出处的（归一化事件、运行时种类、插件与技能内容）改取出处；编译出的
  本机计划由 task-execution 只列自己读到的成员。
- **G2 驱动的静态事实经 runtime-management 的 public 查询**：种类判定、驱动能力、续会话目标不存在的判据是 runtime-management 的种类注册
  表与驱动静态表态的纯读取，task-execution 在 DAG 上直接取 `public/queries`。
- **G3 声明清单的纯构造归 shared**：与 RFC-463 迁入 shared 的启动核验同一份清单类型，托管准备与 runtime-management 的本机材料共用。
- **G4 两个本机实现归 runtime-management**：启动清单读取实现 task-execution 自有的端口、插件加载失败识别作为本机任务代理族的提供者，都由
  bootstrap 绑定。
- **G5 本机系统代理运行归 task-execution**：`services/systemAgentRun.ts` 迁入 task-execution 的 `infrastructure/local/`，驱动、材料工作区与
  材料定义作为提供者交入；MCP 诊断的本机执行体收同一组提供者。
- **G6 只供用例的运行器移出生产**：`services/runtimeSmoke.ts` 与只供契约用例的本机任务运行两个文件迁入 `tests/helpers/`；
  runtime-management 探测夹具缝的类型归它自己。
- **G7 账本与锁**：精确账本与计数随之销账、收紧；新增 RFC-491 用例。

## 3. 非目标

- 运行时驱动一族整族迁入 runtime-management infrastructure：下一步，另立。
- bootstrap 对一族的使用（启动自检、任务执行的资源依赖）与 runtime-management 自己对一族的使用：随整族迁入。
- 其余跨 context 内部文件对。
- 任何行为变化；接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：task-execution 的生产文件不 import 一族；一族不 import task-execution；`services/runtimeSmoke.ts`、`services/systemAgentRun.ts`
  与只供契约用例的两个本机任务运行文件不在生产树里。
- **AC-2**：同样输入下行为与此前一致：驱动静态事实的三个读取、声明清单的构造、启动清单读取、插件加载失败识别、本机系统代理运行（装配、
  包裹、夹具计划、材料引用、运行证据、会话续接）与 MCP 诊断的本机执行体、探测夹具缝（用例对拍）。
- **AC-3**：跨 context 内部文件对 22 → 21；R1（遗留文件取模块内部）18 → 9；不可达生产文件 18 → 16；越 DAG 的值边与 offered 文件对不升；
  public 类型污染不升；减速带不升、触及的收紧到实测。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
