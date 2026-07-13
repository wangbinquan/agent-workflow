# RFC-172 设计 — 工作组成员人类反问答案回流（shardKey 隔离）

## 1. 现状与缺口（代码事实）

### 1.1 已有的 shardKey 基础设施（关键：基本齐备）
- `node_runs.shard_key`（schema.ts:872）—— member host run 的 shardKey = assignment id；leader host run 为 `null`。
- `clarify_sessions.source_shard_key`（schema.ts:1359）+ 索引 `idx_clarify_sessions_node_shard (clarify_node_id, source_shard_key)`（:1387）。
- `clarify_rounds.asking_shard_key`（schema.ts:1476）。
- 注释 schema.ts:1342-1343 明述设计意图：**「agent-multi：每个 reaching shard 铸自己的 clarify_node_run + 自己的 clarify_session，按 `(clarify_node_id, source_shard_key)` 键」**。
- `createClarifySession`（services/clarify.ts）已把 `sourceShardKey` 落进 `clarify_sessions.source_shard_key`（:237）与 `clarify_rounds.asking_shard_key`（:214）；`runHostNode`（scheduler.ts）建 session 时传的 `sourceShardKey = currentRunRow?.shardKey`（member = assignment id）。

**结论：反问「问」的一侧已按 shardKey 分账。缺口只在「答案回流选取」一侧。**

### 1.2 缺口：`selectAgentQueue` 不看 shardKey
`services/clarifyQueue.ts` `selectAgentQueue`（:87-214）：
- **选取**（:94-109）：`task_questions WHERE taskId + effectiveTarget(override ?? default)==consumerNodeId + dispatchedAt NOT NULL`，再 `sealedAt!=null || sourceKind='manual'`。**无 shardKey 过滤** → member 节点返回**所有** member 指派的问题。
- **老化窗口**（:116-131）：`sameNode = node_runs WHERE nodeId==consumerNodeId AND iteration==iteration`。**无 shardKey 过滤** → 含所有 sibling 指派的 run，任一 sibling 的 output 都会经 `isTargetNodeConsumed` 老化本条目。
- **绑定**：`bindTriggerRun`（:216+）把 `task_questions.trigger_run_id = dispatchedRunId`，按选取结果绑 → 会把 A 的条目误绑到 B 的 run。

`buildClarifyQueueContext`（:296-327）是薄封装（选取 + 渲染 + 绑定），签名 `{db, definition, taskId, consumerNodeId, dispatchedRunId, iteration}`，其中 `definition`/`iteration` 是**保留位不读**。

### 1.3 当前临时收敛（本 RFC 要撤掉）
- `renderWgProtocolBlock`（services/workgroupContext.ts）：`<workflow-clarify>` 邀请 + 格式**只发 leader**。
- `runHostNode`（services/scheduler.ts）：`clarifyContext` 注入 `req.nodeId === WG_LEADER_NODE_ID` 才做；非 leader 的 `<workflow-clarify>` 在 `createClarifySession` **之前**直接 `return { status:'failed', errorMessage:'clarify-not-supported' }`。

## 2. 方案：给队列机制补 shardKey 维度

核心是让 `selectAgentQueue` 的**选取 + 老化 + 绑定**三者都能按「本次续跑 run 的 shardKey」收窄。task_questions 本身
是否需要新增 shardKey 列，取决于能否经现有关联（`origin_node_run_id` → `clarify_rounds.asking_shard_key`，
或 `node_runs.shard_key`）无损推导 —— 这是 T1 的首要裁决点。

### 2.1 selectAgentQueue 增 shardKey 隔离
- 入口新增**可选** `shardKey?: string | null`（`undefined` = 保持现状，普通节点零改动、golden-lock 不动）。`buildClarifyQueueContext` 从 `dispatchedRunId` 行读出 `shard_key` 后透传（leader 读到 `null`、member 读到 assignment id）。
- **选取过滤**：候选 `task_questions` 追加「该条目所属 shard == 目标 shardKey」。优先经关联无损推导：
  - 方案 A（首选，零 migration）：join `clarify_rounds` on `origin_node_run_id`，按 `asking_shard_key == shardKey` 过滤（manual 条目 §15 无 round，另议其 shard 归属）。
  - 方案 B（若 A 有语义空洞）：给 `task_questions` 增 `shard_key` 列 + 一支 migration，dispatch 铸行时从 clarify 会话带出。
