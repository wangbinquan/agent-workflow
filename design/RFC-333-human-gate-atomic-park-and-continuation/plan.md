# RFC-333 实施计划：人工门原子停驻与持久续跑

> 状态：Done（2026-08-28；T0～T12、AC-1～AC-17 全部完成；D13 是用户要求继续完成 RFC-333 后纳入
> T12 的同权威交接精化；最终 exact-SHA 主 CI 35/35 与全部七条 scheduled workflow 共 19/19 jobs 均成功）
>
> 批准边界：批准本 RFC 才授权下述 P0-C 生产实现。它不授权 RFC-294 W2-C/D、W3、W4、W5，
> 不授权权限/安全策略或任何正常能力收缩。

## 1. 实施原则

1. 先锁 current 功能 oracle，再改事务边界；任何既有正常能力变化先回到 RFC 修订与用户裁决。
2. 复用 RFC-328 intent/owner/fence 与 RFC-332 coordinator；新增 operation 只管理 gate command/artifact，不管理 task drive。
3. open 与 decide 各有明确线性化点；不能发布“新领域写 + 旧 route resume”或“新 doc manifest + 旧逐项可见 insert”的半态。
4. DB 外效果先 prepare/journal，最终 transaction 不做 FS/worktree/WS/runtime I/O。
5. 每个 gate vertical slice 可独立切换，但已切 slice 必须同时有 fault matrix、recovery 与 architecture guard。
6. REST/MCP/UI 功能面保持；route 只做 inbound facade，MCP 继续派发相同 route。
7. manual question 保持 current 可创建范围；不从 HTTP route 抢 active execution owner。
8. 实现门只审功能正确性、恢复和模块边界，不增加安全策略。
9. 人工决定可在已启动 sibling 未结束时提交；只允许同一 intent/coordinator authority 的 claimed→pending successor 交接，
   不取消已启动工作、不新建第二队列或 worker。

## 2. 当前事实与 source-lock

current source pin：`52645b673f6c25d26f629b85b5acaeba5b01e0d1`。相对前一架构提交的 first-admin 前端 delta
不触及 C1～C14。T2 开工前重跑 inventory；若调用链漂移，先更新本表，
不得把旧行号当真值。

| 编号 | current fact                                                                   | source/symbol                                                      | target                                             |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------- |
| C1   | review route 决定后直接 resume                                                 | `routes/reviews.ts` / `submitReviewDecision` → `resumeTask`        | collaboration command 内 final tx + durable intent |
| C2   | clarify route dispatch 后直接 resume                                           | `routes/clarify.ts` / `autoDispatchClarifyRound` → `resumeTask`    | 同上                                               |
| C3   | questions route dispatch 后直接 resume                                         | `routes/taskQuestions.ts` / `dispatchTaskQuestions` → `resumeTask` | 同上                                               |
| C4   | review node/doc 创建先于 task park                                             | `services/review.ts#dispatchReviewNodeUnlocked`                    | prepared review manifest + TaskParkTx              |
| C5   | doc file 先写、DB row 后写，多文档逐项调用                                     | `services/review.ts#createDocVersion`                              | staged artifacts + all-doc manifest                |
| C6   | clarify node run 与 round 分写，随后直接 WS                                    | `services/clarify/service.ts#createClarifyRound`                   | prepared manifest + TaskParkTx + after-commit WS   |
| C7   | task questions 仍有 lazy reconciliation                                        | `services/taskQuestions.ts#reconcileRoundEntriesTx`                | 新 round eager snapshot；fallback 只读历史         |
| C8   | review decision 已有 RFC-326 单事务 seed                                       | `services/review.ts#submitReviewDecision`                          | task participant + rollback plan/existing effect   |
| C9   | question dispatch 的 domain writes 已有 tx，但 lifecycle/intent 在 route 外    | `services/taskQuestionDispatch.ts`                                 | 扩为 CollaborationDecisionTx                       |
| C10  | canonical continuation insert 已存在                                           | `modules/task-execution/application/submitTaskContinuation.ts`     | 原样复用                                           |
| C11  | task lifecycle CAS + onClaimTx + intent 可同 tx                                | `services/task.ts#resumeTaskWithAtomicSideEffects/#resumeKick`     | 提成 task-execution public participant             |
| C12  | workgroup gate 已使用同形窄路径                                                | `services/workgroup/taskActions.ts`                                | 作为行为范例，不搬其领域规则                       |
| C13  | 已有 restart E2E 只覆盖 parked 后 kill                                         | `e2e/rfc294-human-gate-restart.spec.ts`                            | 扩为 boundary crash matrix                         |
| C14  | RFC-329 MCP tools 派发既有 REST routes                                         | MCP tool registry/dispatch guards                                  | 保持 route/tool exact mapping                      |
| C15  | completion-driven DAG 可让 gate 先可决定而慢 sibling 仍在 claimed owner 下运行 | `taskDagScope#runScope` / RFC-092 mid-run review                   | one claimed + one pending successor；drain/handoff |
| C16  | auto-dispatch-deferred manual question 已不需用户行动，但仍会触发 initial park | `sqliteHumanGateOpenParticipant` / questions-board full-tier       | obligation 让位给 runnable predecessor             |

