# RFC-368 任务分解

**状态**：**Done（2026-09-23）**——三刀全部落地、CI 绿；实现门处置见 plan.md §6（设计门 r1 的 9 P1 / 6 P2 / 2 P3 已逐条回写）
**读法**：先 [proposal.md](./proposal.md) 再 [design.md](./design.md)。

---

## 1. 子任务

| # | 任务 | 产出 | 依赖 |
| --- | --- | --- | --- |
| **T1** | DE domain：请求材料与 `prepareReactionExecution` 工厂 | `domain/reactionExecutionRequest.ts` + 单测（工厂校验 / deep-frozen / hash 排除自身与 brand / 同输入同 hash） | — |
| **T2** | DE domain：`sanitizeReactionText`（C1 的 R1–R5，服务反馈与诊断两种 kind） | `domain/reactionArtifacts.ts` + 单测（5 条正向 + R3/R4 各一反例） | — |
| **T3** | DE domain：**两套**重试判据抽成纯函数 | `domain/retrySchedule.ts` 的 `roundRetrySchedule`（今天 `#retryOrFailExecution`）与 `dispatchRetrySchedule`（今天 outbox catch），**各自与改造前逐值对拍**的单测 | — |
| **T4** | 合同落档：三个 required port + 两个 reader port 写进 `composition/required-ports.ts` | 仅类型，旧 `ReactionExecutionPort` 暂留 | T1 |
| **T5a** | schema **纯增量**：SQLite `0230` + PG `0006` | admission 表（`execution_ref NOT NULL`）/ round 八个新列 / artifacts 表 / **部分唯一索引加 `dispatching`** + 迁移用例 | T4 |
| **T5b** | schema **切换期**：在途 `execution-launch` 行迁移（含 `previousError` 入 artifacts 表、`mode` 重算）+ outbox `kind` 收缩 | **必须与刀 3 同批**——行迁走而派发臂还没接管时，那些 round 会当场停摆，这不是「零行为变更」 | T17 |
| **T6** | TE：admission 持久化 + tx-bound participant（含事务内**预分配** executionRef、`admitLaunch` 幂等） | `task-execution/infrastructure/reactionExecutionAdmissions.ts` + `composeReactionExecutionAdmissionParticipantInTx(tx)` | T5 |
| **T7** | TE：`ReactionExecutionPortV1` 的 provider adapter | `task-execution/application/adapters/reaction-execution-adapter.ts`；`launch` 用预分配 id 建任务并对已存在 id 幂等；`inspect` 补 `stopped` 态；消费 `ReactionRetryFeedbackReaderV1` 拼提示词 | T6 |
| **T8** | DE：`dispatchOneReaction()` 取代 outbox `execution-launch` 臂 | 选择判据两支（`planned` 到期 ∪ `dispatching` 租约过期）+ case-terminal 短路 + claim/admission 同事务 | T5, T4 |
| **T9** | DE：**接进两个 worker 循环** | `osWorker.ts`（接口 + 调用 + `DigitalEmployeeOsCycleResult` 计数）、`activityOperations.ts`（接口 + 调用 + `DevelopmentActivityResult` 判别式，**必须插在 `inspectOneExecution` 之前**）、`composition.ts` 两处装配 | T8 |
| **T10** | DE：round 级重试改用 T3，并把**预算收敛写回 `round.planJson`** | `retryRound` 事务内写回；清 `operation_ref`/`execution_ref` | T8, T3 |
| **T11** | DE：**派发级**预算/退避/终结三分支（`settleRound`/`terminateCase`/`blockCase`），用户可见字面值按 design §4.2 固定 | `runtimeService.ts` + `runtimeStore.ts` | T8, T3 |
| **T12** | DE：`inspect`/`inspectHumanReview`/`cancel` 改传 `access`；人审三来源映射（`not-applicable` / `unknown` / 其余） | 含投影端保留 round-state 回落 | T7 |
| **T13** | DE：`closeClaim` 接到**六个**收口点（四个 `settleRound` 入口 + `obsolete` + `terminateCase`） | — | T8 |
| **T14** | G7 取消语义：`stopped` 不消耗重试预算；`terminateCase` 调 `port.cancel` 停掉在跑的 agent | DE 结算分支 + `terminateCase` 路径 | T7, T12 |
| ~~T15~~ | ~~`dispatching` 状态同步~~ | **作废**：实施期发现 PG 迁移改不了既有索引的谓词，于是不新增状态、改用 `planned` + 派发租约表示（design §5.1）。不变量、CAS 谓词、状态联合全部不用动 | — |
| ~~T16~~ | ~~前端状态文案 + 视觉态~~ | **作废**：同 T15，前端不用认识新状态 | — |
| **T17** | 三个根切装配绑定 | 只换 binding，不并存双 writer | T7–T14 |
| **T18** | 删除旧合同与双向边 | `DigitalEmployeeExecutionParticipant`、`digital-employee/application/adapters/task-execution-adapter.ts`、TE 侧 4 处 `WorkspaceFailureClass` import | T17 |
| **T19** | 迁移回归锁：`rfc294-e9c-reaction-launch-crash-window.test.ts` 换新合同重建，**判据不放宽**，并补「`dispatching` 租约过期被重选」一格 | — | T17 |
| **T20** | 账本重采 + 记账 | `--snapshot-sha HEAD` 重跑普查（注意：`architecture:write` 不重钉 provenance）、`design/plan.md` 索引置 Done、`STATE.md` 收口 | T18, T19 |

