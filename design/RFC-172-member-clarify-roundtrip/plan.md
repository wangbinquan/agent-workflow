# RFC-172 任务分解 — 工作组成员人类反问答案回流（shardKey 隔离）

状态：**Draft**。依赖：无硬依赖；不得回归普通节点 clarify 与 leader 反问。
承接实现前置：本 RFC 需先走**设计门（Codex）→ 用户批准**，再进实现（遵 CLAUDE.md RFC 流程）。

## 子任务

### RFC-172-T1 — shardKey 归属查证（裁决点，先做）
- 查证 `task_questions` 能否经 `origin_node_run_id → clarify_rounds.asking_shard_key`（或 `node_runs.shard_key`）
  **无损推导**每条目所属 shard；若能 → design §2.1 方案 A（零 migration）；若有语义空洞 → 方案 B（task_questions 增 `shard_key` 列 + migration）。
- 顺带查证 **普通 agent-multi 分片 clarify 是否也串扰**（schema 注释称按 shard 分 session，但 selectAgentQueue 选取无 shardKey）。若是，本 RFC 范围升级为「修一个先于工作组的既有缺陷」，并补普通 agent-multi 的隔离测试。
- 产出：一页结论（方案 A/B 定夺 + 普通 agent-multi 是否受累 + manual 条目 §15 shard 语义）。

### RFC-172-T2 — selectAgentQueue 增 shardKey 隔离（核心）
- `selectAgentQueue` / `buildClarifyQueueContext` 入口加**可选** `shardKey`；`undefined` 完全复现现行为。
- 选取过滤（按 T1 结论走方案 A join 或方案 B 列）、老化窗口 `sameNode` 加 shardKey、绑定随选取收窄。
- 依赖：T1。

### RFC-172-T3 — runHostNode / member 路径接线
- `runHostNode`：`clarifyContext` 注入改为对**所有** host run 调 `buildClarifyQueueContext({ ..., shardKey: <本 run shard_key> })`（leader=null、member=assignment id）；移除 `req.nodeId !== WG_LEADER_NODE_ID` 的 `clarify-not-supported` 拒绝分支。
- 依赖：T2。

### RFC-172-T4 — 恢复 member clarify 邀请 + 格式
- `renderWgProtocolBlock`：worker / fc_member 恢复 `<workflow-clarify>` 邀请 + JSON 格式（复用/抽出 `LEADER_CLARIFY_BLOCK` 为通用块）。更新/回滚 RFC-164 期间「leader-only」的相关注释与测试断言。
- 依赖：T3（避免「邀请了但 runHostNode 仍拒绝」的中间窗口——同 PR 内落）。

### RFC-172-T5 — 测试
- 纯数据预言：`selectAgentQueue` 跨 shardKey 选取隔离 / 老化隔离 / 绑定隔离（无悬挂 `processing`）。
- golden-lock 回归：`shardKey===undefined` 路径既有断言全绿（`rfc132-select-agent-queue` 等）。
- 引擎级：并发两 member 各问各答、续跑各自只见己方 `## Clarify Q&A`。
- 撤守卫回归：worker 协议块含 `<workflow-clarify>`、`runHostNode` 不含 `clarify-not-supported`。
- （若 T1 判普通 agent-multi 亦受累）补普通分片节点 clarify 隔离测试。
- 依赖：T2–T4。

## PR 拆分建议
- 若 T1 判**方案 A（零 migration）**：单 PR（T2–T5 一体，含撤守卫），T1 结论写进 PR 描述。
- 若 T1 判**方案 B（需 migration）**或普通 agent-multi 也要修：拆两 PR —— PR-1（T1 结论 + migration + selectAgentQueue 隔离 + 纯数据测试），PR-2（member 接线 + 撤守卫 + 引擎测试）。

## 验收清单
- [ ] 并发两 member 各自反问各自被答：续跑 prompt 各自只含自身 shardKey 的 `## Clarify Q&A`。
- [ ] 每条 member 反问 `trigger_run_id` 正确绑定，无永久 `processing`。
- [ ] member 产出只老化自身 shard 队列，不影响 sibling。
- [ ] leader 反问 + 普通节点 clarify 既有行为与 golden-lock 全绿不变。
- [ ] worker/fc_member 恢复 clarify 邀请 + 格式；`clarify-not-supported` 临时拒绝移除。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿 + 单二进制 smoke + CI 绿。
