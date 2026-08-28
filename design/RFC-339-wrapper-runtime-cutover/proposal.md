# RFC-339 — WrapperRuntime 归位与 wrapper/replay mechanics cutover（RFC-294 W2-D）

- 状态：In Progress（2026-08-28 用户已批准 D1～D10 与 T2～T11；设计批次先发布，production 实施随后启动）
- 发起：RFC-294 W2-D successor，2026-08-28
- source pin：`251b5d725ef731d15c17a01656fdc827f925e7c7`
- canonical architecture payload / provenance pin：`15767cfc9066fcdb9f074b1e93ab182699ba4fc0` →
  `251b5d725ef731d15c17a01656fdc827f925e7c7`
- canonical source digest：`sha256:ee9c5632c10a4fbd6fc2460e63db8d8f2fb73b2ed2f820183b116389f4a17607`
- 前置：RFC-328（durable execution authority）、RFC-331（W2-A）、RFC-332（W2-B）、
  RFC-333（P0-C）、RFC-334（W2-C）均已完成
- 授权边界：用户已批准完整实施；本 RFC 只关闭 W2-D，不自动授权 W3 以后 wave

## 0. 终态一句话

把现在仍寄居在 `services/scheduler.ts` 的 loop/git/fanout 外层运行时、wrapper 进度与 merge replay
归回 `task-execution`，形成一个 closed `WrapperRuntime`：三种 wrapper 共用唯一 generation/lifecycle/park/terminal
模板，各 strategy 只保留自己的循环、Git 和 fanout 差异；所有现有功能、持久化行、恢复语义和错误结果逐字保持。

```text
TaskEngine / taskDagScope
          │ ready wrapper node
          ▼
NodeExecutionGateway
          │ closed wrapper kind
          ▼
WrapperRuntime
  ├── LoopStrategy
  ├── GitStrategy
  └── FanoutStrategy
          │
          ├── WrapperScopeDriverPort ─► taskDagScope（运行时递归，源码不成环）
          ├── WrapperRunLedgerPort ──► node_runs / outputs / progress
          ├── WrapperWorkspacePort ──► isolation / snapshot / merge / discard
          └── FanoutAttemptPort ─────► 当前 shard / aggregator execution assembly
```

## 1. current-source 事实

### 1.1 当前真正的生产路径

RFC-334 已把所有 ready node 切进 closed `NodeExecutorRegistry`，但三个 wrapper entry 仍是委托壳：

```text
taskDagScope.executeNode
  → NodeExecutionGateway
  → WrapperDelegatingNodeExecutor
  → WrapperNodeExecutionPort
  → nodeExecution.ts 中的三分支
  → services/scheduler.ts.runWrapper{Loop,Git,Fanout}Node
```

因此 W2-C 已经完成“谁选择 node executor”，W2-D 仍要完成“谁拥有 wrapper runtime”。二者不能合并记账。

### 1.2 精确库存

| 项目                     | current source 事实                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wrapper kind             | 恰好 `wrapper-loop` / `wrapper-git` / `wrapper-fanout` 三种；以 shared `WRAPPER_NODE_KINDS` 为事实源                                                    |
| legacy owner             | `packages/backend/src/services/scheduler.ts` 共 3,816 行                                                                                                |
| wrapper/replay 连续区域  | `scheduler.ts:507-3643`，约 3,137 行，含 replay、common shell、loop、fanout shard/aggregator、git wrapper                                               |
| W2-D canonical symbols   | 10 个：`replayPendingMerges`、`replayConflictHumanResolutions`、三条 public wrapper entry、三条 wrapper body/dispatch family 与 common `runWrapperNode` |
| standalone wrapper files | `services/wrapperProgress.ts` 148 行；`services/fanout.ts` 193 行                                                                                       |
| W2-C → W2-D bridge       | `nodeExecution.ts` 对 scheduler 的 3 条 value import                                                                                                    |
| W2-B → W2-D bridge       | `taskEngineApplication.ts` 对 scheduler 的 2 条 replay import；`startTaskDeps.ts` 对 internal `driveTaskEngineApplication` 的 1 条 import               |
| legacy reverse edge      | scheduler 对 `task-execution/composition/nodeMechanics` 的 17 条 exact import（13 value + 4 type）                                                      |
| adjacent internal edge   | scheduler 对 `task-execution/domain/sourceTermination` 的 2 条 exact import；为满足“scheduler 零 task internal”需同批改走 public contract               |
| value SCC                | backend/repository 当前为 `4/6`；四个 backend SCC 中没有 task-execution/scheduler family，W2-D 不得重复声称再消除一个不存在的 task SCC                  |
| canonical debt           | `KNOWN_VIOLATIONS=31`；first-party unresolved=0；W2-D 不新增 KNOWN/exception                                                                            |

