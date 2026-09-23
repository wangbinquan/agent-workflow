# RFC-368 Reaction 执行合同切换（RFC-294 W4-E9 的 E9-C）

**状态**：**Done（2026-09-23）**——三刀全部落地、CI 绿；实现门处置见 plan.md §6
**母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W4-E9
**前序**：RFC-361（E9-B 的 EC provider，Done）、RFC-365（Event target provider，Done）、
`56bb82b50`（E9-C 前置小修：launch 幂等，已上线）
**后继**：E9-D transport/root、E9/W9 observer lifecycle

---

## 1. 背景

数字员工（Digital Employee）执行一个 ReactionRound 时，跨到 TaskExecution 的那道缝今天有四处问题：

1. **seam 上在对传 JSON 字符串**。DE-owned 的 port 本身已经是 typed 的
   （`digital-employee/composition/required-ports.ts:118-120` 收 `ReactionExecutionPlan`），
   但**适配器把它 `JSON.stringify` 了一次**（`application/adapters/task-execution-adapter.ts:7`），
   TE-owned 的 participant 收的是 `launch(planJson: string, attemptJson: string)`
   （`task-execution/public/participants.ts:371`），进去立刻 `JSON.parse` 回来
   （`composition/digitalEmployeeExecution.ts:397-400`）。两边各一份 zod schema，字段漂移编译器不管。
2. **`inspectHumanReview` 是 optional**（`public/participants.ts:373`），调用点得写
   `participant.inspectHumanReview!`。RFC-359 之前 PG 侧根本没实现它，人审闸门在 PG 上永远报不出
   `waiting`——同一个案例两个引擎显示不同。optional 让这种缺席编译期无声。
3. **retry 反馈是裸错误串**。`previousError = \`${errorCode}: ${errorDetail}\`` 截断 4000 字符
   （`application/runtimeService.ts:3238`），原样拼进提示词。混着绝对路径、栈帧、重复行。
4. **DE↔TE 双向 import**。DE 引 TE 的 `public/participants`（adapter:1），TE 引 DE 的
   `public/types` 取 `WorkspaceFailureClass`（4 个文件）。依赖图上是环。

另有两条**设计门查出的既有缺陷**，本 RFC 顺带修（用户 2026-09-22 裁决）：

5. **取消一个数字员工任务会被当成失败**。TE 的 `inspect` 对非 `done` 的终态一律走
   `resultFailure(…, 'execution-canceled', …)`（`digitalEmployeeExecution.ts:721-728`），
   DE 判成 failed ⇒ **消耗一次重试预算重新起任务**，而不是把 round 结算成「已取消」。
6. **`cancel` 零调用方**。`terminateCase`（`runtimeStore.ts:1857-1970`）只 detach
   invocation / channel / attention，**不取消在跑的 task**——终止案例后 agent 继续跑到自然结束，
   继续烧 token。

还有一条**已经修掉**的：`launch()` 与 `markRoundRunning()` 之间没有事务，daemon 在中间重启会让
同一个 round 起出两个任务。`56bb82b50` 已用「TE 侧按 round 反查活着的执行就复用」修复并上线
（回归锁 `tests/rfc294-e9c-reaction-launch-crash-window.test.ts`）。本 RFC **接管**它：
admission 在事务内预分配 executionRef，重放按 operation 身份命中，不再推断活性。

## 2. 目标

- **G1**：DE 与 TE 之间只剩 DE 自己声明的 required port，**合同全程 typed**——
  `planJson` / `attemptJson` / `outputJson` 不再跨缝。
- **G2**：执行方法**全必选**，`inspectHumanReview` 不适用时返回 `not-applicable`。
- **G3**：**record-before-act**。DE 的 claim CAS 与 TE 的 admission 登记同事务完成，
  **executionRef 在该事务内预分配**；同一 operation 重放拿回同一个 executionRef。
- **G4**：**退役 `execution-launch` outbox 类**，改由 round 自己的 claim 驱动；
  `platform-work-item-execute` / `invocation-create` 两类不动。
- **G5**：retry 反馈与失败详情改为 **content-addressed artifact**，port 上只传 ref，
  由 DE-owned 的 reader port 解引用。
- **G6**：删掉 DE↔TE 的双向 import。
- **G7**（顺带修）：**取消语义正确**——被取消的执行结算成「已取消」，不消耗重试预算；
  终止案例真的停掉在跑的 agent。

