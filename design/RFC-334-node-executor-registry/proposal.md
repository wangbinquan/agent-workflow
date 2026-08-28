# RFC-334：NodeExecutorRegistry（RFC-294 W2-C）

> 状态：Done（2026-08-28；T0～T12 全部完成，RFC-294 W2-C 已关闭；W2-D 未授权、未启动）
>
> 架构位置：RFC-294 W2-C；承接已完成的 RFC-328 durable execution authority、RFC-331 W2-A topology、
> RFC-332 W2-B TaskEngine/DAG owner 与 RFC-333 P0-C。只领取 node/workgroup-host mechanics 与 neutral
> retry-cap contract；不领取 W2-D WrapperRuntime、W3 committed events、W4 public facade、W5 completion 或 W9 config credit。
>
> 调研基线 pin：`0d296ff1bd72a7bf1e3fef8bcc506fa511e11b34`；以下 historical `file:line` 锚仍按该 committed
> blob 对账。W2-C production payload/provenance 为
> `1271ecb20ab1fdd1b58bc2903d4ddbc4c2d92e4e` → `cfe1326b4e948c24772b06708f91e2526ba7022b`，canonical source
> digest 为 `sha256:4d0850a7315ac0064fc244ae9d040c92302d2d1d72f6ff5e5ed10eefae3c877e`。最终功能验收 SHA
> `8e58eb05f987bcf08007db714119b3f46d519772` 的主 CI `33142147682`（attempt 2）为 35/35 terminal
> `success`；W2-C production-equivalent SHA `0a0df74c4476355cc5d5e5f0fe289f823759a2e1` 的七条 scheduled
> workflow 共 19/19 jobs 全部 `success`。`0a0df74c4` 之后本 RFC 只改 source-lock/CI 测试与文档；其间 RFC-336/337
> 的生产变化属于独立范围，不改变 W2-C candidate-content 结论。

## 1. 摘要裁决

W2-B 已经把任务级 hydrate、claim、engine selection、DAG frontier/scope 与 settle 收进 `task-execution`，但“一个 ready
node 到底怎么执行”仍由 9,000+ 行 legacy `services/scheduler.ts` 决定：

1. `taskDagScope.runScope` 直接 import/call `scheduler.runOneNode`；
2. `runOneNode` 用一条长 `if` 链承载 14 个 `NodeKind` 的 routing、公共 branch prelude、agent retry/session、I/O virtual row、
   review/clarify park、call/script/code-host 与 wrapper delegation；
3. `taskEngineApplication` 的 workgroup/dynamic-workflow 路径直接注入 `scheduler.buildWorkgroupHooks`，其 `runHostNode`
   又复制一条 agent host 的 injection/iso/run/clarify/merge/settle 纵切；
4. shared 已有穷尽的 `NODE_KIND_BEHAVIORS satisfies Record<NodeKind, ...>`，却没有穷尽的 executor registry；新增 kind
   仍可能先被 behavior table 接纳，再到 runtime 才以 `unhandled-node-kind` 失败；
5. RFC-313 的纯 attempt-cap 算术同时被 TaskExecution 与 DigitalEmployee 使用，却仍与 TaskExecution 专属的
   followup/restart 状态一起放在 `shared/prompt.ts`。

RFC-334 的最小充分目标是：建立由 `NodeKind` 闭合驱动的 `NodeExecutorRegistry`，让 DAG node 与 workgroup host 都经
task-execution 的单一 node execution gateway；把真正中性的 retry cap 抽到 `platform/contracts`，把 envelope
followup/restart policy/state 归 task-execution；逐 kind 原子切换并删除 legacy routing/host body。它是**零产品行为变化**的
架构迁移，不借机重写业务规则、增加安全策略或收缩任何正常功能。

## 2. current-source 对账

### 2.1 closed catalog 已有 14 个 kind，但只有 behavior registry

`packages/shared/src/schemas/workflow.ts:36-81` 定义 14 个 `NODE_KIND`，并明确只有 `code-round` 属于
`SYNTHESIZED_ONLY_NODE_KINDS`。`packages/shared/src/node-kind-behavior.ts:92-211` 以
`satisfies Record<NodeKind, NodeKindBehavior>` 穷尽 retry cascade、agent/session 与 settles-without-row 三个维度。