当前 `4/6` SCC 分别属于 MCP/server、agent、git/cache 与 workflow validator 等其他 family。RFC-294 旧 W2-D
退出门里“再销一个 task SCC、再做一次 `37→31`”已被当前事实淘汰；本 RFC 改用 exact edge extinction 与
“task-execution 继续不进入 SCC、全仓 `4/6` 不上升”作为诚实门槛。

### 1.3 三种 wrapper 的当前能力

| 能力面               | current 行为                                                                                                                | W2-D 必须保持                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| common row lifecycle | fresh mint / resumable row、consumed provenance、running、park、terminal、外部终态抢先收敛                                  | 状态、cause、iteration、message、广播顺序与 superseded 结果不变                          |
| loop                 | 持久 iteration；递归 drive scope；exit condition；output binding；max/exhausted/continue policy                             | 同一恢复 iteration、同一退出判断、同一 output 与 exhausted 语义                          |
| git                  | wrapper-private canonical；逐仓 baseline/preDirty；inner scope；`git_diff`；merge/冲突停驻                                  | 在途 progress、multi-repo、只读仓、dirty subtraction、merge-state 与 conflict-human 不变 |
| fanout               | shard source hydration；cartesian cap；scope/auto-promote；deterministic shard key；并发 shard；一次 aggregator；reuse gate | 空输入、失败/cancel、重放、salvage、聚合输出、并发上限与错误码不变                       |
| nesting              | git-in-loop、loop-in-git、fanout 与已允许组合按 shared scope tree 递归                                                      | 合法组合继续可用；既有 validator/runtime 限制不增不减                                    |
| merge replay         | scope 前先 replay pending merge，再收 conflict-human resolution                                                             | pinned tree、submodule topology、physical iso identity、merge agent 与失败结果不变       |
| bootstrap            | 多处 caller 通过 `createLegacyTaskExecutionTopology` 临时自组 driver                                                        | 改为 bootstrap 组一次并显式注入；不引入 global setter/service locator                    |

### 1.4 当前问题不是“文件太长”

1. **owner 方向仍反转**：task-execution 为了跑 wrapper import scheduler，scheduler 又反向 import task-execution internal。
2. **closed registry 只闭合了选择，没有闭合实现**：wrapper kind 有唯一 entry，但真正 body 仍在旧横向 service。
3. **scope 语义仍靠散落的 raw `nodeIds` / `containerOf`**：W7 要持久化 `scopePath`，现在没有一个 runtime 可直接复用的
   container membership 合同。
4. **replay 的位置误导职责**：pending merge 与 human conflict replay 是通用 execution merge recovery，不是某种 wrapper
   strategy；继续留在 scheduler 会让 W3/W5 再次围绕旧 owner 接线。
5. **legacy topology 在每个 caller 自组**：`startTaskDeps.ts` 直接 import internal application，无法形成唯一 module composition。

## 2. 目标

### G1：唯一 WrapperRuntime

三个 wrapper kind 只经一个 closed runtime registry 进入对应 strategy；`scheduler.ts` 不再定义、导出或转发任何 W2-D
symbol，`nodeExecution.ts` 不再 import scheduler。

### G2：公共外壳唯一，差异显式

generation/resume、consumed provenance、running/park/terminal、status publish 与 superseded 收敛只有一个 template。
Loop/Git/Fanout strategy 只声明自己的 prepare/drive/finalize 差异；不做“看似统一、实际改行为”的万能 callback bag。

### G3：scope/container 成为可复用合同

从已经唯一的 `analyzeWorkflowScopeTree` 一次构造 `ExecutionScopeIndex`，明确 direct membership、parent scope、outer→inner
scope path 与 wrapper kind。WrapperRuntime、nested scope drive 与未来 W7 backfill 共用同一语义，不再各自读 raw `nodeIds`。

### G4：replay 回到 execution recovery

pending merge 与 conflict-human resolution 进入 task-execution-owned recovery service，并以 purpose-specific port 复用现有
isolation/merge kernel；TaskEngine 保持“replay 后再 derive frontier”的顺序。

### G5：bootstrap 形成唯一 driver instance

daemon/server/test bootstrap 构造 task-execution runtime，向现有 launch/continue caller 注入窄 `SchedulerDriverPort`；删除
`createLegacyTaskExecutionTopology` 与 `startTaskDeps → internal composition` import。不以 public re-export 或 global memo 把债改名。

### G6：功能零折扣

