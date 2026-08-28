# RFC-334 实施计划：NodeExecutorRegistry（RFC-294 W2-C）

> 状态：In Progress（2026-08-28；T0～T11 候选完成，T12 等待 architecture provenance、发布及 exact-SHA hosted/scheduled CI）
>
> 批准边界：用户已明确批准 RFC-334 T2～T12 生产实施。批准不外溢到 W2-D/W3/W4/W5/W9，不授权
> 安全/权限策略或正常能力收缩。
>
> 验证边界：沿用当前用户约束——GitHub exact-SHA CI 是最终权威；不在本机启动 full Bun gate、E2E 或服务。实现期可运行
> 与候选直接相关的 typecheck、纯单测、源码/架构守卫、formatter 与 artifact generator；最终必须等待 main CI 与全部 scheduled
> workflow 的 terminal verdict。

## 1. 实施原则

1. 先锁 14-kind/current host 功能，再迁 owner；不能用“目录变干净”替代行为证据。
2. registry、gateway、executor 分层；不得把 `LegacyTaskMechanicsState` 换名后整体搬进新模块。
3. 每个 kind 的 executor body切换与旧 inline body删除同 commit；legacy selector最多暂留一行 exact delegation。全部 kind归位后
   final cut删除 selector；不做 shadow dispatch、双写、feature flag 或 runtime fallback。
4. wrapper entry 只做 W2-D delegation；W2-C 不复制/改写 wrapper runtime。
5. workgroup host 走 agent executor 的 typed host lane；round/assignment 仍归 WorkgroupTaskEngine。
6. review/clarify 只经 collaboration port 请求 open/park；RFC-333 durable continuation/decision 不重建。
7. neutral retry cap 只共享 arithmetic/codec；TE/DE policy/state 不合并。
8. `code-round` 只有 retired arm；不得恢复 stage execution。
9. 所有外部功能、错误、状态、row/output/WS、重试、并发、恢复逐字保持；发现必须变化先停并请批。
10. 实现门只审功能正确性与模块职责，不新增安全策略。

## 2. baseline 与 source-lock

current source pin：`0d296ff1bd72a7bf1e3fef8bcc506fa511e11b34`，本地/远端共同 `main`；主 CI
`33127647698` 35/35 terminal success。其 production code 与 RFC-333 canonical provenance
`57e45c292acec81d8f8cf27fceade4f44369a462` 的 final shape 一致；scheduled evidence 沿用该 production payload 的
七条 workflow 19/19 success，W2-C 实现完成后必须在新 exact SHA 全部重跑。

### 2.1 source inventory

| ID  | baseline fact                                 | source/symbol                                                                          | W2-C exit                                      |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| S1  | `NODE_KIND` 14、synthesized-only仅 code-round | `shared/src/schemas/workflow.ts#NODE_KIND/#SYNTHESIZED_ONLY_NODE_KINDS`                | 14-kind exact inventory + classification guard |
| S2  | behavior table穷尽                            | `shared/src/node-kind-behavior.ts#NODE_KIND_BEHAVIORS`                                 | 与 executor registry 双表对拍                  |
| S3  | DAG反向 import legacy node                    | `modules/task-execution/composition/taskDagScope.ts` → `services/scheduler.runOneNode` | edge/symbol/body/facade=0                      |
| S4  | workgroup/dw反向 import legacy hooks          | `taskEngineApplication.ts` → `scheduler.buildWorkgroupHooks` 四处                      | 四处只注入新 host port；legacy body=0          |
| S5  | common abort/branch prelude                   | `scheduler.ts#runOneNode` 前段                                                         | gateway恰好一次、effect前                      |
| S6  | input/output inline                           | `scheduler.ts#runOneNode`                                                              | virtual I/O executors                          |
| S7  | wrapper routing inline                        | `runOneNode` → `runWrapperNode` ×3                                                     | registry arms + W2-D purpose-specific port     |
| S8  | review/clarify routing inline                 | `runOneNode` → `dispatchReviewNode` / cross-clarify guard                              | gate request port + exact outcome              |
| S9  | call/script/code-host inline                  | `runOneNode` → three executor families                                                 | exact per-kind entries                         |
| S10 | agent body inline                             | `runOneNode` agent fallthrough                                                         | `AgentSingleNodeExecutor` DAG lane             |
| S11 | workgroup host body inline                    | `scheduler.buildWorkgroupHooks.runHostNode`                                            | agent executor host lane                       |
| S12 | code-round retired runtime arm                | `runOneNode` `code-round-retired`                                                      | explicit retired executor only                 |
| S13 | retry cap + TE policy co-located              | `shared/src/prompt.ts#retryAttemptCap/#decideRetryShape`                               | platform neutral cap + TE envelope policy      |
| S14 | neutral cap production consumers=2            | scheduler agent；digital-employee runtime service                                      | both import platform；无第三 consumer/state    |
| S15 | W2-C legacy exceptions=2                      | canonical cross-context manifest                                                       | exact ids归零、无新 KNOWN                      |