| 分类                           | current members                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user-authored、live（13）      | `agent-single`、`input`、`output`、`wrapper-git`、`wrapper-loop`、`wrapper-fanout`、`review`、`clarify`、`clarify-cross-agent`、`call-workflow`、`call-workgroup`、`script`、`code-host-call` |
| synthesized-only、retired（1） | `code-round`                                                                                                                                                                                  |

`code-round` 留在 closed codec 只为历史 task/read projection 与 daemon restart 时的可理解失败；它不是 active stage engine，也不是
user-authorable kind。

### 2.2 DAG 已归 task-execution，但 node dispatch 仍反向依赖 legacy

- `packages/backend/src/modules/task-execution/composition/taskDagScope.ts:7,194-203` 直接 import/call
  `runOneNode`；
- `packages/backend/src/services/scheduler.ts:4087-4413` 先做 abort/branch prelude，再按 kind routing，最后用
  `unhandled-node-kind` runtime guard；
- `packages/backend/tests/architecture/rfc294Canonical.ts:391-400` 已把 `runOneNode`、`runHostNode`、
  `buildWorkgroupHooks` 精确登记为 W2-C，而 wrapper bodies 精确登记为 W2-D；
- `architecture/cross-context-imports.json` 中 `taskDagScope → runOneNode` 与
  `taskEngineApplication → buildWorkgroupHooks` 是 RFC-332 引入、`removeAfterWave=W2-C` 的两条具名 legacy bridge。

因此 W2-C 不是给现有函数换目录，而是让 task-execution 从 legacy service 反向 import 归零，并让 registry 成为唯一生产
kind selector。

### 2.3 current dispatch inventory

| kind/family                 | current routing/source                                     | 必须保持的功能合同                                                                                 |
| --------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| all row-owning kinds        | `scheduler.ts:4091-4109` abort + RFC-306 branch activation | branch judgment 先于任何 per-kind effect；clarify family继续不铸 branch-skip row                   |
| `output`                    | `scheduler.ts:4111-4178`                                   | virtual done row、端口内容/kind/archive/active 投影、consumed provenance、WS                       |
| wrappers ×3                 | `scheduler.ts:4181-4189` → `runWrapperNode`                | W2-C 只迁 registry arm；loop/git/fanout outer mechanics 原样留给 W2-D                              |
| `review`                    | `scheduler.ts:4191-4209` → `dispatchReviewNode`            | 单/多/空文档、anchor、artifact、atomic park 与 `awaiting_review` outcome                           |
| `clarify`                   | `scheduler.ts:4211-4220`                                   | graph visit no-op；真实 question 仍由 runner-side open 驱动                                        |
| `clarify-cross-agent`       | `scheduler.ts:4223-4338`                                   | live-row idempotency、missing-questioner typed failure、persistent-stop、runner-side common path   |
| `input`                     | `scheduler.ts:4341-4372`                                   | virtual done row、`inputKey` port、WS                                                              |
| call ×2                     | `scheduler.ts:4381-4386` → `runCallWorkflowNode`           | independent child task、既有 call-workflow/workgroup identity、pool 与 park/terminal 语义          |
| `script`                    | `scheduler.ts:4387-4391` → `runScriptNode`                 | subprocess/iso/retry/output/status 逐字保持                                                        |
| `code-host-call`            | `scheduler.ts:4392-4397` → `runCodeHostCallNode`           | outbound call/effect/recovery/status 逐字保持                                                      |
| `code-round`                | `scheduler.ts:4398-4406`                                   | 只返回 `failed / code-round-retired`，绝不恢复 StageEngine                                         |
| `agent-single`              | `scheduler.ts:4416` 起的主纵切                             | identity/injection/upstream/prompt/retry/clarify/review/iso/run/merge/output/WS 全部保持           |
| workgroup host（非新 kind） | `scheduler.ts:360-827` `buildWorkgroupHooks.runHostNode`   | leader/member/dw-generate host prompt、shard Q&A、host ports、discardWrites、merge disposition保持 |

### 2.4 P0-C 已完成，executor 不能重建 gate policy

`review.ts:1022-1075` 与 `clarify/service.ts:320-363` 已调用 collaboration 的
`prepare*GateOpen`，再经 task-execution 的 `parkPreparedHumanGate` participant 原子停驻；
`modules/collaboration/public/commands.ts:86-121` 拥有 review/clarify gate preparation，
`modules/task-execution/public/commands.ts:1-13` 只提供 task park seam。

