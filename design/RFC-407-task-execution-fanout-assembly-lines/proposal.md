# RFC-407 task-execution fanout 分片与聚合装配线迁入 engine/node（RFC-294 S6，design §5.5 第 4 步之一）

- **状态**：Done（2026-11-01；AC-6 以后继 CI 证据关闭，见 plan「CI（AC-6）」）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你
  可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，
  无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6；design §5.2、§5.5 第 4 步
- **前序**：[RFC-405](../RFC-405-task-execution-agent-single-executor/proposal.md)、[RFC-406](../RFC-406-task-execution-workgroup-host-executor/proposal.md)
- **落位**：task-execution `engine/node/agent-single/`（两条 fanout 装配线与 `FanoutAttemptPort` 的实现）、`application/ports`（agent 执行端口补 fanout
  能力）、`composition/`（端口绑定）

## 1. 背景

design §5.5 第 4 步要迁 `wrapperMechanics.ts` 的 fanout 分片与聚合装配线、`taskEngineApplication.ts` 的引擎编排。两件事互不依赖，本 RFC 只做前一件；
引擎编排另立 RFC。

现状（行号以 RFC-406 落库后的 `W` = `TE/composition/wrapperMechanics.ts` 为准，1954 行）：

- fanout 策略（`engine/wrapper/fanoutStrategy.ts`）经 `FanoutAttemptPort` 派发分片与聚合；端口由 `W` 的 `createWrapperMechanicsPorts` 绑定到 `W` 内的
  `dispatchFanoutShard` / `dispatchFanoutShardAttempt`（`W:525-1089`）与 `dispatchFanoutAggregator` / `dispatchFanoutAggregatorAttempt`（`W:1090-1616`），
  两者都直接读 `TaskMechanicsState`。
- 两条线是 RFC-287 收编进 `runAssembly` 的五条装配线中的 L5 / L6（另外三条 L1 workgroup host、L4 agent-single、L7 script 已在 engine）：外层按全局
  重试预算重试，单次 attempt 依次做候选行选择与跨代复用（RFC-098 B3、RFC-370 中断合并补完、RFC-130 D9 撤销基线）、铸行、输入组装（广播 + 分片值、
  边界端口 kind）、资源注入、prior output（仅聚合）、`runAssembly`（`pools: [agentSem, subprocessSem]`、`persistBase: 'in-setup'`、合并处置、未兜住
  的抛出改判为带重试载荷的失败）。
- 两条线读 `services/ref/runtimeRef` 的 `fanoutInnerAgentRefKey`、`util/hash` 的 `sha256Hex`、`composition/executionMergeRecovery` 的
  `completeInterruptedMerge`、`infrastructure/isolationWorkspaceView` 的 `workspaceRecord`，以及 RFC-405 已经端口化的那批能力（运行、台账、工作区、
  冲突解析、状态广播、运行历史读取）。

## 2. 目标

- **G1 两条装配线迁入 engine**：主体在 `engine/node/agent-single/`（与 L1 / L4 同目录、同一组端口），`FanoutAttemptPort` 的实现在 engine，
  `createWrapperMechanicsPorts` 只用端口绑定构造它；两条线不再读 `TaskMechanicsState`。
- **G2 端口不新增跨层依赖**：fanout 才用的能力（subprocess 池、分片值哈希、fanout agent 键、中断合并补完、工作区记录、候选行选择读取）沿用
  RFC-405 的 task-execution 自有结构类型补进端口，由绑定接入现有实现；不新增 R2 边或 off-DAG 文件边。
- **G3 守卫不缩**：按 `W` 路径或 `dispatchFanout*` 函数名取语料的守卫（RFC-287 T1 / T3 / T4 / T9 / T14、RFC-188、RFC-208、RFC-098 B3、RFC-130、
  RFC-370、RFC-394 等）精确改指；按显式文件清单做缺席扫描的守卫把新 owner 加进清单（RFC-406 记下的教训）；账本只降不升。
- **G4 纯结构**：候选选择、复用与重跑判定、铸行身份、输入与 kind、注入失败、prior output、装配相位、合并处置、重试载荷与 fail-all-after-join 语义
  的顺序与文本都不变。

## 3. 非目标

- `taskEngineApplication.ts` 的引擎编排（另立 RFC）；`createWrapperMechanicsPorts` 的 data / scopeDriver / workspace 绑定与 git wrapper 的工作区
  helper（`createOrRebuildWrapperIso`、`mergeBackWrapperIso` 等，留待引擎编排或工作区端口的 RFC）。
- fanout 策略本身（`engine/wrapper/fanoutStrategy.ts`）的任何改动。
- `services/` 纯判定的归属迁移（经端口注入）。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：两条装配线的主体与 `FanoutAttemptPort` 实现在 `engine/node/agent-single/`，只 import 允许的层；`W` 中不再有 `dispatchFanout*`
  （结构锁锁定，含负例）。
- **AC-2 端口**：新增能力由绑定接入，端口与运行历史读取不 import `services/` 或其他 context。
- **AC-3 行为不变**：RFC-060 / 094 / 098 / 103 / 119 / 130 / 287 / 354 / 370 的 fanout 用例（复用、重跑、fail-all、聚合 prior output、中断补完）、
  P0 变异 lane 全部通过，断言意图不变。
- **AC-4 守卫**：RFC-317 站点 / allowTerminal 账本、RFC-328 账本、RFC-334 边界随 owner 改指；新结构锁带负例。
- **AC-5 账本**：counts / commons-debt / guard-manifest / Windows paths 按实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **放在 `engine/node/agent-single/`**：L5 / L6 与 L1 / L4 一样是 agent 运行的装配线，共用一组端口；fanout 策略仍在 `engine/wrapper/`，只经
   `FanoutAttemptPort` 调它们。
2. **函数名不变**：`dispatchFanoutShard(Attempt)` / `dispatchFanoutAggregator(Attempt)` 保留，RFC-287 系列守卫的签名锚点不必改。
3. **闭包状态原样搬入**：各自的 iso 句柄、撤销基线、复用判定等局部状态留在函数里，只做端口替换。
4. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」（`sourcePortKindOf` 放在绑定而非 application 等）。