T2 source-lock 必须同时锁：三条 direct resume 数量、open/park 分写入口、doc FS→DB 顺序、现有 intent gateway 与 route/MCP mapping。

## 3. 实施波次

### T0 — current inventory 与 RFC 三件套（本轮完成）

- 对拍 RFC-294 P0-C、RFC-326/328/329/332 已落边界；
- 盘点 review/clarify/questions open、decision、route、MCP、UI、restart/recovery；
- 固定 D1～D12、能力影响、fault matrix、module boundary；D13 在 T12 的真实并行回归中补记；
- 回链 RFC-294、总索引与 STATE。

退出：RFC 草案内部链接与 markdown 检查通过；无生产代码变化。

### T1 — 用户批准门（已完成，2026-08-27）

用户逐项批准或修改 D1～D12，尤其确认：

- operation/artifact 两张窄表；
- open=`TaskParkTx`、decide=`CollaborationDecisionTx`；
- route 成功响应不再含 internal resume failure；
- optional/derived idempotency key compatibility；
- manual question 的 durable park obligation；
- W2-C/W3 仍不随本 RFC 自动授权。

用户已以“ok”批准 D1～D12 与 T2～T12；2026-08-28 hosted 回归暴露 C15 后，用户明确要求继续完成 RFC-333
并提交，因此 D13 作为 D3/D12 范围内、不扩产品面的修正纳入 T12；随后 scheduled full-tier 暴露 C16，按既有 D10/D12
功能边界修复。W2-C/D、W3、W4、W5 未随本 RFC 获得生产实现授权。

### T2 — characterization、source-lock 与 red fault tests（已完成，2026-08-27）

新增/扩展测试，先证明旧实现在哪些边界为红：

- review single/multi/empty 与 decision 全功能 oracle；
- clarify self/cross/re-emit/partial/full/directive；
- question eager snapshot/manual create/batch dispatch/targeted rerun；
- REST/MCP response 与 UI current behavior；
- deterministic failpoints：prepare、artifact N、transaction mutation、wake、WS；
- architecture red guard：route direct resume、commit 前 WS、逐 doc visible insert。

禁止为了让 red test 通过先改断言；每个 current behavior 与 target invariant 分栏记录。

完成证据：

- `rfc333-human-gate-source-locks.test.ts` 以 TypeScript AST 锁住三条 route 的真实 call expression（恰好 3 个
  `resumeTask`）、command→resume 顺序、REST↔MCP exact mapping、UI resume-warning、review FS→DB 顺序、clarify
  node→round→WS 分段、lazy question reconciliation 与 RFC-328 canonical participant；内存 mutation 证明删除生产 call 会转红；
- `rfc333-human-gate-open-fault-baseline.test.ts` 用真实 SQLite trigger 在 review 第 2 个 doc row 与 clarify round insert
  精确引爆，分别复现“1 row + 2 canonical files + orphan review run”与“0 round + orphan awaiting_human run”，commit 前均 0 WS；
- 上述两文件连同 review/clarify/questions/manual/MCP 既有 15 个 oracle 文件合跑：`216 pass / 0 fail / 967 expect`。
  这些 current-debt witness 在 T6/T7 cutover 时必须同提交翻转为目标零可见状态，不得长期保留旧行为断言。