### 2.2 开工前重采

T2 开始前必须重新 fetch/对拍 `origin/main`，用 committed blob 重新生成 S1～S15。若以下任一项变化，先更新 RFC，不直接套旧计划：

- NodeKind 数量/分类或 behavior fields；
- runOneNode/workgroup host routing/结果形状；
- RFC-333 gate open/park/continuation owner；
- retry cap consumer 或公式；
- W2-C/W2-D exact bridge/owner wave。

## 3. 实施波次

### T0 — current-source 调研与 RFC 三件套（本轮完成）

- 对拍 RFC-294 W2-C、RFC-313、RFC-332、RFC-333 与 current source；
- 固定 14-kind user/synthesized/retired inventory；
- 固定 runOneNode、workgroup host、wrapper、gate、retry consumer 边界；
- 写 proposal/design/plan，回链 RFC-294、总索引与 STATE；
- 只发布文档，无生产代码、schema、wire、config、UI 变化。

退出：三件套 Markdown/链接/状态检查通过；远端 exact-SHA CI terminal success。

### T1 — 用户批准门（已完成）

用户逐项批准或修改 D1～D12，至少确认：

- 14-key closed registry 与 per-kind atomic cutover；
- wrapper 三 arm 只委托 W2-D；
- workgroup host 使用 agent executor typed lane但不迁 assignment；
- neutral cap exact codec + 两 consumer，TE/DE policy分离；
- `code-round` 永久 retired；
- 零产品行为变化、零新增安全策略；
- GitHub exact-SHA main/scheduled closeout。

退出：用户已于 2026-08-28 明确回复“批准实施”；实施仍严格受本 RFC 范围约束。

### T2 — characterization、source-lock 与 red architecture tests（候选完成）

- 生成 closed 14-kind inventory fixture，不手抄测试子集；
- 为每个 kind建立 current result/row/output/WS/side-effect characterization；
- 锁 common abort/branch first 与 clarify settles-without-row；
- 锁 workgroup leader/member/dw host prompt/ports/clarify/shard/discard/merge disposition；
- 锁 RFC-313 cap/shape 与 DigitalEmployee scene/outbox behavior；
- 新增 target red guards：registry missing、两条 legacy bridge仍存在、host旁路仍命中。

建议文件：

```text
packages/backend/tests/rfc334-node-kind-inventory.test.ts
packages/backend/tests/rfc334-node-executor-characterization.test.ts
packages/backend/tests/rfc334-workgroup-host-characterization.test.ts
packages/backend/tests/rfc334-retry-contract.test.ts
packages/backend/tests/architecture/rfc334-node-executor-boundary.test.ts
```

退出：current behavior tests 绿；target architecture assertions在旧实现上按预期红，并明确记录翻转点。不得先弱化旧行为断言。

### T3 — neutral retry-cap contract

