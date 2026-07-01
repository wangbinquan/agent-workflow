# RFC-132 产品提案：统一「任务级问题队列」——单一平铺模型收编所有 clarify 注入路径

## 背景

反问（clarify）问题注入 agent prompt 的逻辑，目前**散在 4 条选路、多套判据里**，是历史累积的结果：

- **注入器 1** `buildClarifyNodeQueueContext`（self/questioner，deferred 逐题）
- **注入器 2** `buildNodeQueueExternalFeedback`（designer，deferred 逐题）——产出 `## External Feedback` 块
- **注入器 3** `buildPromptContext`（non-deferred 整轮）——self/questioner
- **第 4 路** `buildExternalFeedbackContext` 内联（designer non-deferred graph）

它们各自 fork 了「选问题 + 判老化 + 渲染」逻辑，且并存**两套正交老化模型**：
- deferred = 派生式 `isTargetNodeConsumed`（RFC-131，读 run 状态派生）
- non-deferred = `consumed_by_*` 消费戳（RFC-070，runner done 时落库）

外加**轮次概念**（`### Round N` + 历史轮 read-only + 当前轮 sibling scope + per-round directive + round_generation）、**quick-channel 即时注入**（RFC-125，非 deferred 答完立即整轮注入、跳过下发）、**`deferredQuestionDispatch` flag**（分流两路径）。

**问题**：同一件事（把已答问题喂给 agent）有 3+ 份实现 + 2 套判据 + 2 套渲染块 + 轮次分组。fork 之间已经漂移出真 bug（RFC-131 验收4：review-reject 老化在派生判据存活、但当时若有第二套判据就不一致）。心智模型分裂——理解「一个问题什么时候进 agent、什么时候消失」要读 4 个函数。RFC-131 的 design §3 本想收编成统一 `buildClarifyQueueContext`，但未做（高风险纯重构，留作独立 RFC，即本 RFC）。

## 目标

把**所有** clarify 注入收敛到**一个统一、平铺的模型**，不残留任何重复/旧逻辑。统一模型（用户 2026-07-01 拍板）：

1. **两级队列**：每个 agent 一个问题队列；整个任务一个公共问题队列。
2. **提问入任务队列**：agent 提出的所有问题先进任务的公共队列。
3. **下发进 agent 队列**：一个问题被**下发**给某 agent 时，才进入该 agent 的队列（下发 = 设置节点反问状态 + 问题进队）。
4. **完成即老化**：agent 一次运行 `done+output`（正常输出走完）→ **老化其队列里所有问题**，等待新问题入队（派生式，读 run 状态）。
5. **运行即注入**：每次 agent 运行，把它队列里**已答且未老化**的问题**平铺**进 prompt。
6. **平铺对等**：所有问题彼此对等——**无轮次概念**，无「第几轮」、无历史轮 vs 当前轮、无 sibling scope。
7. **单一渲染块**：self/questioner/designer 所有问题用**同一个** prompt 块（不再有独立的 `## External Feedback`）。
8. **节点反问状态**：`continue`（继续问）/ `stop`（出结果）是 agent 的**节点反问状态**，在「下发」这一步设置（取代 per-round directive）。

## 非目标

- **不改 agent 怎么提问**（`<workflow-clarify>` envelope 协议、mandatory ask-back 机制不变）。
- **不改 review / prior-output**（RFC-119 行为保持）。**借壳改派勘误（research 揪出：§非目标原判「借壳保持」有误）**：自动下发删 immediate mint，顺带把 self/questioner 改派从 borrow（home 跑 X 脑）**统一为 T4 move 语义**（X 跑自己）——**行为变更**（immediate 账本借壳分支死；dispatched 两账本 RFC-131 T4 已去借壳）。`resolveBorrowForNode`/`buildBorrowedAgent` 回落 null 成死代码，RFC-132 **不主动删**（留后续 RFC、保窄边界）。见 design §6。
- **不改 RFC-099 归属隔离**（问题渲染仍零 attribution）。
- **不引入新的 clarify 能力**——纯粹是把现有行为收敛到单一模型。