W2-C executor 因而只能：构造 task-side execution request、调用注入的 collaboration participant、把 receipt 映射为
`awaiting_review | awaiting_human | ok | failed`。它不能把 gate/domain policy、route resume、decision command 或第二套
continuation queue 搬回 node engine。

### 2.5 retry cap 有两个真实 consumer，retry policy 没有

`packages/shared/src/prompt.ts:1275-1300` 的 `retryAttemptCap` 是纯函数：两个 budget 先 total-normalize，再计算
`(1+F)×(1+R)`，最后钳到 `RETRY_ATTEMPT_CAP_CEILING=99`。生产 consumer 恰为：

- TaskExecution agent dispatch：`scheduler.ts:4484-4491`；
- DigitalEmployee outbox/reaction：`runtimeService.ts:2187-2191,2678-2696`。

相反，`decideRetryShape`、`RetryShapeState`、session restart notice 与 envelope followup reason 只属于 TaskExecution。
neutral contract 不能读取 config、决定 reaction/outbox/followup/restart，也不能持有 attempt/session 状态。

## 3. 目标

### G1：一个 closed registry 是唯一 kind selector

`NodeExecutorRegistry` 的 key 集必须与 `NodeKind` 完全相等；每个 entry 自报同一个 kind。新增、删除或重命名 kind 时，
编译期与 runtime oracle 都要求同时声明 behavior row、executor entry、authorability/retirement 分类和测试意图。

### G2：TaskEngine 只经 node execution gateway 驱动 node

`taskDagScope` 不再 import legacy scheduler。DAG ready node 进入 task-execution-owned gateway：公共 prelude 只执行一次，
随后由 registry 精确选 executor。node executor 只返回闭合 outcome，不 claim/settle 整个 task。

### G3：workgroup host 共用 agent executor，不伪装成第四种 engine/kind

`WorkgroupTaskEngine` 继续拥有 round/assignment/leader-worker/free-collab 状态机；它通过窄
`WorkgroupHostExecutionPort` 提交 host request。composition 将该 request 送入 registry 的 `agent-single` executor 的
`workgroup-host` lane；不伪造 WorkflowNode、不增加 `NodeKind`/`ExecutionKind`，也不把 assignment 写入 NodeRun domain。

### G4：所有已落 node 功能逐字保持

14 个 kind 的 status/error/row/output/WS/retry/park/cancel/merge/recovery，以及 workgroup host 的 prompt/ports/clarify/shard/
discard/merge disposition 都必须保持。架构迁移没有产品功能折扣。

### G5：neutral retry cap 归 platform，领域 retry 各自保留

`platform/contracts` 只拥有 exact `RetryAttemptCapPolicyV1` codec、normalization、99 ceiling 与 cap arithmetic；
TaskExecution 拥有 envelope followup/session restart policy/state，DigitalEmployee 拥有 reaction/outbox policy/state。
两域只共享“最多几次”的纯值合同，不共享“下一次怎么跑”。

### G6：W2-D/W3/W5/W9 边界不被吞并

wrapper 三个 registry arm 只经具名 `WrapperNodeExecutionPort` 委托 current W2-D compatibility owner；node executor 不接管
wrapper recursion/merge/replay。task status/committed events、commit-push/completion 与 runtime config projection 继续属于各自后续 wave。

## 4. 非目标

- 不实现或重写 loop/git/fanout outer shell、inner scope、hydrate、park、merge、terminal、retry、replay；归 W2-D。
- 不新增 NodeKind、ExecutionKind、TaskEngineKind、workflow schema、DB migration、REST/MCP/WS/UI 字段或配置项。
- 不恢复 RFC-304/309 `code-round` writer、StageEngine、template CRUD 或新 admission。
- 不把 call-workflow/call-workgroup 当 wrapper，不把 workgroup assignment 混入 DAG/NodeRun。
- 不重写 RFC-287 `RunAssembly`、RFC-188 isolation/merge kernel 或 runtime driver；executor 只组合既有机制。
- 不迁 task-level claim/settle、committed event、completion/commit-push、public route facade 或 config hot projection。
- 不把 review/clarify/questions 的领域顺序、decision、artifact policy 或 durable continuation 复制进 executor。
- 不增加权限、安全策略、能力挡板或任何正常功能收缩；设计门与实现门只审功能正确性和模块职责。