### T3 — collaboration domain/public contracts 与 additive schema（已完成，2026-08-27）

- 新增 `modules/collaboration/domain/humanGateOperation.ts`、canonical request/hash 与 receipt；
- 新增 public command/query/types 与双方 required participant ports；
- 按开工时 migration head 新增 `collaboration_gate_operations`、`collaboration_gate_artifacts`；
- 建 idempotency、state/receipt、`result_gate_revision`、artifact state 与 active exact-gate constraints；
- 为切换时仍 open 的 legacy gate 建一次性 `legacy-seed` operation/revision，重复 recovery 不得重 seed；
- repository contract tests + real SQLite migration/rollback/replay tests；
- 暂不接生产 route/engine，legacy 行为不变。

退出：additive schema 可独立存在且 production consumer=0；无第二 continuation/owner/worker。

完成证据：

- 0212 新增两张窄表、唯一 revision/idempotency/active-gate 约束、committed receipt immutable trigger；rolling upgrade 从
  多个历史 idx 到 HEAD 后仍能跑完 toy task；
- `SqliteHumanGateOperationStore` 落 exact-key replay、hash/actor conflict、claim/state CAS、artifact 全集约束与一次性
  `legacy-seed`；canonical request 保对象键无关、数组保序，并把 actor/task/gate revision 纳入 hash；
- `rfc333-human-gate-operation-store.test.ts`、`rfc333-migration-human-gate-operations.test.ts` 与全库 migration statement
  policy 合跑 `13 pass / 0 fail / 57 expect`；backend `tsc --noEmit` 通过；production route/engine consumer 仍为 0。

### T4 — prepare journal、artifact store 与 recovery phase（已完成，2026-08-27）

- 实现 purpose-specific review doc staging、digest、atomic final rename、cleanup；
- 实现 review rollback 的 snapshot check-only + 幂等 plan prepare；plan 在 T5 final tx 中进入既有 RFC-328
  `workspace-rollback` effect，不在 collaboration 自建执行队列；
- 实现 claim epoch/expiry 与 operation recovery；
- 注册既有 maintenance ticker phase，不新增 native interval；
- artifact reader 支持 committed-but-not-finalized 的 staged fallback；
- 跑 open/decision prepare fault matrix。

退出：所有 operation state 都可重放/清理；recovery 不调用 task drive。

完成证据：

- `FsHumanGateArtifactStore` 以 operation-private staging、SHA-256/byte-size journal、同文件系统 rename 与幂等 cleanup
  收敛 review body；committed→finalized 窗口由 staged fallback 读取同一 digest；
- `HumanGateOperationRecovery` 用 expiry + 单调 claim epoch 处理 preparing retain、prepared stale cleanup、committed
  roll-forward 与 cleanup_pending completion；`humanGateRecoveryTicker` 只复用 `startMaintenanceTicker`，boot 装配留 T10；
- rollback preparer 在返回 plan 前对全部非空 snapshot 做 check-only，固定 target order/resource key/digest；不修改 worktree；
- `rfc333-human-gate-artifact-recovery.test.ts` 5 项覆盖 commit→rename、一次 finalize 故障后重试、stale cleanup、claim
  fencing、no task-drive/no native timer；`rfc333-workspace-rollback-plan.test.ts` 2 项覆盖确定性与 missing snapshot
  零 plan。连同 T3/迁移 policy 合跑 `20 pass / 0 fail / 92 expect`，backend typecheck 通过。

### T5 — task-execution in-transaction participants（已完成，2026-08-27）

- 从现有 `resumeTaskWithAtomicSideEffects/resumeKick` 提炼 `TaskDecisionParticipantInTx`；
- 复用 `submitTaskContinuationTx(kind='gate-continuation')` 与 task lifecycle writer；
- participant 在同一 transaction 为 rollback-bearing continuation 追加既有 `task_execution_effects(kind='workspace-rollback')`；
- coordinator 增加 gate-continuation pre-drive effect phase：先结算 effect/`rolledBack` projection，再进入 engine；
- 建立 `HumanGateOpenParticipantInTx` adapter 与 `TaskParkTx` consumption seam；
- participant 只接 opaque refs/exact transition variant，不接 raw callback bag/DB repository；
- workgroup 当前生产路径保持，必要时只复用底层 participant，不改业务语义。