## 用户故事

- 作为平台开发者，我读一个函数就能理解「问题何时进 agent、何时消失、agent 看到什么」，而不用在 4 个 fork + 2 套判据间跳转。
- 作为 agent 编排者，非 deferred 任务的自问自答**行为不变**（答完自动继续）——底层「答完自动下发」，UX 无感。
- 作为审阅者，agent prompt 里的反问上下文是一个平铺的「已答问题清单」，不再有让人困惑的「Round 1 / Round 2 / 历史轮」分层。
- 作为维护者，将来改注入逻辑改一处即可，不会再因 fork 漂移引入 RFC-131 验收4 那类判据不一致 bug。

## 验收标准

1. **单一注入器**：`buildClarifyQueueContext` 一个函数覆盖 self/questioner/designer；`buildClarifyNodeQueueContext` / `buildNodeQueueExternalFeedback` / `buildPromptContext` / `buildExternalFeedbackContext` 的 clarify 注入职责全部收敛（源码不再有平行 fork）。
2. **单一老化判据**：全部走派生式 `isTargetNodeConsumed`；`consumed_by_*` 戳（RFC-070 `markClarifyRoundsConsumedBy` + 相关列）**删除**（forward-only，用户拍板，见 design §9 / plan T10）。
3. **单一渲染块**：designer 不再单独 `## External Feedback`；所有问题用同一平铺块。
4. **平铺无轮次**：渲染无 `### Round N` / 历史轮 / sibling scope；`clarify_rounds.directive`、`round_generation` 等轮次态废弃或降级。
5. **单一路径**：`deferredQuestionDispatch` flag **删列**（所有任务走统一模型）；quick-channel 即时注入收敛为「答完自动下发」。
6. **节点反问状态**：`continue/stop` 由「下发」设置到 `task_node_clarify_directives`；无 per-round directive。
7. **行为等价**（除有意变更）：多轮丢历史、老化、review-reject 老化、prior-output——RFC-119/131 的行为在新模型下**逐一保持**（有回归测试佐证）。**有意变更三处**：① prompt 反问块「轮次分组」→「平铺清单」；② 非 deferred 答完「即时注入」→「自动下发后注入」（用户等价）；③ **self/questioner 改派 borrow→move**（统一 T4 语义，`rfc127-self-questioner-borrow` 测试改 move 语义）。
8. **迁移**：升级窗口的在飞任务（deferred + non-deferred）平滑迁移到统一模型，不丢已答问题、不错误重问；废弃列 **forward-only 删除**（drop-column migration 排最后 PR、删前确认无 reader、不可回退）。
9. **门槛**：typecheck×3 + 全量 backend test + format + 单二进制 smoke + CI 全绿；Codex adversarial gate（broker 恢复后）。

## 与既有 RFC 的关系

- **RFC-131**（任务级队列 + 派生老化）：本 RFC 是其 design §3「统一注入器」的兑现 + 把派生老化推广为**唯一**判据。
- **RFC-125**（quick-channel 即时下发）：其「即时」语义收敛为「自动下发」，双路径合一。
- **RFC-070**（consumed_by 消费戳）：其戳老化被派生老化取代、废弃。
- **RFC-119（prior-output）/ RFC-099（归属隔离）**：行为保持，本 RFC 不动。
- **RFC-127 借壳 / RFC-131 T4 去借壳**：本 RFC 删 immediate mint → 借壳最后一条活路径（immediate 账本）也去借壳，self/questioner 改派统一为 T4 move 语义（borrow→move）。**事实上完成 RFC-131 T4 对 immediate 路径的收尾**——RFC-131 只对 dispatched 路径去借壳、故意保留 non-deferred immediate 借壳并行路径，本 RFC 删这条并行路径。

> 详见 `design.md`（技术设计：统一注入器契约、数据模型迁移、平铺渲染、单一派生判据、节点反问状态、golden-lock 处理、失败模式、测试策略）与 `plan.md`（任务分解与 PR 拆分）。