不新增安全策略、权限、拒绝、限制或 feature flag；不删除任何正常能力。所有当前 wrapper、嵌套、恢复、并发、输出、错误、
在途 row 与 UI/API 可见结果都是兼容 oracle。

## 3. 非目标

- 不实现 RFC-289 已关闭方案，也不扩张 fanout inner-chain；该能力只有 W7 后另立可选 W8 successor 才能批准。
- 不把 `call-workflow` / `call-workgroup` 归为 wrapper；不把 workgroup assignment/round state 写入 WrapperRuntime。
- 不新增 NodeKind、WrapperKind、workflow schema、DB migration、status/error/config、REST/MCP/WS/UI 字段。
- 不实现 W3 committed events/common continuation，不迁 W5 commit-push/completion，不落 W7 NodeRun v2 列。
- 不重写 RFC-287 `runAssembly`、RFC-188 isolation/merge kernel、runtime driver 或 node executor mechanics。
- 不为目录整洁改写用户可感知的重试、停驻、merge、失败或并发语义。

## 4. 设计裁决

### D1 — closed runtime registry

`WrapperRuntime` 的 key 集与 shared `WRAPPER_NODE_KINDS` 完全相等；每个 strategy 自报同一个 kind。新增/删除 kind 必须同时
更新 shared catalog、runtime registry、capability/park matrix 与测试，不允许 default branch。

### D2 — common lifecycle template，不做万能策略

template 只拥有 wrapper row 的 generation/open/running/park/terminal/publish/superseded；strategy 拥有业务差异。Git merge、
fanout shard/aggregator、loop exit 不被抽成一组含糊可选 callback。

### D3 — purpose-specific ports

WrapperRuntime 只依赖具名 `WrapperRunLedgerPort`、`WrapperScopeDriverPort`、`WrapperWorkspacePort`、
`WrapperDataPort`、`FanoutAttemptPort` 与 `WrapperStatusPublisherPort`。没有 `DbClient`、`SchedulerState`、`AppDeps`、任意
`Record<string,unknown>` capability bag 或按名字查服务的 locator。

### D4 — 一次构造 ExecutionScopeIndex

TaskEngine 在 snapshot admission 后从 shared scope analysis 构造 index；runtime request 携准确 descriptor。path 为 outer→inner
有序 wrapper segment，direct child 只属于一个 parent；invalid duplicate/missing/multi-parent/cycle 仍在任何执行前失败。

### D5 — Loop/Git 先迁，Fanout 只迁 outer shell

Loop 与 Git 先验证 common template；Fanout 随后迁当前 outer shell、shard 与 aggregator mechanics。Fanout 内任意 chain/非
`agent-single` 执行仍保持当前不支持结果，不借本 RFC 扩能力。

### D6 — merge replay 不属于 WrapperStrategy

两条 replay 进入 `ExecutionMergeRecovery`，由 TaskEngine application 在 root scope 前调用。它们可以复用 wrapper/agent 共用的
workspace port，但不会成为第四个 wrapper kind，也不会挂到 registry。

### D7 — bootstrap 注入，不做 public/internal 换皮

`server.ts`、`cli/start.ts` 与 test composition 构造 runtime/driver；`buildStartTaskDeps` 接收已构造 driver。不得通过
`public/commands.ts` 简单 re-export internal `driveTaskEngineApplication` 来伪造边界，也不得新增进程全局 setter。REST/MCP route mount
只接受同一 bootstrap runtime 形成的必填 driver/read-model dependency；direct dispatcher test 也必须显式走 test composition。

### D8 — per-kind 原子 cutover

先增加无 production caller 的 contract/template/characterization；每个 kind 切换时同一 commit 接新 entry 并删除对应旧 body。
最终同批删除三条 bridge、两条 replay bridge、legacy topology bridge 与 scheduler reverse imports。没有 dual dispatch、shadow row、
runtime fallback 或 feature flag。

### D9 — persisted compatibility

`wrapper_progress_json`、`merge_state`、iso columns/path/ref、output row、cause/status/error 全部保持当前 codec 与物理语义；旧进程
留下的 loop/git/fanout row 必须由新 runtime 原位续跑。纯 codec 可以搬 owner，但 wire 与容错行为不变。

### D10 — 功能优先

实现门只检查功能正确性、模块边界和迁移完整性。发现设计必须增加拒绝、限制或删减正常能力时立即停止并重新呈批；不得以
安全、整洁或“更保守默认”为理由自行改变功能。

## 5. 能力影响清单

本 RFC 的批准目标是 **零外部能力变化**：

