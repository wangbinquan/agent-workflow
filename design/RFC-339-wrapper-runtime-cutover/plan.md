# RFC-339 实施计划 — WrapperRuntime 归位与 wrapper/replay mechanics cutover

状态：In Progress；T0～T1 已完成，先发布设计批次，再启动 T2～T11。

source pin：`251b5d725ef731d15c17a01656fdc827f925e7c7`

## 1. 实施原则

1. 只在共享 `main` 上按 exact owned path 开发；不建 branch/worktree/stash，不覆盖并发产物。
2. 用户已于 2026-08-28 批准 D1～D10 与 T2～T11；批准不外溢到 W3 以后 wave。
3. 每个 wrapper kind 原子切换：同一 commit 接新 entry、删旧 body；不双跑、不 fallback、不 feature flag。
4. 功能行为远高于“目录漂亮”；任何正常能力变化先停止并重新呈批。
5. 不新增安全策略、权限或限制；实现门只审功能与边界。
6. 不跑本地 Bun 全量门禁；以 exact-SHA GitHub CI 和完成时全部 scheduled workflow 为权威。
7. canonical artifact 只由唯一 generator 重放，不手改分母、digest 或账本数字。

## 2. current baseline 与 source-lock

### 2.1 开工事实

| 指标                                         |                                                                  baseline |
| -------------------------------------------- | ------------------------------------------------------------------------: |
| backend production files                     |                                                                       940 |
| modules production files                     |                                                                       415 |
| services files                               |                                                                       379 |
| scheduler.ts                                 |                                                               3,816 lines |
| scheduler replay + wrapper region            |                                                `507-3643`，约 3,137 lines |
| wrapper kind                                 |                                                                         3 |
| canonical W2-D scheduler symbols             |                                                                        10 |
| W2-C wrapper imports                         |                                                                         3 |
| W2-B replay imports                          |                                                                         2 |
| startTaskDeps internal drive import          |                                                                         1 |
| scheduler→nodeMechanics exact imports        |                                                                        17 |
| scheduler→sourceTermination internal imports |                                                                         2 |
| KNOWN / backend SCC / repo SCC               |                                                              `31 / 4 / 6` |
| task-execution-containing SCC                |                                                                         0 |
| architecture source digest                   | `sha256:ee9c5632c10a4fbd6fc2460e63db8d8f2fb73b2ed2f820183b116389f4a17607` |

### 2.2 T2 前重采

T2 开始前必须重新 fetch/sync `origin/main`，记录：

- live HEAD/source digest；
- `WRAPPER_NODE_KINDS`、wrapper delegator/port/bridge；
- scheduler W2-D symbol/line inventory；
- replay order；
- `buildStartTaskDeps` / `createLegacyTaskExecutionTopology` 全部 production caller；
- wrapper/replay/merge/nesting regression corpus；
- canonical exact import/exception ids 与 SCC family。

若库存改变并影响合同，先刷新本 RFC 再请批，不把旧 pin 当 current truth。

## 3. 任务分解

### T0 — current-source 调研与 RFC 三件套（Done）

- [x] fetch/sync shared main，确认 `main == origin/main == 251b5d725`、worktree/index clean；
- [x] 读取 RFC-294 proposal/design/plan 与 RFC-334 closeout；
- [x] 追踪 NodeExecutionGateway → wrapper bridge → scheduler body；
- [x] 盘点 loop/git/fanout、progress、scope、merge/replay、bootstrap caller；
- [x] 核对 canonical report、exact edges 与真实 SCC；
- [x] 起草 proposal/design/plan，登记 RFC 索引与 STATE；
- [x] 纠正 RFC-294 W2-D 已失真的 SCC/KNOWN 退出门。

### T1 — 用户批准门（Done）

- [x] 用户逐项批准 proposal D1～D10；
- [x] 用户批准 T2～T11 生产实施；
- [x] 明确本 RFC 只关闭 W2-D，不自动授权 W3 以后 wave。

### T2 — characterization、source-lock 与 red architecture gates（Pending）

- [ ] 重采 §2.2 全部 baseline；
- [ ] 增 `rfc339-wrapper-runtime-source-lock`，固定 3 kind / 10 symbol / bridge/reverse family；
- [ ] 增 closed registry missing/extra/wrong-kind mutation；
- [ ] 增 scheduler legacy symbol/import extinction red gates；
- [ ] 增 scope path/direct membership invalid-tree mutation；
- [ ] 增 lifecycle phase-order、replay-before-frontier red gates；
- [ ] 锁现有 capability/park/status/error matrix，不以新限制替代 characterization。

退出：测试在 current production 上只因“新 owner 尚未切换”的预期项为 red；现有功能 characterization 全绿。

### T3 — execution scope、progress 与 pure fanout owner cut（Pending）

- [ ] 建 immutable `ExecutionScopeIndex` / `WrapperScopeDescriptor` / outer→inner path；
- [ ] TaskEngine snapshot admission 后只构造一次 index；
- [ ] 迁 `wrapperProgress` codec 到 task-execution domain，old payload golden 全绿；
- [ ] 迁 `services/fanout.ts` pure scope/split helpers 到 domain；
- [ ] 所有 consumer 改到新 owner，同批删除 legacy pure files/转发；
- [ ] 不写 W7 schema，不改变 workflow definition wire。

