# RFC-333：人工门原子停驻与持久续跑（RFC-294 P0-C）

> 状态：Approved / In Progress（2026-08-27；用户已批准 D1～D12 与 T2～T12，T2～T7 已完成，当前进入 T8）
>
> 架构位置：RFC-294 N6 / P0-C residual；承接 RFC-326 的 review decision 单事务种子、
> RFC-328 的 durable owner/intent/fence、RFC-329 的 REST/MCP 人工门完整面，以及 RFC-332 的唯一
> `TaskDriveCoordinator`。本 RFC 完成后才允许启动 W2-C 与 W3；不领取 W2-C/D、W3、W4 或 W5 credit。
>
> current source：以起草时 `main` / `origin/main` 的共同提交
> `52645b673f6c25d26f629b85b5acaeba5b01e0d1` 为源码锚；它相对前一架构提交只改 first-admin 前端说明/用例，
> 未触及本 RFC 的人工门后端调用链。实现开工前仍必须重新确认相关调用链未漂移。

## 1. 摘要裁决

当前 review、clarify、questions 三类人工门都能完成正常业务流程，但仍存在同一种跨边界拼接：

1. 打开人工门时，gate/node/doc 等领域事实先后写入，任务稍后才由 TaskEngine 单独停驻；
2. 人工提交决定时，领域事实先提交，HTTP route 再直接调用 `resumeTask`；
3. route 收到的“续跑失败”会作为可选字段返回给网页或 MCP，但已经提交的回答/决定无法回滚；
4. review 文档在 DB row 之前逐个写文件，多文档轮次可在中途留下不完整文件或不完整 row；
5. RFC-328 已有唯一 canonical continuation intent，RFC-332 已有唯一 drive coordinator，但三类门尚未接入。

这不是“再加一次 retry”能闭合的问题。P0-C 的目标是把人工门的两个线性化点固定下来：

```text
打开：准备外部产物 ──► 同一 TaskParkTx
                         ├─ gate / round / doc manifest
                         ├─ node projection
                         ├─ task awaiting_* transition
                         └─ committed event

决定：同一 CollaborationDecisionTx
      ├─ answer / review decision / question dispatch
      ├─ node projection
      ├─ task pending transition
      ├─ exactly one gate-continuation intent
      └─ committed event
                              │
                              ▼ after commit
                   TaskDriveCoordinator wake/recovery
```

文件、worktree rollback 等 DB 外效果先进入 purpose-specific prepare journal；最终事务只消费已准备引用，
不在事务回调中 `await` 外部 I/O。提交后的即时 wake、WS 与文件 roll-forward 都可以失败并重试，但不得改变已经提交的
业务结论，也不得再把内部 resume 失败暴露为“决定可能没成功”。

## 2. current source 对账

### 2.1 三条 route 仍直接续跑

| 人工门    | current 写命令             | current route 尾部                            | 问题                                     |
| --------- | -------------------------- | --------------------------------------------- | ---------------------------------------- |
| review    | `submitReviewDecision`     | `routes/reviews.ts` 再调用 `resumeTask`       | decision 与 continuation 不同事务        |
| clarify   | `autoDispatchClarifyRound` | `routes/clarify.ts` 再调用 `resumeTask`       | answer 已提交后仍可能返回 resume failure |
| questions | `dispatchTaskQuestions`    | `routes/taskQuestions.ts` 再调用 `resumeTask` | rerun/answer 与 task intent 不同事务     |

源码搜索在三条人工门 route 中恰好找到三处生产 `resumeTask`。RFC-202 的 source-lock 仍把网页显示这三类
resume failure 当作当前行为锁；它描述的是旧故障形状，不是目标合同。

### 2.2 打开门与 task park 不是同一提交

- `services/review.ts#dispatchReviewNodeUnlocked` 先创建/reuse review node run，再逐个创建 doc version；
  TaskEngine 随后才把 task 投影为 `awaiting_review`。
- `services/clarify/service.ts#createClarifyRound` 先 transition/mint intermediary node run，再 insert
  `clarify_rounds`，随后直接广播；TaskEngine 随后才把 task 投影为 `awaiting_human`。
- `services/taskQuestions.ts` 对 asker question ledger 仍以读时 reconciliation 为主，question snapshot 不是
  clarify open 的同一持久化事实。

因此 crash 可以落在“有 parked node、没有完整 gate manifest”“有 gate row、task 仍 running”或“已广播但事务组合未完成”
等边界。已有 `e2e/rfc294-human-gate-restart.spec.ts` 只证明**已经停驻以后**杀 daemon 可以恢复，尚未覆盖这些中间边界。

