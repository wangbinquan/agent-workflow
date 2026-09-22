# RFC-368 Reaction 执行合同切换（RFC-294 W4-E9 的 E9-C）

**状态**：Draft（待用户批准进入实现）
**母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W4-E9
**前序**：RFC-361（E9-B 的 EC provider，Done）、RFC-365（Event target provider，Done）、
`56bb82b50`（E9-C 前置小修：launch 幂等，已上线）
**后继**：E9-D transport/root、E9/W9 observer lifecycle

---

## 1. 背景

数字员工（Digital Employee）执行一个 ReactionRound 时，跨越 DE 与 TaskExecution 两个
bounded context 的那道缝今天长这样（`digital-employee/composition/required-ports.ts:118-132`）：

```ts
export interface ReactionExecutionPort {
  launch(plan: ReactionExecutionPlan, attempt: {
    ordinal: number
    mode: 'initial' | 'same-scene' | 'fresh-scene'
    previousError: string | null
  }): Promise<{ executionRef: string }>
  inspect(executionRef: string): Promise<ReactionExecutionSnapshot>
  inspectHumanReview?(executionRef: string): Promise<'planning' | 'waiting' | 'approved' | 'failed' | null>
  cancel(executionRef: string): Promise<void>
}
```

四处具体问题：

1. **seam 上在对传 JSON 字符串**。DE 的适配器把 plan / attempt 各 `JSON.stringify` 一次
   （`digital-employee/application/adapters/task-execution-adapter.ts:7`），TE 收到后立刻
   `JSON.parse` 回来（`task-execution/composition/digitalEmployeeExecution.ts:397-400`）。
   两边各维护一份 zod schema，字段漂移编译器不管。
2. **`inspectHumanReview` 是 optional**（`task-execution/public/participants.ts:373`），调用点
   还得写 `participant.inspectHumanReview!`。RFC-359 之前 PostgreSQL 侧根本没实现它，人工评审
   闸门在 PG 上永远报不出 `waiting`——同一个案例两个引擎显示不同。optional 让这种缺席编译期无声。
3. **retry 反馈是裸错误串**。`previousError = \`${errorCode}: ${errorDetail}\`` 截断到 4000 字符
   （`application/runtimeService.ts:3238`），原样拼进重试提示词。里面混着绝对路径、栈帧、
   重复行，对 agent 纠错没帮助却占满上下文。
4. **DE↔TE 双向 import**。DE 引 TE 的 `public/participants`（adapter:1），TE 引 DE 的
   `public/types` 取 `WorkspaceFailureClass`（4 个文件）。两个 context 互为上游，依赖图上是环。

另有一条**已经修掉**的：`launch()` 与 `markRoundRunning()` 之间没有事务，daemon 在中间重启会让
同一个 round 起出两个任务。`56bb82b50` 已按「TE 侧按 round 反查活着的执行就复用」修复并上线
（回归锁 `packages/backend/tests/rfc294-e9c-reaction-launch-crash-window.test.ts`）。本 RFC
**接管**这条：那个反查是按启发式判断「看起来还活着」，本 RFC 换成 record-before-act 的
admission 回执——同一个 operation 重放拿回同一个 execution，不再依赖活性推断。

## 2. 目标

- **G1**：DE 与 TE 之间只剩 DE 自己声明的 required port，**合同是 typed 的**——不再有
  `planJson` / `attemptJson` / `outputJson` / 裸 `errorDetail` 跨缝。
- **G2**：四个执行方法**全必选**，`inspectHumanReview` 不适用时返回 `not-applicable`，
  不再有 optional 方法和 `!` 断言。
- **G3**：**record-before-act**。DE 的 claim CAS 与 TE 的 admission 登记在**同一个事务**里完成，
  之后才发生真正的 launch；同一个 operation 的重放返回同一个 `executionRef`。
- **G4**：**退役 `execution-launch` 这一类 outbox 行**，改由 round 自己的 claim 驱动；
  `platform-work-item-execute` / `invocation-create` 两类保持现状不动。
- **G5**：retry 反馈改为 **content-addressed artifact**，port 上只传 ref；顺带做内容裁剪
  （逐条见 §4 能力影响清单）。
- **G6**：删掉 DE↔TE 的双向 import——同一刀两条边一起消失。

## 3. 非目标

以下各项**明确不做**，理由是用户 2026-08-26 的「安全类一律不立项」明令与本 RFC 的功能核心：

- **不做**「TE 经 IA current-authority participant 对拍 admission 中的 subject/revision」
  （RFC-294 design §3.5 有此条）——属事务内二次重验。
- **不做** epoch 争用 / 跨 tx 逃逸 / stale claim 的并发竞态终检与对应变异门。
- **不做** brand / hash / nested-mutation 的变异守卫矩阵与写点注册表守卫。
- **不做** E9-D（DE / Event 路由从 composition view 改 public command/query）与 observer
  lifecycle——各自立项。
- **不改** 用户可见的数字员工行为：案例状态机、重试预算与退避、人审闸门语义、
  工作区策略、metering 口径全部逐字保留。

## 4. 能力影响清单（RFC workflow 第 7 条）

本 RFC 只有一项改变用户可见行为，**逐条呈确认**：

### C1. retry 反馈的内容裁剪（用户 2026-09-22 已选「顺带做内容裁剪」）