退出：真实 SQLite transaction 证明 domain callback、task/node CAS、intent/event 任一抛错全回滚；每个决定 exact one new
gate intent，且每个 task 最多一个 claimed current + 一个 pending successor。

完成证据：

- `writeTaskStatusTx` 保持 `tasks.status` 唯一物理 writer，新增封闭的 review/human park/release transaction variant；
  `TaskDecisionParticipantInTx` 只接 exact projection fence/opaque refs，在同 tx 生成 lifecycle outbox、exactly-one
  `gate-continuation` intent 与 optional linked RFC-328 `workspace-rollback` effect；
- collaboration 的 `HumanGateOpenParticipantInTx` 验证 prepared manifest/artifact 全集并由 owned `TaskParkTransaction`
  同笔消费；任何 task park 失败都把 operation 留在 `prepared`；
- `GateContinuationEffectStep` 在 coordinator 的独立 blocking phase 内取得 exact owner/epoch、复用 effect attempt/fence/receipt，
  projection 与 receipt 同 tx，且 background receipt 与 engine 都排在它之后；无 linked effect 直接通过；
- `rfc333-task-participants.test.ts` 5 项以真实 SQLite trigger 覆盖 park、projection、lifecycle event、intent 与 linked effect；
  `rfc332-task-drive-coordinator.test.ts` 锁住 phase 顺序/失败归属。连同 RFC-328 architecture guard 与 lifecycle direct-write
  ratchet 合跑 `25 pass / 0 fail / 97 expect`，backend `tsc --noEmit` 通过。生产 route/engine cutover 留 T6～T9。

### T6 — review open vertical cut（已完成，2026-08-27）

- `dispatchReviewNodeUnlocked` 改为 prepare complete round；
- TaskEngine park outcome 携 `PreparedHumanGateRef`；
- TaskParkTx 一次提交 review node projection、全部 `doc_versions` manifest、task `awaiting_review` 与 events；
- 空列表继续 RFC-202 auto-approve，不创建不可见 empty gate；
- 删除新路径逐 doc `createDocVersion` visible insert；历史 read 保持。

退出：single/multi/empty、inheritance、restart 与 open fault matrix 全绿；无 partial docs/ghost WS。

完成证据：

- `dispatchReviewNodeUnlocked` 的新开门与 source-refresh 均先生成完整 immutable manifest；operation-private staging
  成功后，collaboration participant 在 task-execution owned `TaskParkTx` 内一次提交 review node、全部
  `doc_versions`、旧轮次 supersede/comment cleanup、source provenance、operation revision、task park 与 committed event；
- gate identity 固定到 review node run，source digest 变化创建同 gate 的下一 operation revision；每轮 body path 含 operation
  identity，v1 不会被 v2 覆盖。commit→rename 窗口继续由 digest-checked staged reader/recovery 收敛；WS 只在 commit 后发布；
- RFC-202 空列表仍不创建 visible gate；已停驻轮次刷新为空时，旧轮次退役、review auto-approve 与 task release 同事务；
  已泄漏的历史 pending/missing-doc 修复路径保留为 legacy compatibility，不再承载新开门或 source refresh；
- 真实 SQLite trigger 覆盖第 2 个文档失败、task park 失败与 refresh projection 失败，均证明零 partial visible state、旧轮次
  不受损且相同 prepared operation 可重试。28 个 `dispatchReviewNode` 相关文件合跑 `190 pass / 0 fail / 955 expect`；
  RFC-333 七文件回归 `32 pass / 0 fail / 189 expect`，backend typecheck 与本批 ESLint 通过；canonical N1b payload 已按
  current source 重生成并逐字相等，四份 N1a snapshot provenance 随本次 T7 发布的归一化/重钉提交固定。

### T7 — clarify open + eager question snapshot vertical cut（已完成，2026-08-27）

