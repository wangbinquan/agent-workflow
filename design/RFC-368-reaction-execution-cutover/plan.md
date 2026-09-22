# RFC-368 任务分解

**状态**：Draft（设计门 r1 已跑，9 P1 / 6 P2 / 2 P3 逐条回写，待用户批准实现）
**读法**：先 [proposal.md](./proposal.md) 再 [design.md](./design.md)。

---

## 1. 子任务

| # | 任务 | 产出 | 依赖 |
| --- | --- | --- | --- |
| **T1** | DE domain：请求材料与 `prepareReactionExecution` 工厂 | `domain/reactionExecutionRequest.ts` + 单测（工厂校验 / deep-frozen / hash 排除自身与 brand / 同输入同 hash） | — |
| **T2** | DE domain：`sanitizeReactionText`（C1 的 R1–R5，服务反馈与诊断两种 kind） | `domain/reactionArtifacts.ts` + 单测（5 条正向 + R3/R4 各一反例） | — |
| **T3** | DE domain：**两套**重试判据抽成纯函数 | `domain/retrySchedule.ts` 的 `roundRetrySchedule`（今天 `#retryOrFailExecution`）与 `dispatchRetrySchedule`（今天 outbox catch），**各自与改造前逐值对拍**的单测 | — |
| **T4** | 合同落档：三个 required port + 两个 reader port 写进 `composition/required-ports.ts` | 仅类型，旧 `ReactionExecutionPort` 暂留 | T1 |
| **T5** | schema：SQLite `0230` + PG `0006` | admission 表（`execution_ref NOT NULL`）/ round 八个新列 / artifacts 表 / **部分唯一索引加 `dispatching`** / 在途行迁移（含 `previousError` 入表） + 迁移用例 | T4 |
| **T6** | TE：admission 持久化 + tx-bound participant（含事务内**预分配** executionRef、`admitLaunch` 幂等） | `task-execution/infrastructure/reactionExecutionAdmissions.ts` + `composeReactionExecutionAdmissionParticipantInTx(tx)` | T5 |
| **T7** | TE：`ReactionExecutionPortV1` 的 provider adapter | `task-execution/application/adapters/reaction-execution-adapter.ts`；`launch` 用预分配 id 建任务并对已存在 id 幂等；`inspect` 补 `stopped` 态；消费 `ReactionRetryFeedbackReaderV1` 拼提示词 | T6 |
| **T8** | DE：`dispatchOneReaction()` 取代 outbox `execution-launch` 臂 | 选择判据两支（`planned` 到期 ∪ `dispatching` 租约过期）+ case-terminal 短路 + claim/admission 同事务 | T5, T4 |
| **T9** | DE：**接进两个 worker 循环** | `osWorker.ts`（接口 + 调用 + `DigitalEmployeeOsCycleResult` 计数）、`activityOperations.ts`（接口 + 调用 + `DevelopmentActivityResult` 判别式，**必须插在 `inspectOneExecution` 之前**）、`composition.ts` 两处装配 | T8 |
| **T10** | DE：round 级重试改用 T3，并把**预算收敛写回 `round.planJson`** | `retryRound` 事务内写回；清 `operation_ref`/`execution_ref` | T8, T3 |
| **T11** | DE：**派发级**预算/退避/终结三分支（`settleRound`/`terminateCase`/`blockCase`），用户可见字面值按 design §4.2 固定 | `runtimeService.ts` + `runtimeStore.ts` | T8, T3 |
| **T12** | DE：`inspect`/`inspectHumanReview`/`cancel` 改传 `access`；人审三来源映射（`not-applicable` / `unknown` / 其余） | 含投影端保留 round-state 回落 | T7 |
| **T13** | DE：`closeClaim` 接到**六个**收口点（四个 `settleRound` 入口 + `obsolete` + `terminateCase`） | — | T8 |
| **T14** | G7 取消语义：`stopped` 不消耗重试预算；`terminateCase` 调 `port.cancel` 停掉在跑的 agent | DE 结算分支 + `terminateCase` 路径 | T7, T12 |
| **T15** | `dispatching` 状态同步到剩余判据 | `ReactionRoundRecord.state` 联合、`activeRound` 两处、`markRoundRunning` CAS 谓词 | T5 |
| **T16** | **前端**：round 状态文案表 + `roundVisualState` 加 `dispatching` | `frontend/src/routes/employee-cases.$caseId.tsx`（文案表 `:318` 附近、`roundVisualState` `:388`）+ 前端用例 | T5 |
| **T17** | 三个根切装配绑定 | 只换 binding，不并存双 writer | T7–T14 |
| **T18** | 删除旧合同与双向边 | `DigitalEmployeeExecutionParticipant`、`digital-employee/application/adapters/task-execution-adapter.ts`、TE 侧 4 处 `WorkspaceFailureClass` import | T17 |
| **T19** | 迁移回归锁：`rfc294-e9c-reaction-launch-crash-window.test.ts` 换新合同重建，**判据不放宽**，并补「`dispatching` 租约过期被重选」一格 | — | T17 |
| **T20** | 账本重采 + 记账 | `--snapshot-sha HEAD` 重跑普查（注意：`architecture:write` 不重钉 provenance）、`design/plan.md` 索引置 Done、`STATE.md` 收口 | T18, T19 |

## 2. PR 拆分建议

单 RFC 默认单 PR，但本 RFC 触及 schema + 两个 context + 三个根 + 前端，建议三刀，每刀自带测试、
每刀 CI 绿：

- **刀 1（T1–T5）**：纯增量——domain 纯函数 + 合同类型 + schema。不接线，零行为变更，可独立回滚。
- **刀 2（T6–T16）**：实现与编排切换，**装配仍指向旧路径**（新路径只在测试里装配）。
- **刀 3（T17–T20）**：切绑定、删旧合同、重采账本。回滚只需回绑定。

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

## 4. 待用户拍板的开放项

**仅剩一条**：

- **C1-R3（栈帧行 `    at …` 怎么处理）**——五条裁剪规则里唯一有信息损失风险的一条。
  选项：①整行丢弃（上下文最干净，但某类失败只有栈帧能说明问题时会丢信息）；
  ②保留首 N 条；③不裁栈帧，只做 R2+R4（零信息损失）。

**已拍板并写入的（2026-09-22）**：
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
| P1-9 `dispatching` 未同步到 6+ 处判据与前端 | §5 同步表；T15/T16 |
| P2-1 案例 terminal 短路丢失 | §4.1 case-terminal 短路；AC-14 |
| P2-2 `null` 三来源合并 | §3.3 `not-applicable` / `unknown` 两态 + 保留 round-state 回落；AC-11 |
| P2-3 在途迁移丢 `previousError` | §5 在途迁移写入 artifacts 表；`mode` 重算公式写明 |
| P2-4 `next_attempt_at` 可空致新 round 选不中 | `NOT NULL DEFAULT 0` |
| P2-5 AC-1/2/7/12 是空判据（AC-1 还盯错了文件） | proposal §6 全部重写；AC-12 改成「允许改/禁止放宽」两张清单 |
| P2-6 6 条未声明的功能性偏离 | design §2.2 的 D5–D10；其中 `stopped` 态改为**实施**（G7） |
| P3-1 `cancel` 零调用方 | 用户裁决顺带接上（T14） |
| P3-2 `closeClaim` 调用点不完整 | §4.2 列出六个收口点；T13 |