### 2.3 review 文件先于 DB 且多文档逐个落地

`services/review.ts#createDocVersion` 先 `mkdirSync/writeFileSync`，再 insert `doc_versions`；多文档 dispatch
逐项调用该函数。进程在第 N 个文档中断时，当前代码不能用一个 durable operation 判断“整轮从未可见”还是“整轮已经提交”。

### 2.4 已有原语足够，不应再造续跑系统

- `modules/task-execution/application/submitTaskContinuation.ts` 已提供 canonical intent insert、lineage/replay、
  task lifecycle revision 与 active intent uniqueness；
- `services/task.ts#resumeTaskWithAtomicSideEffects` / `resumeKick` 已能在 task lifecycle CAS 的同一个事务中执行
  gate companion writes，并追加 `kind='gate-continuation'` 的 durable intent；
- workgroup gate 已经生产使用这条窄路径；
- RFC-332 的 `TaskDriveCoordinator` 与 RFC-328 boot/ticker recovery 已负责 claim/drive pending intent。

所以 P0-C 只把三类人工门接到现有权威，不新增第二张 continuation queue、第二个 runtime registry 或 route-owned worker。

## 3. 目标

### G1：人工门打开只有一个可见线性化点

review/clarify 的 gate manifest、对应 node projection、task `awaiting_review | awaiting_human`、生命周期事件在同一个
`TaskParkTx` 提交。question snapshot 随 clarify round 一同持久化。事务前的准备态对用户不可见，事务失败保持零可见门。

### G2：人工决定与 canonical continuation 同事务

review decision、clarify answer/directive、question dispatch 各自在一个 `CollaborationDecisionTx` 中完成：

- 领域答案/决定及其 revision；
- exact node transition/rerun projection；
- task lifecycle CAS；
- exactly one RFC-328 `gate-continuation` intent；
- committed domain/lifecycle event。

事务提交后即使当前进程在 wake 前退出，boot/ticker 也能从 intent 恢复，不再依赖原 HTTP 请求活着。

### G3：DB 外效果可恢复且不制造半轮

review doc archive 使用窄的 operation/artifact journal：先准备、后在最终事务消费、再 roll-forward/cleanup。
review worktree rollback 只在事务前做 check-only 并准备幂等 plan；最终事务把 plan 与 canonical continuation 一起登记为既有 RFC-328
`workspace-rollback` effect，RFC-332 coordinator 在进入 rerun engine 前结算 effect/receipt。多文档 round 作为一个 manifest
提交；任何中间 crash 最终只能收敛为“零可见门”或“一个完整门”。

### G4：REST、MCP 与网页功能不缩水

保留 RFC-326/329 已公开的 route path、MCP tool name、输入能力、review 简化锚点、批量原子校验、clarify 指令、
questions 定向 rerun、manual question 与 actor-filtered read view。入口只改为调用 collaboration public command/query；
MCP 继续通过同一 REST route 分发，不复制第二套命令。

### G5：边界归位但不冒领后续 wave

`modules/collaboration` 拥有人工门 operation、领域顺序与 receipt；`modules/task-execution` 只拥有 task/node lifecycle、
canonical intent 与 drive。route 不再 mint node、rollback 或 resume。P0-C 不迁全部 node executor、wrapper mechanics、
所有 collaboration query 或全平台 inbound adapter。

### G6：崩溃边界成为持久 CI 合同

对 prepare、每个 artifact、最终事务、commit 后 roll-forward、wake、WS、retry/stale revision 与并发提交逐点注入故障，
证明无 partial docs、ghost WS、partial decision 或“答案永久存在但没有 continuation”。

## 4. 非目标

- 不实现 RFC-294 W2-C `NodeExecutorRegistry`、W2-D wrapper runtime、W3 transaction/outbox 全域迁移、W4 全路由 public cutover 或 W5 service facade 清理。
- 不移动 unrelated review/clarify/questions 查询面、UI 布局、MCP catalog debt 或其他业务域。
- 不改变 review approve/reject/iterate、clarify partial/full/defer/stop、question dispatch/manual question 的现有功能语义。
- 不新增权限、角色、授权门、错误挡板或任何会收缩正常功能的策略。
- 不把 ephemeral WS 当作 durable correctness 前提；也不把所有外部效果塞入 DB transaction callback。
- 不用 hard-coded retry 次数代替幂等 operation 与持久恢复。

## 5. 决策

