# RFC-406 task-execution workgroup host 迁入 engine/node 并删除 nodeMechanics.ts（RFC-294 S6，design §5.5 第 3 步之四）

- **状态**：In Progress（2026-11-01 落档并实施；实现与集中验证完成，待 exact SHA 的 CI，见 plan「集中验证（T5）」）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你
  可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，
  无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。RFC-405 落库后转 In Progress 开始实施（两者都改 agent-single 执行器与端口）。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6；design §5.2、§5.5 第 3 步与第 5 步
- **前序**：[RFC-403](../RFC-403-task-execution-small-leaf-executors/proposal.md)、[RFC-404](../RFC-404-task-execution-child-call-executors/proposal.md)、
  [RFC-405](../RFC-405-task-execution-agent-single-executor/proposal.md)
- **落位**：task-execution `engine/node/agent-single/`（host lane 主体）、`application/ports`（agent 执行端口补 host 能力）、`composition/`（端口绑定与
  workgroup 引擎钩子）

## 1. 背景

RFC-294 design §5.5 第 3 步依次迁 code-host、input / output、call-workflow / call-workgroup、agent、workgroup host。RFC-403～405 迁完了前四组，
本 RFC 迁最后一组，并完成第 5 步的退出门之一「`nodeMechanics.ts` 删除」。

现状（行号以 RFC-405 落库后的 `N` = `TE/composition/nodeMechanics.ts` 为准，598 行）：

- workgroup 轮次引擎与动态工作流引擎每执行一个 host member，经 `nodeExecution.ts` 的 `buildNodeExecutionWorkgroupHooks` → 网关 `executeHost` →
  `AgentSingleNodeExecutor.executeHost` → `legacyHostPort` → `N` 的 `executeWorkgroupHostMechanics(state, host, collaboration)`（`N:49-548`，500 行）。
- 主体：注入（orchestrator 合成 / 资源会话）失败时直接 pending → failed；`runAssembly`（iso 以 host run id 建树，`persistBase: 'in-setup'`）里 spawn
  依次做 runtime 冻结、按 run shard 取 clarify 队列（RFC-172）、host 端口投影（RFC-184）、`runNode`、早退结局（canceled、clarify 停靠与两次压制
  检查 RFC-181 / 207、非 done）；合并相位分 park / `discardWrites` abandon（RFC-167）/ passthrough / merge；冲突 abandon（RFC-187 T8）、抛出保留
  iso 并重抛（RFC-210）；最后 settle。它是 RFC-287 收编进 `runAssembly` 的五条装配线之一（L1）。
- `buildWorkgroupEngineSupport`（`N:550-575`）为两类引擎补 `broadcastNodeStatus` 与 canonical delta 计数（RFC-187 §4），只有 `nodeExecution.ts` 使用。
- `N` 还导出别名 `SchedulerState = TaskMechanicsState`、`OneNodeResult = NodeMechanicsResult`，被 `wrapperMechanics.ts`、`wrapperRunLifecycle.ts`、
  `executionMergeRecovery.ts` 引用；文件尾部是描述早已迁走代码的注释。
- `N` 是 off-DAG offered 账本上 `nodeMechanics.ts → collaboration` 一条的来源（host 主体引用 collaboration 的 runtime 合同类型）。

## 2. 目标

- **G1 host lane 迁入 engine**：主体迁入 `engine/node/agent-single/runWorkgroupHost.ts`，`AgentSingleNodeExecutor` 的 DAG lane 与 host lane 都经同一组
  显式端口直接执行；`legacyHostPort` 与执行器的 host 构造参数删除。
- **G2 删除 `nodeMechanics.ts`**：`buildWorkgroupEngineSupport` 并入 `nodeExecution.ts` 的引擎钩子装配；两个别名退役，使用方改用 `TaskMechanicsState`
  与 `NodeMechanicsResult`；design §5.5 第 5 步退出门「`nodeMechanics.ts` 删除」成立。