## 2. PR 拆分建议

单 RFC 默认单 PR，但本 RFC 触及 schema + 两个 context + 三个根 + 前端，建议三刀，每刀自带测试、
每刀 CI 绿：

- **刀 1（T1–T4, T5a）**：纯增量——domain 纯函数 + 合同类型 + **只加不改**的 schema。不接线，零行为变更，可独立回滚。
- **刀 2（T6–T14）**：实现与编排切换，**装配仍指向旧路径**（新路径只在测试里装配）。
- **刀 3（T5b, T17–T20）**：切绑定、迁在途行、收缩 outbox kind、删旧合同、重采账本。回滚只需回绑定。

## 3. 验收清单

- [ ] AC-1 跨缝无 JSON 序列化 + 旧 participant 已删
- [ ] AC-2 执行/读取 port 无 optional 方法
- [ ] AC-3 claim CAS 与 admission 同事务（注错参与者验原子性）
- [ ] AC-4 同 operation 重放返回同一 executionRef
- [ ] AC-5 崩溃两格：`dispatching` 租约过期重选 + 任务已建重放
- [ ] AC-6 DE↔TE 双向 import 归零
- [ ] AC-7 `execution-launch` 退役 **且** 派发臂被两个循环调用
- [ ] AC-8 **两套**计数器的预算/退避/终结逐值对拍
- [ ] AC-9 反馈 content-addressed 去重
- [ ] AC-10 C1 裁剪规则各有用例（R3/R4 带反例）
- [ ] AC-11 人审闸门双引擎一致 **且** 三来源映射正确
- [ ] AC-12 既有 DE 行为不回归（按清单允许/禁止改断言）
- [ ] AC-13 round 不会卡死
- [ ] AC-14 案例 terminal 时不再起新执行
- [ ] AC-15 取消语义（不消耗预算 + terminate 停 agent）
- [ ] AC-16 派发失败有上限且会终结
- [ ] 设计门 r2（Codex 额度恢复后或 Claude 子代理）已跑并回写 findings
- [ ] 实现门已跑并回写 findings
- [ ] exact-SHA 的 Main CI 终态 success（46/46）

## 4. 用户裁决记录（2026-09-22，全部已拍板，无开放项）

- **C1-R3 栈帧行：整行丢弃**（五条裁剪规则里唯一有信息损失风险的一条，用户明确接受该风险）。
- admission **事务内预分配 executionRef**（解 P1-2/P1-3/P1-5）。
- retry 反馈与诊断经 **DE-owned reader port** 解引用（保住 G5）。
- **顺带修**取消语义（G7 上半：`stopped` 不消耗重试预算）。
- **顺带接上** `cancel`（G7 下半：`terminateCase` 停掉在跑的 agent）。
- 加固类偏离 D1–D4 不做；功能性偏离 D5–D10 见 design.md §2.2。

## 5. 设计门 r1 处置记录

FAIL → 9 P1 / 6 P2 / 2 P3，全部已回写：