- **D1 — 两条事务，不做万能 gate service**：打开走 `TaskParkTx`，决定走 `CollaborationDecisionTx`；两者共享值对象与 operation journal，但不混成一个可任意改 task/gate 的入口。
- **D2 — collaboration 拥有顺序，task-execution 拥有生命周期与 intent**：collaboration command 决定哪些领域写必须同批；task-execution 的 in-tx participant 校验 exact task/node 状态并追加 canonical intent。任一方都不得直接读写对方内部表。
- **D3 — 复用唯一 continuation authority**：最终事务必须调用现有 `submitTaskContinuationTx` 能力，`kind='gate-continuation'`；不得新建 queue、worker、active-intent 判据或 route fallback resume。
- **D4 — prepared ref 是 TaskParkTx 的唯一门输入**：engine 在外部准备 gate artifacts 后只携带 opaque `PreparedHumanGateRef`；TaskParkTx 校验 operation、task lifecycle revision、gate/source identity 后消费，不能接 raw DB/FS callback bag。
- **D5 — purpose-specific operation journal**：新增 collaboration-owned gate operation 与 artifact manifest，只表达 `open / decide`、`review / clarify / questions` 的状态机；不抽象成全平台通用 saga engine。
- **D6 — prepare / commit / pre-drive effect**：FS/worktree 操作不在同步 DB transaction 中执行。review docs 先 stage 再由 open transaction 消费并 roll-forward；worktree rollback 只先做 snapshot check-only 并准备幂等 plan，decision transaction 把它与 continuation 一起登记为现有 RFC-328 `workspace-rollback` effect，coordinator 在 rerun engine 前结算。不得新增 effect queue。
- **D7 — route 返回 committed receipt/view，不返回内部 resume failure**：写命令提交后返回 `GateDecisionReceipt`；REST facade 可按既有 wire 再查询 actor-filtered view。wake 失败只进入 durable recovery，不把已成功决定伪装成失败。
- **D8 — 幂等性兼容现有客户端**：command 接受可选显式 idempotency key；未提供时由 facade 从 gate identity、actor、expected revision 与 canonical payload 派生稳定 compatibility key。相同 key/hash/actor 返回同一 receipt；同 key 不同 payload 明确冲突。
- **D9 — revision 以现有事实为准**：task 侧使用 `tasks.lifecycle_event_revision`；gate 侧由每个 committed operation 的唯一 `result_gate_revision` 单调前进，并与 exact domain identity/status 同事务校验。legacy open gate 先生成一次 seed；旧客户端缺字段时 facade 在 operation 快照阶段捕获 revisions，新客户端显式提交。P0-C 不为全部 `node_runs` 增加泛化 revision。
- **D10 — manual question 保持既有能力**：手工提问仍可按当前允许的 task 状态创建。它是 question-board interrupt/park obligation，不伪装成一个新 node gate，也不从 route 强抢 active runtime owner；当前 owner 在下一个由其持有的 settle 点消费 obligation，已停驻任务立即投影可见。
- **D11 — after-commit 才对外通知**：WS、即时 wake 与 artifact final rename 均只在最终事务提交后触发；消费者按 operation/event id 幂等。未提交 operation 不允许产生用户可见 `*.created` 或 `*.answered` 帧。
- **D12 — 功能优先**：设计门、实现门与回归只核对功能正确性、恢复能力和模块边界；不夹带新安全策略。若实现会删除、限制或改变任何既有正常能力，必须先修订能力影响并重新请批。

## 6. 能力影响清单

| 功能面          | current 可见行为                                               | P0-C 目标行为                                                             |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| review open     | 单/多文档可见并停驻                                            | 内容、顺序、selection inheritance 不变；整轮原子可见                      |
| review decision | approve/reject/iterate、comments/selections、rollback、distill | 输入与最终结果不变；决定与 continuation 同事务，rollback 仍先于下游 rerun |
| clarify open    | self/cross、iteration、truncation warning、node title          | 内容与轮次不变；round/node/task 同提交                                    |
| clarify answer  | partial/full、directive、defer/stop                            | 规则不变；回答与 continuation 同事务                                      |
| task questions  | asker ledger、批量回答、定向 rerun                             | 问题与 rerun 规则不变；snapshot/dispatch 不再靠读时拼接                   |
| manual question | 多种 task 状态可创建                                           | 可创建范围不变；增加 durable park obligation，不强抢 owner                |
| restart         | 已 parked 时可重启恢复                                         | 扩为任意 prepare/commit/wake 边界后确定收敛                               |
| REST/MCP        | 既有 path/tool/schema                                          | 保持入口与业务能力；移除内部 resume failure 这一故障形状                  |
| UI              | 展示门、提交决定、错误反馈                                     | 成功提交即表示 durable accepted；不再要求用户处理内部 resume 重试         |
| events          | committed 状态后 WS invalidate                                 | 只允许 commit 后发；丢帧由查询恢复，不产生 ghost frame                    |