## 3. 非目标

按用户 2026-08-26「安全类一律不立项」明令，下列**明确不做**（逐条见 design.md §2）：

- 不做 TE 经 IA participant 对拍 admission 的 subject/revision（事务内二次重验）。
- 不做 epoch 争用 / 跨 tx 逃逸 / stale claim 的并发竞态终检与变异门。
- 不做 brand / hash / nested-mutation 的变异守卫矩阵与写点注册表守卫。
- 不做 E9-D（路由改 public command/query）与 observer lifecycle——各自立项。

## 4. 能力影响清单（RFC workflow 第 7 条）

### C1. retry 反馈的内容裁剪

今天 agent 看到的是 `${errorCode}: ${errorDetail}` 原文。改造后从 artifact 渲染并施加：

| 规则 | 今天 | 改后 | 影响 |
| --- | --- | --- | --- |
| R1 `errorCode` | 原样 | **原样** | 无 |
| R2 绝对路径 | 原样（宿主机 worktree 绝对路径） | 改写成工作区相对路径 | agent 拿到的是它 cwd 下可用的路径 |
| R3 栈帧行（`    at …`） | 原样保留 | **整行丢弃**（用户 2026-09-22 裁决） | 去掉对纠错无用的噪音；某类失败若只有栈帧能说明问题会丢信息，已知并接受 |
| R4 连续重复行 | 原样 | 折叠为一行 + `(× N)` | 压缩上下文 |
| R5 长度上限 | 4000 硬截断 | 保持 4000（裁剪后仍超则截断） | 无 |

### C2. 用户可见的行为变化（设计门 r1 补入）

| # | 变化 | 说明 |
| --- | --- | --- |
| ~~C2-1~~ | ~~round 新增 `dispatching` 状态~~ | **不再发生**：实施期发现 PG 迁移序列改不了既有索引谓词，于是改用 `planned` + 派发租约表示那一格（design §5.1）。案例详情页看不到任何新状态，前端零改动 |
| C2-2 | 派发失败的终结文案变化 | 今天是 `outputJson.kind='platform-dispatch-failed'` + `blockReason` 前缀 `execution-launch: `（`runtimeService.ts:2685-2705`）。退役该 kind 后这两个用户可见字面值必变；新值在 design.md §4.2 固定 |
| C2-3 | 人审闸门丢掉「按 round 状态兜底」那一层 | 今天 provider 返回 `null` 时回落到 round 状态（`runtimeService.ts:1300-1307`）。改后 `not-applicable` 只表示「这个动作没有闸门」，其余两种 `null` 来源（task 行不存在 / inputs 解析失败）映射见 design.md §3.3 |
| C2-4 | 在途重试的 `previousError` | 迁移必须把它写进反馈表并挂到 round，否则升级后那次重试的纠错信息消失（design.md §5 在途迁移） |
| C2-5 | **取消不再消耗重试预算**（G7） | 今天取消 = failed = 烧一次重试预算重起；改后结算成「已取消」。**行为变好，但确实是用户可见变化** |
| C2-6 | **终止案例会停掉在跑的 agent**（G7） | 今天不停，agent 跑到自然结束。改后立即取消。**行为变好，但会让「终止后仍看到进度」这件事消失** |

## 5. 用户故事

- **US-1**（运维）：daemon 在执行启动瞬间重启，案例恢复后**只有一个任务在跑**，且该 round
  不会卡在中间态——既不永远不动，也不静默失败。
- **US-2**（数字员工作者）：动作失败后自动重试，重试提示里是**可读的、指向工作区内路径**的
  纠错信息。
- **US-3**（开发者）：给执行合同加字段时**编译器指出所有要改的地方**。
- **US-4**（评审人）：人审闸门在两个引擎上显示一致。
- **US-5**（运维）：终止一个数字员工案例后，它正在跑的 agent **立刻停下**，不再继续烧 token。

## 6. 验收标准

