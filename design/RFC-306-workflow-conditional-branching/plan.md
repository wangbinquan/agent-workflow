# RFC-306 工作流条件分支 —— 任务分解

> 读法：`proposal.md`（行为规格）→ `design.md`（技术设计）→ 本文（怎么切、怎么验）。
> 本仓主干开发：每个 PR 直接提交 `main`，提交前跑 `bun run gate:local`，推后按 exact SHA 查 CI。

## 1. PR 拆分与依赖

```
PR-A 契约与纯函数 ──┬─→ PR-B 线协议（解析 / 入库 / prompt / script）
                    ├─→ PR-C 调度集成（判定 / 传播 / 结算口径 / T3）──┬─→ PR-D 容器边界与循环
                    │                                                  └─→ PR-F 强制执行
                    └─────────────────────────────────────────────────→ PR-E 前端与 e2e
```

- PR-A 必须先落（其余全部依赖 shared 契约与判定函数）。
- PR-B 与 PR-C 可并行（前者动 runner/envelope，后者动 scheduler/freshness），但**合并顺序 B → C**：
  C 的端到端测试需要 B 的解析与入库。
- PR-E 依赖 A（契约）+ C（轨迹查询），e2e 用例依赖 D。
- 单个 PR 内必须自带对应测试（CLAUDE.md §Test-with-every-change，无「先实现后补测试」）。

## 2. 任务清单

### PR-A —— 契约与纯函数（无行为变化）

- **T1** `schemas/agent.ts`：`branchPorts?: string[]` sidecar + `frontmatter_extra` 存取路径
  （agent.ts 的 fmExtra 合并段，`services/agent.ts:216-285` / `:444-461`）+ agent.md 导入导出往返。
- **T2** `schemas/workflow.ts`：`ScriptOutputPortSchema.branch?: boolean`（`.strict()` 必须显式加）；
  导出 `JoinModeSchema`。
- **T3** `nodePorts.ts`：`DeclaredPort.branch?: boolean`，agent / script deriver 填充。
- **T4** `schemas/task.ts`：`RERUN_CAUSES += 'branch-skip'`；新增两个 failure code 常量与前缀。
- **T5** `modules/task-execution/domain/branchActivation.ts`：`resolveNodeActivation` 判定表实现。
- **T6** `EdgeActivation` 落 `domain/branchActivation.ts`；`BranchTrace` 落 `shared/schemas/task.ts`
  （前端要渲染它；模块 public 面不得出现基础设施类型——见 design §1.1）。
- **T7** 测试：`branchActivation.test.ts` 判定表逐行 + 契约往返（agent YAML / workflow YAML）。

### PR-B —— 线协议

- **T8** `services/envelope.ts`：`PORT_OPEN_RE` 容纳属性；`ACTIVE_ATTR_RE`；
  `EnvelopeParseResult += { inactivePorts, badActiveAttr }`；**同步修**吸收检测正则（`envelope.ts:461-466`）。
- **T9** `services/runner.ts`：声明对账 + 两个 failure code（先于 per-kind 校验与入库）；
  不激活端口跳过 RFC-049 校验与 RFC-193 归档；`RunResult.inactiveOutputs`。
- **T10** migration `0172_rfc306_port_activation.sql`：`node_run_outputs.active` + `node_runs.force_activated`；
  drizzle schema 同步（`db/schema.ts:1995-2019` / `node_runs`）。
- **T11** 入库写 `active`（`runner.ts:2071-2097`，含 onConflictDoUpdate 分支）。
- **T12** `shared/prompt.ts`：分支端口协议段 + 两条 followup repair 文案；
  `decideEnvelopeFollowup`（`scheduler.ts:1656`）纳入新家族。
- **T13** `services/scriptPorts.ts`：越权 / 非法属性拒绝（严格性其余不变）。
- **T14** 测试：`envelope-branch-attr.test.ts`（§13 全部变体）；runner 对账红→绿；script 侧同形用例；
  prompt 协议块快照。

### PR-C —— 调度集成

- **T15** `services/freshness.ts`：`pickUpstreamSourceRun` / `buildFreshestDonePerNode` 扩为
  done ∪ skipped（后者更名 `buildFreshestSettledPerNode`，**6 处**生产调用点一次改完，不留别名）。
- **T16** `scheduler.ts`：抽 `collectDataflowInboundEdges` 供 `resolveUpstreamInputs` 与判定共用（禁第三份手抄）。
- **T17** `modules/task-execution/application/resolveNodeActivation.ts`：DB 侧求值（§5.2）。
- **T18** `runOneNode` 顶部判定 + mint `skipped` 行（cause `branch-skip`，写 consumed provenance）+ WS 广播。
- **T19** `deriveFrontier`：skipped ∧ fresh 进 `completed`；blocked 诊断 reason 更新。
- **T20** `dispatchFrontier.ts`：`isDispatchable` 的 `skipped` 分支改为 stale 重评估 + 注释重写。
- **T21** `resolveUpstreamInputs` / `readPortRowAtIteration`：返回并消费 `active`；理由文本不入 prompt。
- **T22** output 节点投影写 `active=0`（`scheduler.ts:5644-5700`）。
- **T23** `lifecycleInvariants.ts` checkT3 放宽为 done ∨ skipped（保留 failed/缺行仍报 finding）。
- **T24** 测试：传播 + 任务 done、**golden lock（无分支端口零变化）**、joinMode any/all、
  stale 推翻、review 跟随跳过、T3 正反例。

