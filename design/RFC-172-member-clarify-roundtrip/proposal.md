# RFC-172 — 工作组成员人类反问答案回流（shardKey 隔离）

状态：**Draft**（待设计门 → 用户批准 → 实现）
立项日期：2026-07-13
承接：RFC-164 工作组 · 事故 task `01KXBATKFJ73MDYNM6YN2DMA29` 修复链（commits `6b19a68d` → `35312437` → `7b2cd751` → `8dddc1e8`）

## 背景

RFC-164 工作组任务失败排查（事故 `01KXBATKFJ73MDYNM6YN2DMA29`：leader 反问缺 JSON 格式 →
`clarify-questions-malformed` → 零重试秒挂）的修复过程中，把「人类反问（`<workflow-clarify>` 问人）」
**端到端接通到了 leader**：leader 拿到合法 JSON 格式（`renderWgProtocolBlock`）、答案在 clarify-answer
续跑里回流（`runHostNode` 调 `buildClarifyQueueContext` 注入 `## Clarify Q&A`）、畸形则重试而非致命。

但 **member（工作组成员/worker/fc_member）的人类反问被有意关闭**了，原因是一个共享机制缺口：

- 所有 member 指派都跑在**同一个 `__wg_member__` host 节点**上，仅靠 `node_runs.shard_key`（= assignment id）区分；
- 而 clarify 队列选取器 `selectAgentQueue`（`services/clarifyQueue.ts`）**只按 `consumerNodeId` 选取 + 老化，完全不看 shardKey**。

后果（Codex 复审第 2、3 轮实锤）：若给 member 注入回流，
1. **跨指派串扰**：member A、B 都问时，A 的已答 `## Clarify Q&A` 会被注入 B 的 run；
2. **误老化**：B 的产出会把 A 的队列判为已消费；
3. **绑定悬挂**：跳过注入又会让 `buildClarifyQueueContext` 负责的 `trigger_run_id` 绑定不发生，问题在
   `resolveDispatchedEntryHandler` 里**永远卡 `processing`**。

因此当前实现按「在支持前先阻止」收敛：`renderWgProtocolBlock` 只邀请 leader 反问；`runHostNode` 对非
leader 的 `<workflow-clarify>` 直接拒绝（`clarify-not-supported`，不建 session）；member 阻塞时按 worker
协议 message 给 leader 升级。**本 RFC 的目标就是补齐 shardKey 隔离，把 member 的人类反问也真正打通。**

## 目标

- member（leader_worker 的 worker、free_collab 的 fc_member）可**自愿**向人类发起 `<workflow-clarify>`；
- 人类答复**只回流到发起该反问的那一个 member 指派**（按 shardKey 精确定位），并发指派之间零串扰；
- 队列的**选取 / 绑定（`trigger_run_id`）/ 派生老化**三者全部按 shardKey 隔离，不再有悬挂 `processing`；
- 恢复 member 的 clarify 邀请与格式，撤掉 `runHostNode` 的临时拒绝守卫；
- **不回归** leader 反问（单例、shardKey=null，现已可用）与普通（非工作组）节点的 clarify 行为。

## 非目标

- 不改变 leader 反问语义（已端到端可用）。
- 不重写 clarify 协议 / 端口契约；仅给现有队列机制补 shardKey 维度。
- 不在本 RFC 处理 host clarify 的 `iterationIndex` 硬编码 0 多轮问题（见 design §附注，另评估）。

## 用户故事

1. 一个工作组里 leader 把「实现登录页」派给 worker A、把「实现结算页」派给 worker B，二者并行。A 执行时
   发现「验证码渠道用短信还是邮箱」只有人能定 → A 发 `<workflow-clarify>` 问人 → 任务挂起等人 → 人回答
   「短信」→ A 的续跑 prompt 里出现 `## Clarify Q&A`（**只有 A 自己的那条**）→ A 据此完成并回报。
2. 同一时刻 B 也问了「结算币种」→ 人回答「CNY」→ B 只看到 B 自己的答案，**绝不会**串到 A 的答案，A 的
   产出也不会把 B 的待答问题误判为已消费。

## 验收标准

- 并发两 member 各自发起反问、各自被回答后：每个 member 的续跑 prompt 只含**自己 shardKey** 的 `## Clarify Q&A`；
- 每条 member 反问的 `task_questions.trigger_run_id` 正确绑定到**该 member 的** clarify-answer 续跑，无永久 `processing`；
- member 产出只老化**自己 shardKey** 的队列条目，不影响 sibling 指派；
- leader 反问与普通节点 clarify 的既有行为与 golden-lock 测试**全绿不变**；
- `renderWgProtocolBlock` 对 worker/fc_member 恢复邀请 + 格式；`runHostNode` 的 `clarify-not-supported` 临时拒绝被移除。