- `createClarifyRound` 拆为纯 prepare + in-tx commit participant；
- self/cross node projection、round、task questions snapshot、task park 与 events 同 tx；
- 新 operation 禁止依赖 lazy reconciliation；历史 fallback 标识与删除门落测；
- manual question 同 tx 写 row + park obligation，active owner 在 settle point 消费。

退出：self/cross/re-emit/iteration/truncation/manual question/current task-state matrix 全绿；node/round/task 不再分裂。

完成证据：

- `createClarifyRound` 先准备 immutable operation manifest，再由 owned `TaskParkTx` 在同一 SQLite transaction 提交
  self/cross node projection、clarify round、eager `task_questions`、operation revision、task park 与 lifecycle/event；WS 只在
  commit 后发布，exact re-emit 重放同一 round，source 变化才推进 stable gate；
- manual question 在一笔 transaction 内写 question row 与 durable park obligation，不改 HTTP 当下 task/owner；active owner 在
  三个 engine settle point 消费 obligation，terminal task CAS 同 tx 拒绝遗漏的 prepared obligation；pending/running/
  awaiting_review/awaiting_human/failed/interrupted 创建能力保持；
- task-execution 以 opaque `TransactionScope` 消费 collaboration required port，lifecycle/ORM/node projection 实现落到
  infrastructure；九条 legacy internal/composition 直连压成一条具名 `humanGateComposition` bridge，新增 R2=0，value SCC 保持
  backend/repo `4/6`；RFC-294 preflight `13/13`、RFC-317 boundary `25/25`、ledger/guard 定向门均绿；
- RFC-333 + clarify/cross-clarify/scheduler/review-refresh/RFC-202/RFC-332 共 14 文件合跑 `105 pass / 0 fail / 527 expect`；
  backend typecheck 通过。architecture N1b/current report 已按 live source 重生成，四份 N1a snapshot provenance 随本次 T7
  发布的归一化/重钉提交固定。

### T8 — review decision vertical cut（已完成，2026-08-28）

- 保留 RFC-326 全量预校验与 review domain transaction 顺序；
- rollback 改为 T4 validated idempotent plan；不在 final tx 前修改 canonical worktree；
- final tx 调 T5 participant，提交 node/task + one continuation intent + optional linked `workspace-rollback` effect；
- coordinator 在下游 rerun 前结算 effect receipt 与 `rolledBack`/marker projection；
- distill enqueue 保持 commit 后既有边界；
- route 暂仅调用新 command/query，删除 direct resume/rollback。

退出：approve/reject/iterate、single/multi/comments/selections/anchor/history/rollback fault matrix 全绿；retry 返回同一 receipt。

完成证据：

- `ReviewDecisionCommand` 将 request hash、actor/revision、domain decision、node/task projection、optional
  `workspace-rollback` effect 与 exact one `gate-continuation` intent 收进同一 final transaction；same-key replay 返回同一
  receipt，stale/conflict/任一 mutation failure 都是零部分写；
- `reviewDecisionComposition` 只在 commit 后触发 canonical wake，route 不再直接 rollback/resume；approve/reject/iterate、
  comments/selections/anchor/history、distill enqueue 与 RFC-326 batch zero-write 语义保持；
- RFC-326 review transaction/MCP 邻接回归与 RFC-333 fault/source lock 进入最终 backend 定向合跑，未出现能力收缩。

### T9 — clarify 与 questions decision vertical cut（已完成，2026-08-28）

- clarify partial answer 只前进 gate revision、不 release；full/directive 分支 final tx 追加 intent；
- question dispatch 的 answer stamping/reruns 与 task participant 同 tx；
- 两条 route 删除 direct resume 与内部 resume response；
- actor-filtered query 映射既有 wire；MCP 不改 tool name/path。

退出：三类 route direct `resumeTask`=0；stale/concurrent/retry/commit→wake crash matrix 全绿。

完成证据：

- `ClarifyDecisionCommand` 保持 partial answer 不 release，full/directive release 在 final transaction 同时提交 answer、node/task
  projection、receipt 与 canonical intent；`QuestionDispatchCommand` 同事务提交 answer stamping、targeted rerun projection、task
  transition 与 exact one intent；