- 新增 `platform/contracts/retryAttemptCap.ts`；
- 落 strict `RetryAttemptCapPolicyV1` exact codec、normalization、ceiling=99 与 pure arithmetic；
- 先迁 TaskExecution agent consumer，再迁 DigitalEmployee两个 call site；同一 candidate删除 shared 中 cap/ceiling 的旧定义；
- 把 `decideRetryShape`/state/restart notice迁到 task-execution domain，保留 shared
  `DEFAULT_PROTOCOL_RETRY_BUDGET`；
- 更新 RFC-313 tests/source locks为 owner/behavior oracle。

退出：两个生产 consumer数值对拍；platform 不 import领域/config/state；旧 cap定义=0；R=0/NaN/Infinity/ceiling golden全绿。

### T4 — node domain、gateway 与 closed registry skeleton（已完成）

- 新增 `NodeStepRequest/Outcome`、host request/result adapter合同；
- 建 `NodeExecutionGateway`，但 production尚不切 kind；
- 建 immutable `NODE_EXECUTOR_SPECS satisfies Record<NodeKind,...>`；
- constructor/runtime guard对拍 keys + executor.kind；
- composition按用途注入 ports/pools/resolvers，不传 raw state/DB/callback bag；
- synthetic kind、missing/extra/wrong-kind mutations必红。

退出：registry/gateway纯测全绿；无 production shadow execution；behavior/registry/classification closed-set一致。

### T5 — retired与 virtual I/O 原子 cutover（候选完成）

顺序：`code-round` → `input` → `output`。

- code-round切为常量 retired executor；删除旧 branch，锁 StageEngine/writer/admission=0；
- input迁 exact inputKey/virtual row/port/broadcast；
- output迁 wrapper source resolution、port content/kind/archive/active、consumed provenance与broadcast；
- current `runOneNode` 暂时继续只执行一次 abort/branch prelude；三个 branch的 inline body缩成到对应 executor的 exact delegation，
  未切 kind仍走各自单一路径，不能双跑。公共 prelude与入口在 T11 final cut迁到 gateway。

退出：三个 kind旧 branch=0；row/port/WS golden逐项相等；registry是唯一 selector。

### T6 — human-gate family cutover（候选完成）

顺序：`clarify` → `clarify-cross-agent` → `review`。

- clarify graph no-op迁入 executor；
- cross-clarify迁 live-row/missing-questioner/persistent-stop/common path；
- review executor只构造 task-side request并调用 collaboration port；
- agent runner self/cross clarify open也改经同一 gate request adapter，不把 policy移入 executor；
- 同批删除对应 legacy inline bodies，selector中仅留 exact executor delegation；重跑 RFC-333
  open/decision/fault/restart/handoff/deferred-question corpus。

退出：route direct resume保持0；operation/intent/recovery与单/多/空 review、self/cross clarify全部同形。

### T7 — call、script 与 code-host-call cutover（候选完成）

- `call-workflow`/`call-workgroup` 两个 entry共享 current child-call mechanics但保留 distinct kind/input identity；
- script迁 subprocess/pool/iso/retry/output/status；
- code-host-call迁 provider/action/effect observer/recovery/status；
- 每个 kind新 executor与旧 inline body同 commit切换，selector只留 exact delegation；call不得并入 wrapper，
  script/code-host不得合成一个模糊 process executor。

退出：child park/cancel/terminal、script failure/retry、code-host side effect/recovery全部对拍；legacy branches=0。

### T8 — wrapper delegation arms（候选完成）

- 注册 wrapper-git/loop/fanout三个 exact executor；
- 只调用 `WrapperNodeExecutionPort`，composition绑定 current W2-D mechanics；
- nested scope内 node仍回到新 gateway/registry；
- 更新 canonical bridge：顶层 kind selector属于 W2-C 已收，wrapper body/removal wave仍为 W2-D；
- 不迁/复制 wrapper hydrate/park/merge/replay/terminal/retry。