- **G3 不新增跨层依赖**：host 新增的能力沿用 RFC-405 的 task-execution 自有结构类型，端口不 import `services/` 或 collaboration；`N` 删除后
  off-DAG 账本的 `nodeMechanics.ts → collaboration` 一条随之销账。
- **G4 守卫不缩**：按 `N` 路径或 `executeWorkgroupHostMechanics` 取语料的守卫精确改指；RFC-317 allowTerminal 账本与偏离账本随站点迁移；RFC-403～405
  结构锁里针对 `N` 的判据改为「文件不存在且不得重建」；Windows 两份 `paths:` 同步；账本按实测更新，只降不升。
- **G5 纯结构**：注入失败、iso、runtime 冻结、clarify 队列、端口投影、运行请求、早退结局、clarify 落库与压制补偿、合并处置与结局的顺序与文本都不变。

## 3. 非目标

- design §5.5 第 4 步（`wrapperMechanics.ts` 的 fanout 装配线、`taskEngineApplication.ts` 的引擎编排）与第 5 步其余退出门（`TaskMechanicsState` 只留
  装配、协调器只在 bootstrap 构造）。
- workgroup 轮次引擎与动态工作流引擎本身的迁移（design §5.2 的「迁出 resource-catalog / services」另立 RFC）。
- `services/` 纯判定与常量的归属迁移（本次经端口注入）；`runNode` family、runtime driver、资源注入的实现改动。
- 安全相关改动。

## 4. 用户可见变化

无。HTTP / MCP / WS 合同、数据库结构、prompt 文本、发布二进制的行为均不变。

## 5. 验收标准

- **AC-1 迁移**：host 主体在 `engine/node/agent-single/`，只 import RFC-403 允许的层，不引用 `TaskMechanicsState`；执行器两条 lane 都直接调主体；
  `legacyHostPort`、`nodeMechanics.ts`、两个别名不存在（结构锁锁定，含负例）。
- **AC-2 端口**：host 新增的能力（合成注入、clarify 压制查询与补偿遣散、带 allowTerminal 的状态写、merge-state abandon、canonical 挂载路径、
  `clarify-forbidden` 前缀）由绑定接入，端口与运行历史读取不 import `services/` 或 collaboration。
- **AC-3 行为不变**：RFC-164 / 167 / 172 / 181 / 184 / 187 / 207 / 210 / 369 的 workgroup 与动态工作流用例、RFC-287 T1 / T9 的 L1 线、
  workgroup host 输出隔离、P0 变异 lane 全部通过，断言意图不变。
- **AC-4 守卫**：RFC-317 站点 / 偏离 / allowTerminal 账本、RFC-334 边界、RFC-294 offered-edge 债务账本随 owner 改指或销账；新结构锁覆盖 host 主体
  owner、执行器两条 lane、删除项与别名退役，均带负例。
- **AC-5 账本**：`architecture/counts.json`、`commons-debt.json`、`guard-manifest.json`、Windows `paths:` 按完整候选实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿（含 PostgreSQL 分片、三平台 e2e 与 windows-platform）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **host 主体放在 `engine/node/agent-single/`**：host lane 是 agent-single 执行器的第二条 lane（`AgentNodeExecutor` 继承
   `WorkgroupHostExecutionPort`），两条 lane 共用一组端口；不另开 `engine/node/workgroup-host/` 目录或 registry key。
2. **一组端口服务两条 lane**：在 RFC-405 的 `AgentNodeExecutionPorts` 上补 host 才用的少数能力，不复制第二套绑定。
3. **主体改名 `runWorkgroupHost`**：与 `runAgentSingleNode`、`runScriptNode` 一致；闭包状态（`keepHookIso`、`hookIso`、`iso`）原样搬入，不另造状态对象。
4. **orchestrator 合成注入的分支放在绑定**（`resources.hostInjection(agent)`）：选择合成还是资源会话是资源解析策略，引擎只读注入结果。
5. **`clarify-forbidden` 前缀经 `rules` 端口传入**：常量仍在 `services/envelope.ts`，engine 不 import `@/services`。
6. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」。