- `rfc120-deferred-dispatch.test.ts` / `rfc128-p5-d-autodispatch.test.ts` 的真实 SQLite fault 注入证明 dispatch 中途抛错全回滚；
  same-key replay、hash conflict 与 stale revision 由三类 composition/domain 测试锁定；
- reviews/clarify/taskQuestions 三条 route 的 production `resumeTask` 已归零，RFC-333 source-lock 以 mutation fixture 证明任一
  direct resume 回流都会转红。

### T10 — route/MCP/UI compatibility closeout（已完成，2026-08-28）

- optional `Idempotency-Key` + compatibility derived key；
- view/official clients 显式回传 task/gate revisions；过渡期缺字段由 facade 在 operation 快照阶段捕获，final tx 仍做 CAS；
- 保持既有 route schema/tool dispatch，更新 response type 去掉 internal resume failure；
- UI 删除三处“决定成功但 resume 失败”的补偿提示，保留真实 command rejection/conflict；
- RFC-202 source-lock 改为 durable receipt/query replay + route thin facade；
- RFC-326/329 route↔MCP guards 全绿。

退出：REST/MCP 相同输入得到相同业务结果；没有 MCP-only writer 或 UI 手工 resume。

完成证据：

- shared 新增统一 human-gate committed response schema，review/clarify 显式复用；REST 继续兼容可选
  `Idempotency-Key`，MCP 仍 dispatch exact REST route，未形成 MCP-only writer；
- 前端三处内部 resume 补偿提示/类型已删除，只保留真实 command rejection/conflict；相关 Vitest 8 文件
  `100 pass / 0 fail`，shared schema `2 pass / 0 fail`；
- RFC-202/326/329 source/route/tool guards 已改锁 durable receipt、thin facade 与 exact mapping。

### T11 — process crash E2E、full regression 与 architecture artifacts（已完成，2026-08-28）

- 扩 `e2e/rfc294-human-gate-restart.spec.ts` 覆盖 review/clarify/questions boundary kill；
- 跑 review/clarify/questions 定向 backend/frontend/E2E；
- 跑 migration、transaction、recovery、maintenance、RFC-328/332 coordinator 回归；
- 更新 RFC-294 canonical owner/public/facade/mutation/exception/background manifests；
- mutation tests 证明 route resume、第二 intent queue、commit 前 WS、partial docs 会被咬住；
- task candidate 不变时只跑一次 full local gate。

退出：所有 AC 有 durable CI assertion 或 process E2E；canonical replay 与 source digest 对齐。

完成证据：

- e2e-only compiled barrier 精确停在 decision commit 后、wake 前；真实二进制经外部 SIGKILL/restart 覆盖 clarify、review、
  questions 三类 continuation，并保留原 parked identity restart 旅程，Playwright `3 passed`；生产 binary 不编译该 barrier；
- boot 新增 exact pending `gate-continuation` recovery；orphan reaper 只豁免“task 与全部相关 run 均 pending + exact pending
  gate intent”的恢复形状，存在任何 running row 仍走旧 reap。RFC-333 recovery/orphan 邻接 `12 pass / 0 fail`，RFC-098
  正常进程权限复跑 `5 pass / 0 fail`；
- 最终 backend 定向聚合 `286 pass / 0 fail / 1279 expect`，frontend `100/100`，shared `2/2`，backend typecheck、
  task-owned lint/format 与 E2E 均绿；
- N1b/current architecture artifacts 已从 live source 重生成；非 provenance architecture 定向门 `23 pass / 0 fail`，
  canonical `18 pass` 且只剩四份按设计等待 payload commit 后重钉的 current provenance mismatch。

### T12 — 文档关闭、发布与 hosted 收口

- 修复 hosted 回归暴露的 legacy contract 漂移与 C15：决定 participant 在一个 claimed current intent 后只准入一个 pending
  gate successor；旧 DAG owner 停止新 frontier、排空已启动 sibling 后 handoff，同一 coordinator claim exact successor；
- migration 0213 以 claimed/pending 两个 state-specific unique index 取代旧合并 active index；普通 continuation admission、
  第二 pending successor 与第二 claimed owner 继续冲突；
