# RFC-172 任务分解 — 工作组成员人类反问答案回流（shardKey 隔离）

状态：**Draft**。依赖：无硬依赖；不得回归普通节点 clarify 与 leader 反问。
承接实现前置：本 RFC 需先走**设计门（Codex）→ 用户批准**，再进实现（遵 CLAUDE.md RFC 流程）。

## 子任务

### RFC-172-T1 — shardKey 归属查证 ✅ 已查证定案（进设计门前完成）
- **方案 A（零 migration）确定**：`task_questions.origin_node_run_id → clarify_rounds.asking_shard_key` 的 join 与 shard **1:1、无损**（createClarifySession 每 shard 铸独立 clarify node_run，`findClarifyNodeRunForShard` clarify.ts:460-472），且 `selectAgentQueue` 现在就已取该 round 行（clarifyQueue.ts:150-157）→ 加过滤零新增查询。shardKey 做成**通用可选参数**（非 workgroup 专用）。
- **普通 agent-multi 不受累**：agent-multi 已被 RFC-060 删除，后继 wrapper-fanout 分片不 wire clarify 通道（scheduler.ts:4486-4490 v1 无 clarify、PR-D2/D.T5 延期），普通路径无可复现串扰 → RFC-172 **不**顺带修普通 bug（但通用参数让延期的 fanout per-shard clarify 将来免费继承）。
- **manual §15 收口**：manual 可指派 `__wg_member__` 但无 shard 身份、不产生 clarify 答案串扰 → 免 clarify shard 过滤（广播）+ 老化仍逐 shard；逐成员定向 manual 非本 RFC 需求（否则才上方案 B）。
- 详见 design §2.1 / §3。

### RFC-172-T2 — selectAgentQueue 增通用可选 shardKey 隔离（核心）
- `selectAgentQueue` / `buildClarifyQueueContext` 入口加**可选** `shardKey?: string | null`；`undefined` 完全复现现行为（普通节点/leader 单一 null 身份零影响）。
- 选取过滤：传值时 clarify 候选按已 join 的 `clarify_rounds.asking_shard_key == shardKey` 收窄（方案 A，零新增查询）；manual 免过滤。
- 老化窗口：传值时 `sameNode` 加 `node_runs.shard_key == shardKey`（member run 恒非 null，无 IS NULL 坑）。
- 绑定随选取收窄。依赖：无（T1 已定案）。

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
- 依赖：T2–T4。（普通分片 clarify 路径当前不可达——T1b——故无需普通 agent-multi 串扰测试；通用可选参数即为将来 fanout per-shard clarify 预留。）

## PR 拆分建议
T1 已判**方案 A（零 migration）**且普通路径不受累 → **单 PR**（T2–T5 一体，含撤守卫），T1 结论写进 PR 描述。无 migration、无跨批不可分割约束。

## 验收清单
- [ ] 并发两 member 各自反问各自被答：续跑 prompt 各自只含自身 shardKey 的 `## Clarify Q&A`。
- [ ] 每条 member 反问 `trigger_run_id` 正确绑定，无永久 `processing`。
- [ ] member 产出只老化自身 shard 队列，不影响 sibling。
- [ ] leader 反问 + 普通节点 clarify 既有行为与 golden-lock 全绿不变。
- [ ] worker/fc_member 恢复 clarify 邀请 + 格式；`clarify-not-supported` 临时拒绝移除。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿 + 单二进制 smoke + CI 绿。