退出：scope membership/path 单源；pure logic legacy owner=0；无 production wrapper routing 变化。

### T4 — ports、common lifecycle template 与 composition skeleton（Pending）

- [ ] 建 WrapperRunLedger/ScopeDriver/Workspace/Data/FanoutAttempt/StatusPublisher ports；
- [ ] 建 WrapperRuntime closed registry 与 common lifecycle template；
- [ ] 建 sqlite/workspace/current-kernel adapters；
- [ ] common fresh/resume/running/park/terminal/superseded unit matrix；
- [ ] engine/domain 禁 infrastructure bag/import gate；
- [ ] skeleton 无 production caller。

退出：template/strategies 可独立测试；production 仍只走旧 path，未形成 dual dispatch。

### T5 — LoopStrategy 原子 cutover（Pending）

- [ ] 迁 loop validation、progress iteration、nested scope、exit/output/max policy；
- [ ] wrapper-loop registry entry 同批切新 strategy；
- [ ] 删除 scheduler loop entry/body，仅保留仍被 Git/Fanout 共用的 helpers；
- [ ] loop park/revival/nesting/cycle/output/exhausted corpus 全绿；
- [ ] exact source guard 确认 loop 不存在 fallback。

退出：`wrapper-loop` 只有 WrapperRuntime 一个生产 entry，current row/outcome/WS 逐项相等。

### T6 — GitStrategy 原子 cutover（Pending）

- [ ] 迁 wrapper-private canonical create/rebuild；
- [ ] 迁 per-repo baseline/preDirty old-payload compatibility；
- [ ] 迁 nested scope、diff/output、merge/park/fail/discard；
- [ ] wrapper-git registry entry 同批切新 strategy并删除 scheduler body；
- [ ] single/multi-repo、readonly、dirty subtraction、malformed/resume/re-entry、conflict-human corpus 全绿；
- [ ] 保持 `git_diff` wire 与 exact error/status。

退出：`wrapper-git` 只有 WrapperRuntime 一个生产 entry；旧/在途 row 可原位续跑。

### T7 — FanoutStrategy outer-shell 原子 cutover（Pending）

- [ ] 迁 input hydration、consumed/reuse gate、empty/cartesian/scope/key；
- [ ] 迁 current shard/aggregator attempts、pool/retry/salvage/merge/output；
- [ ] wrapper-fanout registry entry 同批切新 strategy并删除 scheduler body；
- [ ] fanout empty/shard/aggregator/broadcast/concurrency/resume/collision/failure corpus 全绿；
- [ ] source/behavior guard确认 inner-chain 与非 agent-single current限制既不扩也不缩；
- [ ] common helper 最后 consumer 消失后删除，不复制两份。

退出：`wrapper-fanout` 只有 WrapperRuntime 一个生产 entry；W8 未启动。

### T8 — ExecutionMergeRecovery cutover（Pending）

- [ ] 迁 pending-merge replay；
- [ ] 迁 conflict-human completion；
- [ ] TaskEngine application 注入 recovery，并保持两 replay → root scope 顺序；
- [ ] 删除 taskEngineApplication → scheduler 两条 replay import/export；
- [ ] pending tree/submodule/physical iso/merge-agent/human-resolve/crash corpus 全绿。

退出：replay 只有 task-execution recovery 一个 owner；不成为 wrapper kind。

### T9 — bootstrap driver/topology cut（Pending）

- [ ] `composeTaskExecutionRuntime` 只在 server/CLI/test bootstrap 调用；
- [ ] `buildStartTaskDeps` 接显式 SchedulerDriverPort；
- [ ] 迁完 route/schedule/webhook/workgroup/fusion/development/digital-employee/CLI 全 caller；
- [ ] 删除 `createLegacyTaskExecutionTopology` 与 startTaskDeps internal import；
- [ ] scheduler 的 source-termination dependency 改走 existing public vocabulary；
- [ ] 不新增 global singleton/setter、public internal re-export 或 optional fallback。

退出：bootstrap 之外没有 concrete task-execution composition；所有 caller 功能保持。

### T10 — legacy extinction 与 canonical artifacts（Pending）

- [ ] scheduler 10 个 W2-D symbols=0；
- [ ] scheduler→nodeMechanics reverse imports=0；scheduler→task internal imports=0；
- [ ] nodeExecution→scheduler wrapper imports=0；
- [ ] legacy wrapperProgress/fanout files/facade=0；
- [ ] 重放 canonical manifests/report；只删除真实消失的 exact exceptions；
- [ ] task-execution-containing SCC=0，global backend/repo SCC ≤ `4/6`，KNOWN ≤31；
- [ ] 不改 W3/W5 symbol owner，不倒签后续 wave。

退出：RFC-294 W2-D architecture gates 全绿，无新增 exception 抵账。