- 更新受到 durable receipt/rollback receipt 精确化影响的旧功能 fixtures，不删除或削弱既有功能断言；
- handoff 修复 payload `71008fde0407a8cf85ca59322bb34ff5d5d56597` 已覆盖真实 coordinator 慢 sibling 与
  claimed + pending 约束；scheduled full-tier 又照出 C16：auto-dispatch-deferred manual question 被误当作仍待用户处理，
  `initialManualPark` 因而在 runnable predecessor 前重停任务；
- C16 修复 payload 为 `dda58935ec62b62ec1c962628af3af21edf0e9da`：只有 `autoDispatchDeferredAt === null` 的 manual
  question 才继续构成 open park obligation；deferred entry 把执行权让给 runnable predecessor，真实 participant/auto-dispatch
  邻接 `68/68` 与 backend typecheck 通过；
- canonical source digest 已更新为 `sha256:5b8ec81fe95772f5157d01fb87d5c1c5b9c44070be63c827b469a9700b9e3ef4`，四份
  provenance 均指向 payload `dda58935e`，repin/containing SHA 为 `57e45c292acec81d8f8cf27fceade4f44369a462`；
- exact-SHA 主 CI `33123261690` 为 35/35 success；全部七条 scheduled workflow：full `33124599820` 5/5、
  WebKit `33124596764` 8/8、soak `33124598119` 1/1、git protocols `33124599211` 1/1、OpenCode
  `33124598897` 2/2、visual `33124598027` 1/1、Windows `33124598161` 1/1，均 terminal success；
- RFC-333、AC 账与 RFC-294 P0-C 已关闭；下一指针改为 W2-C，但生产实现仍须新 RFC 与明确批准。

退出：真实 SQLite constraint test、RFC-092 慢 sibling coordinator E2E、deferred-question handoff、remote ancestry、exact-SHA
required jobs 与全部 scheduled workflows 均 terminal success；无未记 blocker。**T12 Done。**

## 4. 建议提交边界

共享 main 上只使用短 publication critical section。建议按可独立验证的纵切提交：

| 提交 | 内容                                                        | production 状态                          |
| ---- | ----------------------------------------------------------- | ---------------------------------------- |
| A    | T2 characterization/source-lock/failpoint harness           | 旧行为不变，target tests 可显式 red/skip |
| B    | T3 additive contracts/schema + T4 inactive journal/recovery | 无 gate production cutover               |
| C    | T5 participant + T6 review open                             | review open 原子闭合                     |
| D    | T7 clarify/question open                                    | clarify open 原子闭合                    |
| E    | T8 review decision + route                                  | review decision durable continuation     |
| F    | T9/T10 clarify/questions decision + all facades/UI          | 三类 route saga 归零                     |
| G    | T11/T12 E2E/canonical/docs closeout                         | P0-C 完整退出                            |

若某个提交无法让其已切 production slice 自洽，就合并到下一提交后再发布；不以 feature flag 长期保留双 writer。

## 5. 测试矩阵

### 5.1 open matrix

| gate            | case                                      | DB invariant                       | artifact/event invariant     |
| --------------- | ----------------------------------------- | ---------------------------------- | ---------------------------- |
| review          | single doc                                | one gate + one doc + parked task   | exact digest；commit 前 0 WS |
| review          | multi 0                                   | no parked gate；auto-approved flow | no artifact                  |
| review          | multi 1/3                                 | all docs same generation/manifest  | no partial item              |
| review          | source refresh race                       | one exact source winner            | stale staging cleanup        |
| clarify self    | new/re-emit                               | stable same-round identity         | eager questions exact        |
| clarify cross   | next iteration                            | one monotonic round                | no split node/round          |
| manual question | running/parked/pending/failed/interrupted | row+obligation atomic              | no route owner steal         |

每行依次在 operation insert、每个 artifact、prepared、TaskParkTx mutation、commit、roll-forward、WS 注入故障。

### 5.2 decision matrix

| gate      | branches                                                         | must share final tx                                      |
| --------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| review    | approve/reject/iterate；single/multi/subset；comments/selections | decision + node + task + intent + event                  |
| clarify   | partial/full/defer/stop/current directives                       | release 分支：answer + node + task + intent + event      |
| questions | all/partial validation、targeted rerun、多 asker                 | stamping + rerun projections + task + one intent + event |