## 5. 决策

- **D1 — 双重穷尽，不合并两张表**：`NODE_KIND_BEHAVIORS` 继续描述跨切面 lifecycle behavior；
  `NODE_EXECUTORS` 描述执行实现。两者分别 `satisfies Record<NodeKind, ...>`，再用 key-set/runtime oracle 对拍；不把 routing
  callback 塞进 shared behavior table。
- **D2 — gateway + registry + executor 三层**：gateway 统一 abort/branch/outcome normalization；registry 只做 closed lookup；
  executor 只做一个 kind 的 mechanics。不得让 registry 接 `SchedulerState`、DB service locator 或任意 callback bag。
- **D3 — request 按用途闭合**：普通 DAG request 固定 `node + iteration + TaskNodeExecutionContext`；agent host 另用
  `WorkgroupHostExecutionRequest`。只有 `agent-single` executor 接受后者，类型与 runtime 都拒绝 lane/kind 错配。
- **D4 — 公共 branch prelude 恰好一次**：abort 先于一切；除 `settlesWithoutRow` family 外统一做 RFC-306 branch
  activation。executor 不再各抄 prelude，也不能先产 side effect 再判断 branch。
- **D5 — wrapper arm 是 W2-D bridge，不是实现迁移**：三种 wrapper 都是 registry 的穷尽 entry，但只调用同一个
  purpose-specific wrapper port；port 不暴露 raw `SchedulerState`，并继续登记 `removeAfterWave=W2-D`。
- **D6 — agent 有两个明确 lane**：DAG agent 与 workgroup host 共用 agent executor/assembly kernel，但各自保留 request、
  prompt、output、clarify、merge disposition 与 result adapter；不以“大一统 AgentContext”抹平差异。
- **D7 — collaboration policy 留在 collaboration**：review/clarify executor 只请求 gate/open/park 并映射 node outcome；
  collaboration 继续拥有 documents/questions/directives/idempotency/revisions/artifacts，task-execution 继续拥有 node/task park 与 intent。
- **D8 — neutral cap 先切**：先建立 `platform/contracts/retryAttemptCap` 与 exact codec，锁住负数/小数/NaN/Infinity/
  ceiling/`restartBudget=0` 行为，再把两个 consumer 同批切换；`decideRetryShape` 随 agent executor 归 task-execution domain。
- **D9 — retired arm 永久显式**：registry 必须有 `code-round` entry，但唯一 outcome 是
  `failed + code-round-retired`。任何 StageEngine/source template/import 都使守卫失败。
- **D10 — per-kind 原子 cutover**：可先增加 executor 与 characterization；每个 kind 迁移时，同一 commit 删除其旧 inline
  body，legacy selector 中最多暂留一行显式 delegation 到同一个 executor。全部 kind 归位后，final cut 同批把公共 prelude
  移到 gateway、把 `taskDagScope` 切到 registry 并删除整个 legacy selector shell。禁止 feature flag、shadow execution、双写
  row 或失败后 runtime fallback。
- **D11 — workgroup host 同样原子切换**：`buildWorkgroupHooks/runHostNode` 迁入 task-execution node composition 后，四个
  production 构造点只注入新 host port；legacy export/body 与 W2-C exception 同批归零。
- **D12 — 功能优先**：所有现有可用路径、输入、输出、错误、恢复与并发行为都是受保护能力。发现迁移必须改变功能时，
  先更新能力影响并重新请批；不以安全理由添加新拒绝或限制。

## 6. 能力影响清单

目标外部影响全部为 **零行为变化**：