退出：wrapper旧 inline routing body=0、selector只剩 exact delegation；W2-D body/source guards全部保持；wrapper port不暴露
raw SchedulerState。

### T9 — agent-single DAG lane（候选完成）

- 依当前顺序迁 identity/borrow/upstream/injection/prompt/review/clarify/retry/row/runtime/iso/run/merge/output/WS；
- 复用 T3 task-execution envelope retry policy与既有 ExecutionKernel；
- 把源码字符串守卫升级为真实 behavior/AST boundary oracle；
- 同一 production cut删除 agent fallthrough body并改为 exact executor delegation；`unhandled-node-kind` selector兜底在 T11
  final cut随整个 selector删除，closed registry接管穷尽；
- 保持 process-unreaped、merge throw、fresh/followup/restart、nonce/tree与manual gate handoff。

退出：agent current corpus、RFC-287/313/333、multi-repo/iso/merge/retry/clarify/review全部绿；legacy agent body=0。

### T10 — workgroup/dynamic host lane（候选完成）

- `AgentSingleNodeExecutor.executeHost` 落 typed host lane；
- 迁 current host injection/frozen runtime/prompt fencing/host port projection/clarify shard/late suppression/discardWrites/merge disposition；
- `WorkgroupHostExecutionPort` 适配 `WorkgroupHostRunRequest/Result`，workgroup strategy/assignment不迁；
- taskEngineApplication四个 production构造点只注入新 port；
- 同批删除 `scheduler.buildWorkgroupHooks/runHostNode` export/body/facade rows。

退出：leader/member/dw-generate与 fake-port engine tests全绿；旧 host hit=0；WorkgroupTaskEngine仍唯一 assignment owner。

### T11 — legacy extinction与 architecture artifacts（候选完成，provenance 待 T12）

- 把 current abort/branch prelude从 selector迁到 gateway，证明每个 DAG node仍恰好执行一次；
- `taskDagScope` 改为只 import task-execution gateway；
- 删除 legacy `runOneNode`、`buildWorkgroupHooks/runHostNode`与已无 consumer的 W2-C helper/facade；
- 删除两条 RFC-332 W2-C cross-context exception，不能新增 KNOWN抵账；
- generator重放 current report、owners、imports、facades、mutations、public surfaces与provenance；
- exact assertions锁 registry/executors=`task-execution/engine/node`、neutral cap=`platform/contracts`、wrapper bridge=W2-D；
- backend/repo value SCC不得高于`4/6`。

退出：W2-C exact symbols/edges/exceptions全0；canonical artifacts由生成器产生且 provenance指向真实 payload。

### T12 — 功能回归、发布、scheduled CI 与文档关闭

- 跑允许的 targeted type/unit/architecture/canonical checks，记录 candidate content与结果；
- 精确暂存本 RFC 文件，提交前 fetch/sync/index allowlist/trailer复核；
- push后确认 `origin/main` exact ancestry；
- 等待 exact-SHA主 CI每个 job terminal；失败按 job/test/path归因并只修本 RFC拥有问题；
- 枚举 `.github/workflows` 中全部 `schedule` workflow，逐一 `workflow_dispatch`，等待 exact SHA terminal；
- 全绿后更新 RFC334为Done、RFC294只关闭W2-C、STATE/总索引与证据账；再次发布并等待closure SHA主CI；
- fetch后确认本地main==origin/main且工作树不遗留本任务文件。

退出：proposal §8八条退出条件全部满足；main CI与全部scheduled terminal success；W2-D及后续wave状态未被倒签。

## 4. 建议提交边界