每行覆盖 same-key replay、key/hash conflict、stale task、stale gate、two actors、cancel race、commit→wake kill、wake→response kill，
以及 gate 已可决定但同 scope sibling 仍 in-flight 的 claimed→pending handoff。

### 5.3 regression corpus

- RFC-202 review empty-list/source-lock/UI；
- RFC-294 human-gate restart；
- RFC-326 review persistence/anchor/batch/MCP/highlight；
- RFC-328 owner/intent/fence/recovery/lifecycle outbox；
- RFC-329 route/tool exact inventory；
- RFC-332 coordinator/engine park-settle/recovery；
- review/clarify/taskQuestions/service/route/frontend current suites。

## 6. AC 证据账本

| AC    | 实现前                              | 目标证据                                           | 状态         |
| ----- | ----------------------------------- | -------------------------------------------------- | ------------ |
| AC-1  | current inventory 已完成            | source-lock + exact production inventory           | T2 Done      |
| AC-2  | open/park 分写                      | real SQLite TaskParkTx fault tests                 | T6/T7 Done   |
| AC-3  | doc FS→DB 逐项                      | N-member artifact fault/recovery matrix            | T4/T6 Done   |
| AC-4  | lazy question reconciliation        | eager snapshot + legacy-only guard                 | T7 Done      |
| AC-5  | route resume saga                   | three CollaborationDecisionTx suites               | T8/T9 Done   |
| AC-6  | route direct calls=3                | architecture negative guard=0                      | T9 Done      |
| AC-7  | route-level retry                   | idempotency/stale/concurrent matrix                | T8/T9 Done   |
| AC-8  | parked-only restart                 | commit→wake process kill/recovery                  | T11 Done     |
| AC-9  | rollback 在 final tx 前裸执行       | plan→effect→receipt→projection fault matrix        | T5/T8 Done   |
| AC-10 | manual question current behavior    | all-state + owner-settle + deferred handoff tests  | T7/T12 Done  |
| AC-11 | some direct created WS              | commit-before-WS failpoints                        | T6～T9 Done  |
| AC-12 | parked restart only                 | process E2E + REST/MCP exact route guard           | T10/T11 Done |
| AC-13 | RFC-326 Done baseline               | full adjacent corpus unchanged                     | T8/T11 Done  |
| AC-14 | RFC-328/332 already unique          | canonical inventory + mutation                     | T5/T11 Done  |
| AC-15 | target boundary only in RFC-294     | manifest/guard exact assertions                    | T11 Done     |
| AC-16 | project hard boundary               | functional-only gate record                        | T0～T11 Done |
| AC-17 | gate decision 可早于慢 sibling 完成 | SQLite state constraint + real coordinator handoff | T12 Done     |

## 7. 停止门与回退

### 7.1 立即停止实施

出现以下任一情况，停止当前 cutover 并修订 RFC，不向旧 saga fallback：

- 需要第二 continuation/owner/worker 才能推进；
- 需要在 DB transaction 内等待 FS/worktree/runtime/WS；
- route 必须拿 continuation id 或 runtime handle 才能返回；
- manual question 只能通过强抢 active owner 才能保持；
- review/clarify/questions 任一 current 正常能力必须被删除或限制；
- 一个 gate slice 不能在单次 production cut 中同时移除旧 writer/resume path。

### 7.2 回退策略

- T3/T4 未启用的 additive schema/contracts 可留存，不影响 legacy 行为；
- 已切 vertical slice 只允许通过正常反向 commit 回退整个 slice，不能临时双写或 route fallback；
- committed operation/intent 必须先由同版本 recovery 收敛，再切回旧 reader；
- plan/artifact cleanup 只处理 RFC-333 staging namespace，不触碰 canonical user artifacts 或其他 session 文件。

## 8. 完成后的下一步

RFC-333 完整 Done 后，RFC-294 下一节点变为 **W2-C NodeExecutorRegistry**，并需另立新编号 RFC、重新盘点
`runOneNode`/node kind mechanics、能力影响与 current source，再请求用户批准。W3 也解除 P0-C 前置，但仍排在 W2-C/D
之后，不能由本 RFC 自动开工。