| # | 标准 | 判据 |
| --- | --- | --- |
| AC-1 | 跨 DE↔TE 缝的调用参数上不出现 JSON 序列化 | 源码层：`digital-employee/application/adapters/` 与 `task-execution/application/adapters/` 下无 `JSON.stringify`/`JSON.parse` 用于 plan/attempt；且 `task-execution/public/participants.ts` 的 `DigitalEmployeeExecutionParticipant` 已删除 |
| AC-2 | 执行 port 无 optional 方法 | 类型层断言 + 源码层：`ReactionExecutionPortV1` 与两个读取 port 的方法签名里 `?:` 计数为 0 |
| AC-3 | claim CAS 与 admission 登记在同一事务 | 双引擎：注入一个在 `admitLaunch` 后抛错的参与者，断言 round 的 `claim_epoch` 与 admission 行**都没落** |
| AC-4 | 同 operation 重放返回同一 executionRef，不重复建任务 | 双引擎：连调两次 launch 同 operation，`tasks` 里该 round 只有一行 |
| AC-5 | daemon 在 launch 途中重启后该 round 只有一个执行，且能被重新派发 | `rfc294-e9c-…-crash-window` 的场景用新合同重建；**另加**「round 停在 `dispatching` + 租约过期 ⇒ 被重新选中」 |
| AC-6 | DE↔TE 双向 import 归零 | 账本：两 context 之间只剩 `required-implementation` 角色的边 |
| AC-7 | `execution-launch` 退役且派发臂真的在跑 | ①`runOneOutbox` 无 `execution-launch` 分支；②`dispatchOneReaction` 被 `osWorker` 与 `activityOperations` **两个**循环调用（源码层 + 各一条正向用例）；③另两类 outbox 用例原样绿 |
| AC-8 | **两套**重试计数器的预算/退避/终结逐值对拍 | ①round 级（`#retryOrFailExecution` 的 `2**(nextOrdinal-1)`）；②派发级（今天 outbox catch 的 `2**(attemptCount-1)` 与 `attemptCount >= max(1, retryAttemptCap(...))` 终结）。两套各一条与改造前逐值相等的用例 |
| AC-9 | 反馈 content-addressed 去重 | 同 digest 重复写入不新增行 |
| AC-10 | C1 的裁剪规则各有用例 | 每条一个正向；R3/R4 各带一个「不该被裁掉的内容仍在」的反例 |
| AC-11 | 人审闸门在两个引擎上一致**且语义正确** | 双引擎对拍 + 逐态映射用例：`not-applicable` / task 行缺失 / inputs 无闸门键 三种来源各自映射到哪一态 |
| AC-12 | 既有 DE 行为不回归 | **允许改断言的清单**：`rfc294-e9c-…-crash-window`（换合同）、`rfc359-w4-d7b-adapters.test.ts:481`（构造 `execution-launch` 行）、涉及 round 状态枚举的断言。**不得放宽的判据**：案例状态机转移、metering 口径、工作区策略、重试预算总数 |
| AC-13 | round 不会卡死 | 双引擎：`dispatching` 租约过期后被重选；`planned` 且 `next_attempt_at` 未设时也能被选中（`NOT NULL DEFAULT 0`） |
| AC-14 | 案例已 terminal 时不再起新执行 | 双引擎：round 在退避中、案例被 terminate ⇒ 下次派发直接结束该 round，不建任务 |
| AC-15 | 取消语义（G7） | 被取消的执行结算成「已取消」，**不消耗重试预算**；`terminateCase` 会取消在跑的 task |
| AC-16 | 派发失败有上限且会终结 | 永久失败的 launch（例如引用的 agent 已删）在预算耗尽后把 round 结算成 failed 并按 `handoffOnExhausted` 决定案例是否 terminal——不无限重试 |

## 7. 影响面与风险

- **schema**：新增 1 张 TE 表（admission，`execution_ref NOT NULL`）+ `employee_reaction_rounds`
  加列（claim/调度/operation/反馈 ref）+ 1 张 DE 表（反馈）+ 改 1 个部分唯一索引。expand-only。
- **最大风险**：退役 `execution-launch` 等于**调度路径换人**，而 outbox 今天同时承担
  租约 / 单行重试 / 终结兜底 / 驱动循环四件事。设计门 r1 的 P1-1/P1-6/P1-7 就是这四件里漏补的三件；
  现已逐项补齐并各自挂 AC（AC-5/AC-7/AC-8/AC-16）。
- **在途数据**：迁移把 `pending`/`claimed` 的 `execution-launch` 行逐行映射到 round 的调度列，
  **含 `previousError` 写入反馈表**；`mode` 由 `attempt_ordinal % (sameSceneAttempts+1)` 重算。
