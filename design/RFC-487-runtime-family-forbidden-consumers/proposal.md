# RFC-487 运行时驱动一族的 DAG 外使用方改经各自的端口（RFC-294 §4.7 运行时驱动一族第一步）

- **状态**：Done（2026-11-12，落地 `76fcd805a`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.7（运行时驱动一族归 runtime-management
  infrastructure：先把经 `services/` 取驱动的其他 context 换成 runtime-management 的端口或装配，再整族迁入）与 design §3.1（context DAG）。
- **前序**：[RFC-486](../RFC-486-task-route-launch-application/proposal.md)（Done，`b69dfabe8`）收口 W4-E1；按刷新后的后继顺序，接着做
  运行时驱动一族。

## 1. 背景

运行时驱动一族在 `services/` 下共 41 个文件、约 7.4 千行（`services/runtime/**` 35 个，加 `execution/agentInjection.ts`、
`execution/workspaceBoundary.ts`、`execution/taskExecutionResourceDependencies.ts`、`driverLease.ts`、`runtimeSmoke.ts`、
`systemAgentRun.ts`）。一族之外 import 它的生产文件 35 个：runtime-management 11 个、task-execution 16 个、bootstrap 3 个之外，还有
四个 context 各有一两处——memory、resource-catalog 两处、source-control、system-operations。按 RFC-294 design §3.1，这四个 context 都不在
「→ runtime-management」的允许方向上（DAG 只有 task-execution、run-observability 消费 runtime-management，runtime-management 消费
resource-catalog）。现在它们绕道 `services/` 取驱动不算 context 边；一族一旦迁入 runtime-management，这些 import 立刻成为越 DAG 的
值边。所以整族迁入之前，先把这四处改到各自 owner 的合同上。

四处的实际用途（源码实读，design §1 逐条给出处）：

- memory 的蒸馏运行时解析器按名字读 runtime-management 的 `runtimes` 表，缺省时用 `RUNTIME_KINDS` 判内建协议——它与
  runtime-management 公开的 `resolveInternalAgentRuntime`（RFC-117：蒸馏器、提交、合并这类内部代理的运行时解析）逐步相同，是一份复制；
  表归属账本里记着这一条债。
- system-operations 的 doctor 直接取 opencode 驱动探测配置的二进制。
- source-control 的任务代理工作区内容用一族里的纯函数 `resolveBoundaryMounts` 算挂载列表。
- resource-catalog 的任务代理材料引用产出「原生技能 / 插件内容记录」，类型却借道一族的 `ResolvedSkill` 与 `RuntimePlugin` 声明。

## 2. 目标

- **G1 memory 不再复制运行时解析**：删除 memory 的解析器；memory 的装配改收它自有的端口 `NativeMemoryDistillRuntimeResolver`，由
  bootstrap 用 runtime-management 的 `resolveInternalAgentRuntime` 绑定。memory 不再读 `runtimes` 表，表归属债销一条。
- **G2 system-operations 的探测经端口**：doctor 的本机诊断改收 system-operations 自有的运行时二进制探测端口；runtime-management 在
  composition 交出「按协议探测默认二进制」，bootstrap 绑定（standalone 启动时对 claude-code 的软探测共用它）。
- **G3 挂载规则归 source-control**：`resolveBoundaryMounts` 迁入 source-control 的 domain，经 `public/queries` 交给 task-execution 的
  本地运行入口。
- **G4 原生内容记录的类型归 resource-catalog**：`SkillSource`、`RuntimePlugin` 与技能内容记录 `NativeSkillContent`（原
  `ResolvedSkill` 的数据字段）由 resource-catalog 声明并从 `public/types` 交出（runtime-management → resource-catalog 是允许方向）；
  一族的 `ResolvedSkill` 扩展 `NativeSkillContent`、只加驱动侧的 `readContentVersion` 重读（public 合同只放数据）；其他使用方不改。
- **G5 锁与账本**：新增 RFC-487 用例锁住四个 context 不再取一族；表归属债按实测销账；减速带不升、触及的收紧到实测。

## 3. 非目标

- resource-catalog 本机 MCP 诊断的执行体（`mcpDiagnosticsEffects.ts` 用 `runSystemAgent` 与驱动能力，与 CrewStation 下 task-execution
  的托管执行体对称）：另立下一步。
- task-execution 对一族的 16 处使用与 task-execution → runtime-management 的 18 个跨 context 内部文件对：另立。
- 整族迁入 runtime-management（含 `systemAgentRun.ts`、`runtimeSmoke.ts` 依赖 task-execution 应用层而不能进 runtime-management 的处理）：
  另立。
- bootstrap 里其余对一族的直接使用（`daemonApplication.ts` 的声明自检、`daemonModules/taskExecution.ts` 的资源依赖）：随整族迁入改取
  runtime-management 的 composition。
- 任何行为变化。

## 4. 用户可见变化

无。唯一可观察的差别：memory 蒸馏选到一个不存在的运行时名字时，回落到 opencode 之前会和其他内部代理一样记一条
`runtime-name-unknown-fallback-opencode` 警告日志（此前 memory 的复制品静默回落）。

## 5. 验收标准

- **AC-1**：memory、resource-catalog、source-control、system-operations 的生产文件不再 import 运行时驱动一族，唯一的例外是
  resource-catalog 本机 MCP 诊断的执行体（§3 非目标，三条边逐条钉住、另立下一步）；memory 不再读 `runtimes` 表，其解析器删除，表
  归属债销这一条。
- **AC-2**：memory 蒸馏的运行时解析、doctor 的运行时探测、任务代理的挂载列表与原生内容记录在同样的输入下与此前一致（用例对拍）。
- **AC-3**：越 DAG 的值边与 offered 文件对不升；public surface 只增本 RFC 声明的符号；减速带 60 项不升、触及的收紧到实测。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