| Commit | 内容                                                            | 不包含                      |
| ------ | --------------------------------------------------------------- | --------------------------- |
| C0     | RFC334三件套、RFC294/STATE/index回链                            | 生产代码                    |
| C1     | T2 characterization/source-lock/red architecture guards         | production selector         |
| C2     | neutral cap + TE/DE consumer + TE retry policy owner cut        | node registry               |
| C3     | domain/gateway/registry skeleton + compile/runtime mutations    | production per-kind switch  |
| C4     | retired + input/output atomic cut                               | human/call/process          |
| C5     | clarify/cross/review cut + RFC333 regression                    | wrapper/agent host          |
| C6     | call/script/code-host cut                                       | wrapper/agent               |
| C7     | wrapper delegation arms                                         | W2-D mechanics              |
| C8     | agent-single DAG lane                                           | workgroup strategy          |
| C9     | workgroup/dw host lane + old hook deletion                      | assignment/round rewrite    |
| C10    | legacy extinction + generated architecture artifacts/provenance | unrelated architecture debt |
| C11    | CI-owned functional repair（仅若 exact job证明归 RFC334）       | unrelated red               |
| C12    | Done文档、RFC294/STATE/index、hosted/scheduled evidence         | 新生产行为                  |

实际 commit 可因共享 body原子性合并相邻批次，但不得拆开“新 production entry切换”和“旧 production branch删除”。共享 `main` 每次只
精确 stage owned paths；若同一个 task-related file含并发输出，保留完整文件并在 handoff说明，绝不回滚他人 hunks。

## 5. 测试矩阵

### 5.1 closed registry

| Case                      | Oracle                                                 |
| ------------------------- | ------------------------------------------------------ |
| exact 14 keys             | schema=behavior=executor key set                       |
| missing/extra/wrong kind  | compile/runtime failure                                |
| synthetic new NodeKind    | behavior/registry/classification/per-kind test同时失败 |
| code-round classification | synthesized-only + retired only                        |
| no default/fallthrough    | unknown path不存在；agent不能接住其他kind              |

### 5.2 per-kind behavior

| Family         | Required cases                                                                  |
| -------------- | ------------------------------------------------------------------------------- |
| common prelude | abort first；active/inactive；join any/all；clarify no-row                      |
| input/output   | invalid key/source；multi-port；archive/kind/active；consumed；WS               |
| review         | single/multi/empty；reuse/refresh；artifact finalize recovery；park             |
| clarify        | self no-op；cross live/missing/stop/common；shard/iteration                     |
| calls          | workflow/workgroup child；done/failed/park/cancel/restart                       |
| script         | success/output；timeout；retry；iso/merge；cancel                               |
| code-host      | provider/action invalid；success/failure；effect replay/recovery                |
| wrappers       | git/loop/fanout；nested；park；resume；merge/replay（current body）             |
| agent DAG      | identity/injection；prompt；retry shapes；review/clarify；iso/merge；unreaped   |
| workgroup host | leader/member/dw；ports；clarify suppression/shard；discard；merge dispositions |
| code-round     | exact `code-round-retired`；no stage/import/writer                              |

### 5.3 mandatory regression families

- RFC-287 assembly/line disposition/source locks；
- RFC-313 session escalation/cap/shape/source locks；
- RFC-332 task engine/bridge/canonical owner；
- RFC-333 gate source/open/decision/fault/restart/handoff/deferred-question；
- scheduler audit S-02/S-13/S-17、mid-run clarify/review、workgroup RFC-164/172/181/184/187；
- architecture RFC-294/317/canonical manifests与 provenance；
- exact-SHA main CI全部 jobs；全部 scheduled workflows。

## 6. AC 证据账本（规划）