| 功能面                  | current 行为                                                   | W2-C 必须保持                                                                          |
| ----------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| workflow DAG            | completion-driven frontier；ready 即并发 dispatch              | ready/ordering/concurrency/park/stall/terminal 不变                                    |
| branch activation       | abort 后、kind effect 前统一判断；clarify family 无 row        | skip reason、consumed provenance、output active 与 WS 不变                             |
| input/output            | virtual row + port projection                                  | row cause/status/port/kind/archive/active/consumed 不变                                |
| agent-single            | frozen runtime、prompt、retry shape、clarify/review、iso/merge | attempt 数、session reuse/restart、nonce/tree、输出、错误与恢复不变                    |
| script                  | 独立 subprocess executor                                       | pool、timeout、retry、worktree、output 与错误不变                                      |
| code-host-call          | 一次 provider effect + durable observer                        | provider/action、effect idempotency、status/error/recovery 不变                        |
| call nodes              | 独立 child task                                                | child identity/inputs/park/cancel/result 与 pool 行为不变                              |
| review                  | 单/多/空文档 + atomic gate park                                | anchor/artifact/reuse/auto-approve/`awaiting_review` 不变                              |
| clarify family          | graph no-op/runner open/cross persistent-stop                  | question round、shard、directive、live-row idempotency 与 outcome 不变                 |
| wrappers                | loop/git/fanout current outer mechanics                        | registry 只改 routing；W2-D 前 body/row/scope/merge/replay 逐字保持                    |
| workgroup/dw host       | leader/member/orchestrator host run                            | assignment owner、prompt fencing、host ports、clarify、discardWrites、merge policy不变 |
| historical code-round   | resume 时 typed failure                                        | 仍只返回 `code-round-retired`；不执行旧 stage                                          |
| retry cap               | `(1+F)(1+R)`、normalize、ceiling 99                            | TaskExecution 与 DigitalEmployee 数值逐项相等；领域 retry policy 不互相渗透            |
| API/MCP/WS/UI/config/DB | current wire/schema/table/settings                             | 零变化                                                                                 |

## 7. 验收标准

- **AC-1**：source-lock 从 committed source 构造 14-kind inventory；user-authored=13，synthesized-only/retired=`code-round`，
  任一 drift 必红。
- **AC-2**：`NODE_EXECUTORS satisfies Record<NodeKind, NodeExecutorSpec>`，registry runtime keys 与 `NODE_KIND`、
  `NODE_KIND_BEHAVIORS` 完全相等，每个 executor 自报 kind 与 key 相同。
- **AC-3**：新增/删除一个 synthetic NodeKind 的编译 mutation 必须同时击中 behavior、executor、authorability/retirement 与
  per-kind oracle；不能只在 runtime fall-through 才发现。
- **AC-4**：`taskDagScope` 生产 import/call `services/scheduler.runOneNode` 为 0；legacy `runOneNode` symbol/body/facade entry 为 0；
  ready node 只经新 gateway/registry。
- **AC-5**：abort 与 RFC-306 branch activation 对所有适用 kind 恰好一次、发生在 per-kind effect 之前；clarify family 继续
  settles-without-row，branch skip 不铸多余 row。
- **AC-6**：14 个 kind 各有 current behavior characterization；input/output/review/clarify/call/script/code-host/agent/wrapper/
  retired 的 status、message、row/output/WS 均对拍。
- **AC-7**：三种 wrapper registry entry 只走 `WrapperNodeExecutionPort`；W2-C 不搬/复制 wrapper body，W2-D source guards 保持。
- **AC-8**：review/clarify executor 只调用注入的 collaboration gate request port 与 task park participant；route direct resume
  仍为 0，RFC-333 operation/intent/recovery oracle 全绿。
- **AC-9**：`code-round` registry entry 只返回 `code-round-retired`；active StageEngine/import/writer/admission=0，且不新增
  TaskEngineKind/ExecutionKind。
- **AC-10**：workgroup leader/member/dw-generate host 全部经 `agent-single` executor 的 typed host lane；
  `buildWorkgroupHooks/runHostNode` legacy body、四个 production constructor hit 与 W2-C exception=0；workgroup engine 仍唯一拥有
  round/assignment。
- **AC-11**：neutral cap exact codec 拒绝 unknown key；direct arithmetic 保持 negative/truncation/NaN/Infinity/ceiling 与
  `R=0` golden，`RETRY_ATTEMPT_CAP_CEILING=99 < ASSEMBLY_MAX_ATTEMPTS=100`。
- **AC-12**：TaskExecution 与 DigitalEmployee 是 neutral cap 的两个具名生产 consumer；platform contract 不 import config、
  task、employee、reaction、outbox、session 或 runner。
- **AC-13**：`decideRetryShape`/state/restart notice 归 task-execution，DigitalEmployee reaction/outbox state 留原 owner；默认
  attempt 与所有 RFC-313 golden/shape/failure case 不变。