### PR-D —— 容器边界与循环

- **T25** wrapper-loop 出口继承（`upsertWrapperOutput` 带 active）。
- **T26** wrapper-fanout：分片判定 + **聚合输入过滤**（`dispatchFanoutAggregator`），失败语义不变。
- **T27** call-workflow / call-workgroup 端口投影继承。
- **T28** `exitCondition.ts`：新增 `port-inactive`；`evaluateExitCondition` 改签名为 `ExitPortValue`；
  §8 判定表；`runLoopWrapperNode` 调用点改读 `readPortRowAtIteration`。
- **T29** 验证器新规则：`join-mode-invalid` / `branch-port-unknown` / `exit-condition-port-not-branch`。
- **T30** 测试：loop 逐轮重算、四种退出条件矩阵、fanout 活跃分片聚合、call 继承、验证器规则红绿。

### PR-E —— 前端与 e2e

- **T31** `modules/task-execution/application/branchTrace.ts`：`getTaskBranchTrace` 挂到既有
  `GET /api/tasks/:id/node-runs` 响应上（复用其 WS 失效），不新开端点。
- **T32** 画布：`nodeStatuses` 支持 `'skipped'`；`inactiveEdgeIds` → `canvas-edge--inactive`；
  分支端口 handle 视觉（复用 signal 语言，新增 `--branch` 变体）。
- **T33** 端口配置「分支端口」开关（`AgentPortDialog` / `OutputsEditor` / script 面板），公共 `<Switch>`。
- **T34** `NodeInspector` 的 `joinMode`，用 `.segmented`。
- **T35** 节点表 `skipped` chip + Outputs 区「未激活 + 理由」展示。
- **T36** i18n 双语；视觉对齐自查（与 `/workflows`、`/tasks` 现有页 side-by-side）。
- **T37** e2e：判定 → 两条互斥链 → 两个 output，断言只跑一条、任务 done、另一条置灰。

### PR-F —— 人工强制执行

- **T38** `services/task.ts retryNode` 接受 `skipped` 目标，写 `force_activated=1`；
  `nodeRunMint` 继承该标志。
- **T39** 判定读 `forceActivated`（§5.1 首行）。
- **T40** 前端「仍然执行」入口 + i18n。
- **T41** 测试：强制执行后节点真跑、下游按真实输出重新判定、非 skipped 节点行为不变。

### 收尾

- **T42** `docs/dev-gotchas.md`：补「端口读点必须走结算口径（done ∪ skipped），否则会读到被关闭分支的陈旧
  内容」这条通用坑。
- **T43** `design/plan.md` RFC 索引状态改 Done；`STATE.md` 进行中 → 已完成条目。

## 3. 验收清单（对应 proposal §7）

| AC               | 验证方式                                       | 归属        |
| ---------------- | ---------------------------------------------- | ----------- |
| AC-1 / AC-2      | 调度端到端测试                                 | PR-C        |
| AC-3 golden lock | 既有 scheduler 套件全绿 + 专门的无分支快照用例 | PR-C        |
| AC-4             | runner 单测（两个 failure code + followup）    | PR-B        |
| AC-5             | joinMode 矩阵测试                              | PR-C        |
| AC-6             | loop / call 继承测试                           | PR-D        |
| AC-7             | fanout 聚合过滤测试                            | PR-D        |
| AC-8             | 退出条件矩阵                                   | PR-D        |
| AC-9             | review/clarify 跟随跳过测试                    | PR-C        |
| AC-10            | stale 推翻测试                                 | PR-C        |
| AC-11            | 强制执行测试                                   | PR-F        |
| AC-12            | 不变量正反例                                   | PR-C        |
| AC-13            | 前端组件测试 + e2e                             | PR-E        |
| AC-14            | 端口配置往返（含 YAML）                        | PR-A / PR-E |

## 4. 风险与对策

| 风险                           | 影响                                             | 对策                                                                                            |
| ------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 结算口径改动（§6.1）波及面广   | 输入解析 / freshness / wrapper consumed 三处语义 | 先跑全量 scheduler 套件当基线；改动后逐套件对比；无 skipped 行时两口径等价，用 golden lock 钉死 |
| envelope 正则放宽误伤          | 端口内容里出现 `<port name=…` 的既有容忍行为     | 只放宽属性段，不动结构化闭合扫描；补「内容含伪端口标签」的既有用例                              |
| 判定与输入解析的边投影分叉     | 判定说激活、输入读不到（或反之）                 | T16 强制两处共用一个 helper；加一条「两处调用同一函数」的源码层文本断言                         |
| skipped 行导致 frontier 死循环 | 任务空转                                         | skipped 必须写 consumed provenance（T18）；补一条「跳过后不再重复调度」的用例                   |
| 前端自行重算判定               | 前后端结论漂移                                   | 轨迹只由 `getTaskBranchTrace` 下发；前端不实现判定逻辑（加源码层断言）                          |

## 5. 提交纪律

- 每个 PR：`bun run gate:local` 全绿 → `git pull --rebase` → `git push origin main` → 按 exact SHA 查 CI。
- commit message 前缀：`feat(task-execution): RFC-306 …` / `feat(shared): RFC-306 …`。
- 多人并发树：按路径精确 `git add`，不动他人未追踪文件（CLAUDE.md §Multi-person collaboration）。