### T11 — 功能回归、发布、hosted/scheduled closeout 与文档关闭（Pending）

- [ ] 跑全量 current wrapper/replay/nesting/cancel/retry/recovery characterization（由 hosted CI 执行）；
- [ ] 精确 stage/commit owned paths，验证 committed paths 与 `Co-Authored-By`；
- [ ] fetch/sync/push shared main，证明 remote ancestry；
- [ ] exact-SHA 主 CI 所有 required jobs terminal success；
- [ ] 重新枚举仓库当时所有 `on.schedule` workflow，逐条 dispatch并验证全部 jobs terminal success；
- [ ] proposal/design/plan、RFC294、design/plan.md、STATE.md 回填实现与 CI 证据；
- [ ] RFC-339 置 Done，RFC-294 只关闭 W2-D；W3 仍待新 RFC/批准。

## 4. 建议提交边界

| commit | 内容                                                | production cutover  |
| ------ | --------------------------------------------------- | ------------------- |
| C0     | RFC 三件套 + index/state/RFC294 refresh             | 否                  |
| C1     | source-lock/characterization/red architecture gates | 否                  |
| C2     | scope/progress/fanout pure contracts                | 否                  |
| C3     | ports/common runtime/composition skeleton           | 否                  |
| C4     | LoopStrategy cut                                    | 是，仅 loop         |
| C5     | GitStrategy cut                                     | 是，仅 git          |
| C6     | FanoutStrategy cut                                  | 是，仅 fanout       |
| C7     | merge recovery cut                                  | 是，仅 replay owner |
| C8     | bootstrap/topology + legacy extinction              | 是，composition     |
| C9     | canonical payload/provenance                        | 否，账本            |
| C10    | closeout/docs                                       | 否                  |

每个 production commit 都必须可单独正常反向 commit；不能把已切 kind 留成“新旧同时可达”。共享 main 若有并发内容，只按
owned exact allowlist 提交并完整保留共享文件里的他人输出。

## 5. 必跑回归族

### 5.1 wrapper common / scope

- wrapper scope dependencies、intra-scope cycle、nested membership；
- RFC-040 awaiting bubble；RFC-095 canceled revival/scope outcome；
- RFC-098 stale/revival/consumed/status；RFC-230 finalize superseded；
- branch activation、review/clarify/question inside wrapper。

### 5.2 loop

- exit condition all modes、dangling ref validation、output binding；
- max exhausted/continue；nested loop guard；git/fanout legal nesting；
- approve/clarify mid-run and daemon resume。

### 5.3 git/recovery

- wrapper-private canonical、cumulative diff/preDirty、diff failure；
- multi-repo/read-only/submodule；merge conflict/human resolve；
- pending-merge crash replay、physical iso identity、stale re-entry。

### 5.4 fanout

- empty source、shard split/key collision/cartesian cap；
- non-shard broadcast、pool/concurrency/cancel/failure；
- reuse/hash rerun、duplicate resume、salvage/undo；
- aggregator once/output rename/provenance；current inner-kind limits。

### 5.5 architecture

- RFC-294/317/331/332/333/334/338 combined guards；
- canonical replay/tamper/provenance；
- import/layer/owner/wave/exception/SCC gates；
- single-binary initialization-cycle smoke 由 hosted CI 覆盖。

## 6. AC 证据账本

| AC        | 主要任务             | 状态    |
| --------- | -------------------- | ------- |
| AC-1～2   | T2                   | Pending |
| AC-3～4   | T4～T7/T10           | Pending |
| AC-5      | T5                   | Pending |
| AC-6      | T6                   | Pending |
| AC-7      | T7                   | Pending |
| AC-8      | T3                   | Pending |
| AC-9      | T8                   | Pending |
| AC-10     | T4/T10               | Pending |
| AC-11～12 | T9/T10               | Pending |
| AC-13～15 | T10                  | Pending |
| AC-16～17 | all production tasks | Pending |
| AC-18     | T11                  | Pending |

## 7. 停止门与回滚

立即停止实施并重新请批，如果：

- current source inventory 与本 RFC 不同且改变合同/切换顺序；
- 需要 migration、wire/config/status/error/UI/permission 变化；
- 需要新增拒绝、限制或删除正常能力；
- per-kind 无法在同一 commit 删除旧 production path；
- old in-flight progress/merge/iso 无法原位恢复；
- fanout 必须开启 inner-chain 才能迁移；
- 必须新增 KNOWN/architecture exception 或 service locator 才能通过；
- W3/W5 行为必须提前重写才能完成 W2-D。

回滚只用正常反向 commit恢复唯一旧 path；不使用 feature flag、dual runtime、stash/reset/rebase/force push，不删除并发工作。

## 8. 完成后的下一步

RFC-339 Done 后，RFC-294 W2-D 关闭。下一架构节点是 **W3 Lifecycle committed events + Collaboration commands** 的
current-source 调研与独立 RFC；W4/W5/W6/W7/W9 仍按 DAG，W8 继续可选。RFC-339 的完成不自动授权任何 successor。