- **AC-14**：无 DB migration、wire/schema/status/error/config/UI 变化；现有外部能力矩阵与 E2E journey 结果不变。
- **AC-15**：两条 RFC-332 W2-C cross-context exceptions 精确删除；不得新增 KNOWN/architecture exception 抵账；
  backend/repo value SCC 不高于 current `4/6`。
- **AC-16**：canonical owner/wave 把 registry/executors/host adapter 投影为 `task-execution/engine/node`；wrapper bodies 仍为 W2-D，
  retry cap 为 `platform/contracts`，human gate policy 为 collaboration。
- **AC-17**：切换过程没有 production dual dispatch、shadow node run、double WS 或 legacy fallback；在途 task 只依赖现有 persisted
  row/schema，部署前后均可继续。
- **AC-18**：targeted behavior/architecture/canonical gates、exact-SHA main CI 与仓内全部 scheduled workflow 终态成功后才可标 Done；
  queued/cancelled/ancestor run 不算成功证据。

## 8. 退出条件

RFC-334 只有同时满足以下条件才可标 Done：

1. closed registry 穷尽 14 个 kind，task DAG 与 workgroup host 只有一个 node execution gateway；
2. legacy `runOneNode`、`runHostNode`、`buildWorkgroupHooks` 与两条 W2-C exception 全部归零；
3. wrapper mechanics 仍由 W2-D bridge 承载且没有被复制，W2-D 未被倒签完成；
4. review/clarify policy 与 durable continuation 仍由 collaboration/RFC-333 owner 承载；
5. neutral cap 只有算术/codec，两个领域各自 retry policy/state 没有合并；
6. 14-kind、workgroup host、RFC-313、RFC-333 与架构 oracle 全绿，外部功能无变化；
7. exact-SHA main CI 与全部 scheduled workflow 提供终态成功证据；
8. RFC-294 只把 W2-C 置 Done，W2-D/W3/W4/W5/W9 继续保持原批准状态。

### 8.1 关闭证据

- 实现链：`4b7f36c96`（neutral retry contracts）→ `234cfb230`（closed registry）→ `daf4c4a76`
  （production cutover）→ `1271ecb20`（canonical payload）→ `cfe1326b4`（provenance pin）；
- W2-C payload 分母：mutation/import/exception/owner=`951/1329/1297/18139`，backend/repo value SCC=`4/6`；
- 当前仓库在 RFC-336/337 合入后的最新 architecture payload/pin 为 `f5e7833fd` → `aa32b65ad`，source digest
  `sha256:14b1c9bc4f6b634044135575cb3aab2b2db14c2ddf765f3b3e02688a18896576`；当前分母为
  mutation/import/exception/owner=`952/1339/1304/18186`，它是全仓最新 shape，不反写 W2-C 自身 payload；
- 主 CI：`8e58eb05f987bcf08007db714119b3f46d519772` / `33142147682` attempt 2，35/35 jobs terminal
  `success`；其中 hosted macOS backend shard 1/4 已验证 daemon readiness 预算修复；
- scheduled：`33137355523`、`33137360247`、`33137365884`、`33137370609`、`33137376055`、
  `33137380634`、`33137385552`，七条 workflow 合计 19/19 jobs terminal `success`，head SHA 均为
  `0a0df74c4476355cc5d5e5f0fe289f823759a2e1`；
- `runOneNode`、`runHostNode`、`buildWorkgroupHooks` production symbol 与两条 W2-C exception 均为 0；三条 wrapper
  bridge 继续精确归 W2-D，没有新增安全策略、schema、wire、config 或 UI 行为。

## 9. 批准记录

2026-08-28，用户要求“完成 RFC333 并提交上库，然后开始 W2-C”。该指令授权完成本轮 current-source 调研、创建并发布
RFC-334 proposal/design/plan；当时尚未授权 D1～D12 与 plan T2～T12 的生产实现。

随后用户明确回复“批准实施”，授权 RFC-334 D1～D12 与 plan T2～T12。授权只覆盖 W2-C 的等价迁移、验证、提交、推送与
scheduled closeout；不外溢到 W2-D/W3/W4/W5/W9，也不授权新增安全策略或收缩正常功能。