| finding | 处置 |
| --- | --- |
| P1-1 `dispatching` 死胡同（选不中 / 巡检看不见 / `activeRoundId` 锁死案例） | design §4.1 判据加租约过期支 + §5 加租约列；AC-5/AC-13 |
| P1-2 「任务已建、ref 未写回」使 `56bb82b50` 的缺陷回归 | 事务内预分配 executionRef，该格消失；design §7 |
| P1-3 `operation_ref` 主键与 `(round, epoch)` 唯一键互斥 | §3.2 裁决：operation 主键、epoch 是行上更新列、`admitLaunch` 幂等 |
| P1-4 retry 按实时预算重算 ⇒ hash 不稳定 | §3.1 + §4.2：预算收敛**写回 round**，hash 对写回值算 |
| P1-5 `access` 构造不出来 | §3.3 简化为 `{operation, executionRef}`（偏离 D6），两者 round 行上都有 |
| P1-6 派发臂没接进 worker 循环 | T9 新增；design §4.1 写明四处 + `activityOperations` 的插入位置陷阱；AC-7 |
| P1-7 派发级终结路径整条丢失 | §4.2 两套计数器表 + 三个终结分支；T11；AC-8/AC-16 |
| P1-8 反馈/诊断只传 ref 无解引用路径 | §3.3 增两个 DE-owned reader port；T7/T12 |
| P1-9 `dispatching` 未同步到 6+ 处判据与前端 | **釜底抽薪**：不新增状态（design §5.1），改用 `planned` + 派发租约。P1-9 列的六处判据与前端两处**全部不需要改**，T15/T16 作废 |
| P2-1 案例 terminal 短路丢失 | §4.1 case-terminal 短路；AC-14 |
| P2-2 `null` 三来源合并 | §3.3 `not-applicable` / `unknown` 两态 + 保留 round-state 回落；AC-11 |
| P2-3 在途迁移丢 `previousError` | §5 在途迁移写入 artifacts 表；`mode` 重算公式写明 |
| P2-4 `next_attempt_at` 可空致新 round 选不中 | `NOT NULL DEFAULT 0` |
| P2-5 AC-1/2/7/12 是空判据（AC-1 还盯错了文件） | proposal §6 全部重写；AC-12 改成「允许改/禁止放宽」两张清单 |
| P2-6 6 条未声明的功能性偏离 | design §2.2 的 D5–D10；其中 `stopped` 态改为**实施**（G7） |
| P3-1 `cancel` 零调用方 | 用户裁决顺带接上（T14） |
| P3-2 `closeClaim` 调用点不完整 | §4.2 列出六个收口点；T13 |

## 6. 实施记录与实现门处置（2026-09-23）

**提交**：刀 1 `a6fb97c24`（+ `375094137` 修红）；刀 2 T6 `9be528d80` → T7 `bae41a843` → T8/T11/T13
`b2242a00c` → T9 `faca18715` → T10/T12/T14 `5f5fcd76b`；刀 3（T5b/T17/T18/T19）`6bdd753a2`；
实现门修复见本节末提交。各笔 CI 绿（中间几笔的 run 被下一笔 push 顶掉，由覆盖它们的后继 run 兜底）。

**实施期新增的偏离**（均呈用户裁决）：D11 合同类型去掉 `InTx` 后缀；D12 T5b 改为启动后第一次派发时
一次性收编（PG 迁移序列表达不了数据迁移）；D13 TE 在 admission 日志查不到行时按 executionRef 放行
（切换前已在跑的 round）。详见 design.md §2.2 / §5.2。

**实现门**（Codex 额度用尽到 9/27，改 Claude 子代理，只审功能）：PASS-WITH-FINDINGS，全部已处置：

| finding | 处置 |
| --- | --- |
| P1-1 收编失败的 rejected promise 被永久缓存，此后每个 cycle 在派发处抛、inspect 跑不到，全部 round 卡死 | 失败时清缓存，下一次派发重试收编 |
| P2-1 资源上限 / 空闲收割先按「用户取消」落库、事后改写原因，中间几秒被数字员工误判成 stopped、不再重试 | **用户裁决：原因一次写对**。`TaskStopCause` 增 `resource-reaped`（带 summary/message），两个收割方的 `cancelTask` 端口带真实原因，三个根以它接线；状态与原因同一次 CAS 落下 |
| P2-2 launch 进行中 / 崩溃重放期间终止案例，agent 停不掉 | `terminate` 也取消 planned 且已有执行身份的 round；launch 返回后复查案例终止即取消；case-terminal 短路先取消已预分配的执行 |
| P3-1 已终止案例再收掉残留 round 时 `terminalAt` 被改写 | `settleRound` 在案例已终止时保留原 `terminalAt` |
| P3-2 launch 成功后 `markRoundRunning` 抛错被当成派发失败 | 把 `markRoundRunning` 移出派发失败判定；抛错交给租约过期后的幂等重放 |
| P3-3 epoch 冲突消耗派发预算，与 design §7 不一致 | `employee-reaction-claim-stale` 按 idle 处理 |
| P3-4 测试缺口 | `tests/rfc368-implementation-gate.test.ts` 补齐（P1-1 / P2-1 / P2-2 / P3-1 / P3-3 / AC-3 数字员工侧），逐项撤掉修复验红。人审六态的投影仍只有源码层兜底（投影需要完整 type descriptor），双引擎的真实闸门状态由 `rfc359-w12-digital-employee-human-review-parity` 与 `rfc310-digital-employee-human-review-system-mock-e2e` 覆盖 |