| AC    | Primary evidence                                                | Wave    | Draft status   |
| ----- | --------------------------------------------------------------- | ------- | -------------- |
| AC-1  | committed source inventory + classification test                | T0/T2   | T0/T4 Done     |
| AC-2  | compile record + runtime key/kind guard                         | T4      | T4 Done        |
| AC-3  | synthetic-kind mutation                                         | T4      | T4 Done        |
| AC-4  | import/symbol/body/facade extinction                            | T5～T11 | candidate Done |
| AC-5  | gateway ordering + real branch cases                            | T2/T5   | candidate Done |
| AC-6  | 14-kind behavior matrix                                         | T2～T10 | candidate Done |
| AC-7  | wrapper port boundary + W2-D source guard                       | T8      | candidate Done |
| AC-8  | collaboration port + RFC333 corpus                              | T6      | candidate Done |
| AC-9  | retired executor + active-stage-zero guard                      | T5      | candidate Done |
| AC-10 | host-lane characterization + four-constructor/legacy extinction | T10     | candidate Done |
| AC-11 | retry arithmetic/codec/assembly ceiling golden                  | T3      | T3 Done        |
| AC-12 | import/consumer inventory mutation                              | T3/T11  | T3 Done        |
| AC-13 | TE shape + DE scene/outbox behavior                             | T3/T9   | T3 Done        |
| AC-14 | schema/wire/config/UI zero-delta + product regression           | all     | candidate Done |
| AC-15 | canonical exception/SCC report                                  | T11     | candidate Done |
| AC-16 | owner/layer/wave exact assertions                               | T11     | candidate Done |
| AC-17 | production-hit/source AST + side-effect no-double tests         | T5～T11 | candidate Done |
| AC-18 | exact-SHA CI API/job evidence + scheduled enumeration           | T12     | pending        |

### 6.1 当前候选证据（发布前）

- `NodeKind` / behavior / executor key 集均为 14；legacy `runOneNode`、`runHostNode`、`buildWorkgroupHooks` production symbol 为 0；
- DAG 与 workgroup/dynamic host 统一经 typed node execution composition；clarify open 只经 `CollaborationNodeGatePort`；
- task-execution 到 scheduler 只剩三条 exact wrapper value bridge，均登记 `removeAfterWave=W2-D`；W2-C legacy exception 为 0；
- canonical source digest 为 `sha256:4d0850a7315ac0064fc244ae9d040c92302d2d1d72f6ff5e5ed10eefae3c877e`，
  mutation/import/exception/owner 分母为 `951/1329/1297/18139`，backend/repo value SCC 保持 `4/6`；
- backend typecheck、owned ESLint/formatter、RFC-287/313/317/332/333/334 与 scheduler/workgroup targeted corpus 已通过；
  其中核心行为集 124/124、clarify 相关 54/54、RFC-317 module/guard/ledger 89/89、RFC-317/332/334 combined 仅剩预期的
  一次性 high-water provenance 红。最终结论仍以 T12 exact-SHA GitHub CI 与全部 scheduled workflow 为准。

## 7. 停止门与回退

### 7.1 立即停止实施

- source inventory与 RFC不一致且会改变设计；
- 需要新增 schema/kind/engine/config/status/error 才能迁移；
- 必须删除、限制或拒绝现有正常能力；
- per-kind切换无法同时移除旧 branch；
- review/clarify要求第二 continuation/route resume；
- workgroup host要求迁 assignment/strategy；
- wrapper必须在W2-C重写；
- neutral cap开始读取领域 config/state；
- 需要新增 KNOWN/exception 才能让架构门通过。

### 7.2 回退策略

- 未接 production 的 additive contract/test可留；
- 已切 kind用正常反向 commit回到唯一旧 path，不使用 runtime flag/fallback；
- agent与workgroup host各按其 atomic commit整体回退；
- neutral cap两个 consumer同批回退，防止公式分叉；
- canonical artifacts只由 generator重放，不手改数字；
- 无 schema migration、无用户数据删除；不触碰其他 session 的 shared WIP。

## 8. 完成后的下一步

RFC-334 完整 Done 后，RFC-294 W2-C 关闭。下一架构节点是 **W2-D WrapperRuntime** 的 current-source 调研与独立 RFC：盘点
loop/git/fanout outer shell、hydrate/park/merge/terminal/retry/replay，并以 W2-C 留下的 `WrapperNodeExecutionPort` 为唯一入口。
W3 committed events、W4 facade、W5 completion与W9 config仍按总纲顺序/前置另行批准，不能由 RFC-334 自动开始。