| 能力                                             | 影响                            |
| ------------------------------------------------ | ------------------------------- |
| 创建/编辑既有三种 wrapper                        | 不变                            |
| 合法 wrapper nesting                             | 不变                            |
| loop exit/max/continue                           | 不变                            |
| git diff/merge/conflict-human/multi-repo         | 不变                            |
| fanout empty/shards/aggregator/concurrency/reuse | 不变                            |
| review/clarify/questions 在 wrapper 内停驻续跑   | 不变                            |
| cancel/retry/daemon restart/merge replay         | 不变                            |
| REST/MCP/WS/UI/schema/config                     | 不变                            |
| fanout inner-chain                               | 仍不新增；不是本 RFC 的能力收缩 |

## 6. 验收标准

- **AC-1**：source-lock 固定 source pin、3 个 wrapper kind、10 个 W2-D scheduler symbol、6 条正向 bridge 与 17 条
  scheduler→nodeMechanics reverse import；任一 drift 先重采 RFC，不带着旧库存实施。
- **AC-2**：WrapperRuntime registry key/self-kind 与 `WRAPPER_NODE_KINDS` 双向相等；missing/extra/wrong-kind mutation 必红。
- **AC-3**：`nodeExecution.ts` 只调用 WrapperRuntime，不 import scheduler；三个 wrapper 只有一个生产 entry。
- **AC-4**：common lifecycle template 对 fresh/resume/running/park/terminal/superseded 各只有一个 owner；三种 strategy 的
  wrapper row status、cause、message 与 publish ordering 对拍 current oracle。
- **AC-5**：Loop 的 iteration resume、exitCondition、outputBindings、max exhausted/continue 与嵌套行为全部保持。
- **AC-6**：Git 的 wrapper-private canonical、逐仓 baseline/preDirty、`git_diff`、multi-repo、readonly、merge/park/discard 与
  malformed progress fallback 全部保持。
- **AC-7**：Fanout 的 hydration、split、cartesian cap、scope promotion、deterministic shardKey、并发池、retry/reuse、salvage、
  aggregator 与 empty-source 全部保持；inner-chain 不被开启。
- **AC-8**：ExecutionScopeIndex 是 runtime 唯一 membership/path owner；wrapper body 不再读取 raw `nodeIds` 构造第二张
  containment map；未来 W7 可直接复用其 outer→inner path。
- **AC-9**：pending-merge replay 与 conflict-human completion 只经 ExecutionMergeRecovery；顺序保持 pending merge → human
  resolution → root scope，submodule/physical iso/pinned tree/merge-agent 行为不变。
- **AC-10**：新 runtime/engine/domain 文件不 import scheduler、DB schema、Hono、WS、AppDeps 或 LegacyTaskMechanicsState；
  concrete DB/FS/Git/process 只在 adapter/composition 边缘。
- **AC-11**：`services/scheduler.ts` 不再定义 10 个 W2-D symbol，不 import task-execution internal；仍属 W3/W5 的 status、
  commit-push 等 symbol 不被本 RFC 越权迁移或改行为。
- **AC-12**：`createLegacyTaskExecutionTopology` 与 `startTaskDeps → taskEngineApplication internal` import 归零；bootstrap 构造的
  driver 经显式依赖抵达所有 launch/resume/retry/question/review/workgroup/development caller。
- **AC-13**：当前 W2-D exact bridge/reverse family 全部从 canonical exceptions 删除；不新增 KNOWN/exception 抵账。
- **AC-14**：task-execution/scheduler 不进入 value SCC；backend/repository SCC 不高于 current `4/6`。不再虚报不存在的
  `4/6→3/5` task-family credit。
- **AC-15**：`wrapperProgress` 与 fanout pure logic 迁入 target owner，legacy service 文件/转发 facade 为 0；codec golden 不变。
- **AC-16**：无 migration、wire/schema/status/error/config/UI/permission/safety policy 变化；现有用户旅程和能力矩阵不变。
- **AC-17**：切换过程没有 production dual dispatch、double row/WS、feature flag 或 legacy fallback；在途 persisted row 可跨版本
  原位继续。
- **AC-18**：targeted wrapper/replay/architecture/canonical corpus、exact-SHA main CI 与实施完成时仓库内全部 scheduled workflow
  均 terminal success 后才可置 Done；queued/cancelled/ancestor run 不算证据。

## 7. 批准记录

2026-08-28，用户明确要求“先把设计文档提交上库，然后完整实现RFC，并提交上库”，据此批准 **D1～D10 与
plan.md T2～T11**。本批准只关闭 RFC-294 W2-D，不自动批准 W3、W4、W5、W6、W7、W8 或 W9。
