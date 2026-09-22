# RFC-368 任务分解

**状态**：Draft（待批准）
**读法**：先 [proposal.md](./proposal.md) 再 [design.md](./design.md)。

---

## 1. 子任务

依赖写在「依赖」列；无依赖者可并行。

| # | 任务 | 产出 | 依赖 |
| --- | --- | --- | --- |
| **T1** | DE domain：`ReactionExecutionRequestV1` / `PreparedReactionExecutionV1` 与 `prepareReactionExecution` 工厂 | `digital-employee/domain/reactionExecutionRequest.ts` + 单测（工厂校验 / deep-frozen / hash 排除自身与 brand） | — |
| **T2** | DE domain：`sanitizeRetryFeedback`（C1 的 R1–R5） | `digital-employee/domain/retryFeedback.ts` + 单测（5 条正向 + 2 条反例） | — |
| **T3** | DE domain：把退避 / 预算 / 场景切换从 `#retryOrFailExecution` 抽成纯判据 | `digital-employee/domain/retrySchedule.ts` + **与改造前逐值对拍**的单测 | — |
| **T4** | 合同落档：三个 required port 接口写进 `composition/required-ports.ts`，旧 `ReactionExecutionPort` 暂留 | 仅类型，无行为 | T1 |
| **T5** | schema：SQLite `0230` + PostgreSQL `0006`（admission 表 / round 加列 / 反馈表 / `dispatching` 状态 / outbox kind 收缩 + 在途行迁移） | 两份迁移 + 迁移用例（含在途 `execution-launch` 行的逐行映射） | T4 |
| **T6** | TE：admission 持久化与 tx-bound participant 实现 | `task-execution/infrastructure/reactionExecutionAdmissions.ts` + `composeReactionExecutionAdmissionParticipantInTx(tx)` | T5 |
| **T7** | TE：`ReactionExecutionPortV1` 的 provider adapter（落在 `application/adapters/reaction-execution-adapter.ts`），含 launch 的 admission 重放查表 | 适配器 + 把 `digitalEmployeeExecution.ts` 的现有实现收成它的内部实现 | T6 |
| **T8** | DE：`dispatchOneReaction()` 取代 outbox `execution-launch` 臂；claim CAS + admission 同事务 | `application/runtimeService.ts` 改造 + `infrastructure/runtimeStore.ts` 的 round 调度读写 | T5, T4 |
| **T9** | DE：结算 / 重试路径改用 T2/T3 的纯函数与 `closeClaim` | 同上两个文件 | T8 |
| **T10** | DE：`inspect` / `inspectHumanReview` / `cancel` 改传 `access`；`not-applicable` 取代 `null` | 同上 + 人审闸门投影 | T7 |
| **T11** | 三个根切装配绑定（`server.ts` / `cli/start.ts` / `cli/postgresqlDaemonApplication.ts`） | 只换 binding，不并存双 writer | T7, T8 |
| **T12** | 删除旧合同与双向边：`DigitalEmployeeExecutionParticipant`、`digital-employee/application/adapters/task-execution-adapter.ts`、TE 侧 4 处 `WorkspaceFailureClass` import | consumer=0 之后才删 | T11 |
| **T13** | 迁移回归锁：`rfc294-e9c-reaction-launch-crash-window.test.ts` 改用新合同重建（AC-5） | 用例改写，**判据不放宽** | T11 |
| **T14** | 账本重采 + 记账：`--snapshot-sha HEAD` 重跑普查、`design/plan.md` 索引置 Done、`STATE.md` 收口 | — | T12, T13 |

## 2. PR 拆分建议

单个 RFC 默认单 PR（CLAUDE.md §RFC workflow 第 5 条）。但本 RFC 触及 schema + 两个 context +
三个根，建议按**三刀**分批提交到 main（每刀自带测试、每刀 CI 绿）：

- **刀 1（T1–T5）**：纯增量——domain 纯函数 + 合同类型 + schema。不接线，零行为变更，可独立回滚。
- **刀 2（T6–T10）**：实现与编排切换，但**装配仍指向旧路径**（新路径只在测试里被装配）。
- **刀 3（T11–T14）**：切绑定、删旧合同、重采账本。回滚只需回绑定。

## 3. 验收清单

实施完成后逐条勾注（未做的留空并写明原因，不许抹掉）：

- [ ] AC-1 合同无 `planJson` / `attemptJson` / `outputJson` / 裸 `errorDetail`
- [ ] AC-2 四方法全必选、optional=0、`not-applicable` 语义就位
- [ ] AC-3 claim CAS 与 admission 同事务（注错参与者验原子性）
- [ ] AC-4 同 operation 重放返回同一 `executionRef`
- [ ] AC-5 崩溃窗口回归锁迁到新合同仍绿
- [ ] AC-6 DE↔TE 双向 import 归零（账本只剩 `required-implementation`）
- [ ] AC-7 `execution-launch` 退役、另两类不受影响
- [ ] AC-8 退避 / 预算 / 场景切换逐值对拍
- [ ] AC-9 反馈 content-addressed 去重
- [ ] AC-10 C1 五条裁剪规则各有用例（R3/R4 带反例）
- [ ] AC-11 人审闸门双引擎一致
- [ ] AC-12 既有 DE 用例不改断言即绿
- [ ] 设计门（Codex 或 Claude 子代理，只审功能）已跑并回写 findings
- [ ] 实现门已跑并回写 findings
- [ ] exact-SHA 的 Main CI 终态 success（46/46）

## 4. 待用户拍板的开放项

批准前需要答复的只有一条：

- **C1-R3（丢弃栈帧行）**：这是五条裁剪规则里唯一有信息损失风险的一条。接受整行丢弃，
  还是改成「保留首 N 条栈帧」？其余 R1/R2/R4/R5 只改表述不丢判据。

另：§2 的偏离项 D1–D4（authority 二次重验、并发终检、变异守卫矩阵、跨 owner 接管）按用户
2026-09-22 的「只做功能正确性」裁决**不做**，此处一并呈确认。