- **老化窗口**：`sameNode` 追加 `AND node_runs.shard_key IS <shardKey>`（含 `null` 情形用 IS NULL）。
- **绑定**：`bindTriggerRun` 仍绑选取后的条目——选取一旦按 shardKey 收窄，绑定自然只落本 shard。

### 2.2 撤临时收敛、恢复 member 反问
- `renderWgProtocolBlock`：worker / fc_member 恢复 `<workflow-clarify>` 邀请 + 格式（复用现 `LEADER_CLARIFY_BLOCK`，改为「非 leader 也 push」或抽通用块）。free_collab 无 leader，成员即 fc_member，同样开放。
- `runHostNode`：移除 `req.nodeId !== WG_LEADER_NODE_ID` 的拒绝分支；`clarifyContext` 注入守卫从「仅 leader」改为「传入本 run shardKey 的 `buildClarifyQueueContext`」（leader 走 null shard，member 走自身 shard）。

## 3. 与现有模块耦合点 / 失败模式

- **`selectAgentQueue` 是共享 golden-lock 函数**（普通节点 + cross-clarify + designer 全走它）。改动必须以 `shardKey===undefined` 完全复现现行为（golden-lock 不改一行断言），仅 member 显式传值时启用新过滤。
- **潜在更广的既有 bug**：schema 注释称 agent-multi 也按 shard 分 session，但 `selectAgentQueue` 选取无 shardKey——**普通 agent-multi 节点的分片 clarify 是否也串扰？** T1 需查证；若是，本 RFC 顺带修一个先于工作组的既有缺陷（提升优先级）。
- **失败模式**：shardKey 不匹配 → 空队列 → member 续跑无答案（退化为「未回流」，不串扰、不悬挂）——安全降级。
- **manual 条目（§15）**的 shard 归属：无 clarify round，需明确其 target/shard 语义（可能维持 node 级、不参与 shard 过滤）。

## 4. 测试策略（design.md §测试策略，实现 PR 必跑绿）

- **纯数据预言（首选）**：seed「同 taskId、同 `__wg_member__`、两个不同 shardKey 各一条已答 clarify」，断言 `selectAgentQueue(consumerNodeId=__wg_member__, dispatchedRunId=<A 的续跑>, shardKey=A)` **只返回 A 的条目**；传 B 只返回 B 的。
- **老化隔离**：B 的 done+output run 不老化 A 的条目（跨 shard）。
- **绑定隔离**：绑定只落本 shard 的 `trigger_run_id`，无悬挂 `processing`。
- **golden-lock 回归**：`shardKey===undefined` 路径下 `rfc132-select-agent-queue` 等既有断言全绿不变。
- **引擎级**：并发两 member 各问各答，续跑 prompt 各自只含己方 `## Clarify Q&A`（可用 fake-hook 引擎 harness + 源码锁兜底）。
- **撤守卫回归**：`renderWgProtocolBlock('worker')` 恢复含 `<workflow-clarify>`；`runHostNode` 不再含 `clarify-not-supported`。

## 附注 — 正交既有缺陷（本 RFC 不修，另评估）
host clarify 的 `createClarifySession` 传 `iterationIndex: 0` 硬编码：同一 host + 同 shardKey 的**第二轮** clarify 会
复用/覆写首轮 clarify_node_run 的 questions（`findClarifyNodeRunForShard` 按 `(clarifyNodeId, shardKey, iterationIndex)`
幂等）。与本次 shardKey 回流正交，多代 host clarify 才触发，单代不受影响；若本 RFC 实现时顺手可解则一并，否则单列。