今天 agent 在重试时看到的是 `${errorCode}: ${errorDetail}` 的原文。改造后改成从 artifact 渲染，
并施加下列裁剪规则。**每条都会改变 agent 看到的文本，可能影响重试成功率**：

| 规则 | 今天 | 改后 | 影响 |
| --- | --- | --- | --- |
| R1 `errorCode` | 原样 | **原样**（不动） | 无 |
| R2 绝对路径 | 原样（含宿主机 worktree 绝对路径） | 改写成工作区相对路径 | agent 拿到的是它自己 cwd 下可用的路径；今天那串绝对路径它无法直接使用 |
| R3 栈帧行（`    at …`） | 原样保留 | 整行丢弃 | 去掉对纠错无用的噪音；**若某类失败只有栈帧能说明问题，会丢信息** |
| R4 连续重复行 | 原样 | 折叠为一行 + `(× N)` | 同上，压缩上下文 |
| R5 长度上限 | 4000 字符硬截断 | **保持 4000**（裁剪后仍超则截断） | 无 |

**R3 是唯一有信息损失风险的一条**——请确认是否接受，或改为「保留首 N 条栈帧」。
R2/R4 只改表述不丢判据。

### C2. 不构成能力收缩的改动（备查，无需逐条确认）

- `inspectHumanReview` optional → 必选：两个 provider 今天都已实现，是把已有能力钉死。
- `execution-launch` outbox 退役：内部调度机制更换，退避 / 重试预算 / dedupe 语义逐字保留
  （§设计的迁移一节逐项对拍）。
- `PreparedReactionExecutionV1` 只能由工厂铸造：关闭的是 ad-hoc 构造，没有调用方在用。

## 5. 用户故事

- **US-1**（运维）：daemon 在数字员工执行启动的瞬间重启，案例恢复后**只有一个任务在跑**，
  案例详情页看到的执行就是真正在跑的那个，时长 / token 预算不被孤儿吃掉。
- **US-2**（数字员工作者）：一次业务动作失败后自动重试，重试提示里是**可读的、指向工作区内
  路径的**纠错信息，而不是混着宿主机绝对路径和栈帧的 4000 字符原文。
- **US-3**（开发者）：给 Reaction 执行合同加一个字段时，**编译器会指出所有需要改的地方**，
  而不是等某个引擎在运行期把 JSON 解析失败。
- **US-4**（评审人）：人工评审闸门在 SQLite 与 PostgreSQL 上**显示一致**，不存在某个引擎
  因为没实现 optional 方法而永远报不出 `waiting`。

## 6. 验收标准

| # | 标准 | 判据 |
| --- | --- | --- |
| AC-1 | 合同上不出现 `planJson` / `attemptJson` / `outputJson` / 裸 `errorDetail` | 源码层断言：`ReactionExecutionPortV1` 的签名里这四个标识符计数为 0 |
| AC-2 | 四个执行方法全必选，optional 方法数为 0 | 类型层 + 源码层断言；`inspectHumanReview` 不适用时返回 `not-applicable` |
| AC-3 | DE claim CAS 与 TE admission 登记在同一个事务里 | 双引擎用例：admission 行与 round 的 claim epoch 要么都在、要么都不在 |
| AC-4 | 同一个 operation 重放返回同一个 `executionRef`，不重复建任务 | 双引擎用例：连调两次 launch 同一 operation，任务数为 1 |
| AC-5 | daemon 在 launch 途中重启后，该 round 只有一个执行 | `rfc294-e9c-…-crash-window` 的回归锁迁到新合同上仍绿 |
| AC-6 | DE↔TE 双向 import 归零 | 账本：`digital-employee` ↔ `task-execution` 之间的 exact 边只剩 `required-implementation` 角色 |
| AC-7 | `execution-launch` outbox 类退役，其余两类不受影响 | 源码层：`kind` 枚举不再含 `execution-launch`；`platform-work-item-execute` / `invocation-create` 用例原样绿 |
| AC-8 | 重试预算 / 退避 / 场景切换（same-scene / fresh-scene）逐字保留 | 现有用例不改断言即绿；新增一条对拍「退避序列与改造前逐值相同」 |
| AC-9 | retry 反馈是 content-addressed 的，同样的内容只存一份 | 双引擎用例：同 digest 重复写入不新增行 |
| AC-10 | C1 的五条裁剪规则各有正向用例 | 每条规则一个用例，R3/R4 各带一个「不该被裁掉的内容仍在」的反例 |
| AC-11 | 人审闸门在两个引擎上给出相同状态 | 双引擎对拍（沿用 `rfc359-w12-digital-employee-human-review-parity` 的形态） |
| AC-12 | 案例状态机 / metering / 工作区策略行为不变 | 既有 DE 用例全绿，且不修改其断言 |

## 7. 影响面与风险

- **schema**：新增 1 张 TE 表（admission 日志）+ `employee_reaction_rounds` 加列（claim epoch
  与调度列）+ 1 张 DE 表（retry feedback）。均为 expand-only，无回填、无 downgrade。
- **最大风险**：退役 `execution-launch` 意味着**调度路径换人**。缓解：退避 / 预算 / dedupe
  逐项对拍（AC-8），且切换只换装配绑定、不并存双 writer。
- **在途数据**：切换时可能存在 `state='pending'/'claimed'` 的 `execution-launch` 行。迁移把它们
  转换成 round 上的调度列（逐行等价映射），不丢在途重试。