唯一有意改变的外部语义是：**成功提交人工决定后，不再返回“领域决定已成功但内部 resume 失败”的半成功结果**。
它被更强的 durable continuation 保证替代；用户不损失任何操作能力。

## 7. 验收标准

- **AC-1**：三类人工门 current inventory 固定 open/decision/read/route/MCP/UI/worker/recovery 全链；实现前漂移会使 source-lock 失败。
- **AC-2**：review/clarify open 的 gate manifest、node projection、task park 与 committed event 同一个 `TaskParkTx`；失败注入证明零 partial visible state。
- **AC-3**：多文档 review 在第 1..N 个 artifact prepare、prepared→commit、commit→roll-forward 每个边界 crash 后，只收敛为零轮或完整一轮；digest/path/order 与 DB manifest exact。
- **AC-4**：clarify open 同事务建立 round 与 eager task-question snapshot；legacy read-time reconciliation 只读兼容旧数据，并有明确删除门。
- **AC-5**：review、clarify、questions 三类决定均在一个 `CollaborationDecisionTx` 中完成 domain writes、node/task transition、event 与 exactly one active `gate-continuation` intent。
- **AC-6**：三条人工门 route 的生产 `resumeTask`、direct node mint/transition、direct rollback 调用均为 0；MCP 保持派发同一 REST route，不出现第二写实现。
- **AC-7**：相同 idempotency key/hash/actor 重试返回同一 receipt；同 key 不同 payload、stale task revision、stale gate revision、并发两个决定都只允许一个 winner 且 loser 零业务写。
- **AC-8**：final transaction 提交后在 wake 前杀进程，boot/ticker 会 claim 同一个 intent、先结算其 linked effect，再最终驱动；不创建第二 intent，不需要原 HTTP 客户端重试 resume。
- **AC-9**：review rollback plan prepare、decision/effect 同事务、effect act/receipt/projection 与 drive 的每个 crash 边界可重放；最终 worktree 与 committed decision 一致，rollback 结果在下游 rerun 前落定，现有 approve/reject/iterate 能力不变。
- **AC-10**：manual question 在 current 全部允许状态下保持可创建；active owner 不被 route 抢占，park obligation 不会被 settle 跳过或永久遗留。
- **AC-11**：WS 仅在 commit 后发送；commit 前 crash 为 0 帧，重复 recovery 至多产生幂等 invalidate，不暴露未提交 gate/decision。
- **AC-12**：`e2e/rfc294-human-gate-restart.spec.ts` 从“已 parked 后重启”扩为 clarify/review/questions 边界 crash/restart；REST 与 MCP 走同一 command，结果一致。
- **AC-13**：RFC-326 的 review anchor、batch prevalidation/zero-write failure、source-offset highlight、distill enqueue 与 review 历史行为全部保持。
- **AC-14**：RFC-328 owner/intent/fence 与 RFC-332 coordinator 是唯一执行权威；不存在第二 continuation table、第二 active predicate、native interval 或 route-owned worker。
- **AC-15**：architecture guard 锁定 collaboration/task-execution 双向只经 public/required participant、operation state machine、route thin facade 与 legacy fallback 删除条件。
- **AC-16**：所有新增/修改测试只审功能正确性、恢复和边界；不新增安全或权限策略断言。

## 8. 退出条件

RFC-333 只有同时满足以下条件才可标 Done：

1. 任意人工门打开后，不存在 parked task + partial gate/docs，也不存在 visible gate + running task；
2. 任意人工决定提交后，不存在 partial decision，也不存在 answer/decision 永久存储但无 canonical continuation；
3. 任意 commit 前 crash 不发 ghost WS，任意 commit 后 crash 可由 durable worker 收敛；
4. 三条 route 不再拥有 resume/mint/rollback 业务顺序；REST/MCP/UI 正常功能保持；
5. review 文件与 rollback journal 已通过边界 fault matrix，临时 artifact 可回收；
6. current source-lock、targeted/full gate 与 exact-SHA hosted CI 均提供终态证据；
7. RFC-294 只关闭 P0-C residual，W2-C/D、W3、W4、W5 继续保持未授权/未完成。

## 9. 批准记录

2026-08-27，用户以“ok”明确批准 D1～D12 与 `plan.md` T2～T12。实施严格保持本 RFC 的能力影响边界：
不收缩 review / clarify / questions / manual question 的任何正常能力，不新增安全或权限策略；W2-C/D、W3、W4、W5
仍需各自的新 RFC 与明确批准。
