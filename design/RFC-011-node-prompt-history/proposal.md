# RFC-011 — 节点 Prompt 历史可见性

状态：Draft
作者：（待用户批准后填）
日期：2026-05-16

---

## 1. 背景

当前 Task 详情页 (`packages/frontend/src/routes/tasks.detail.tsx`) 用 `latestRunByNode`
（startedAt 单调最新）从 `runs[]` 中挑出一个 `node_run`，喂给
`NodeDetailDrawer`。drawer 的 **Prompt** tab
(`components/NodeDetailDrawer.tsx:205-211`) 渲染 `run.promptText` ——
runner 在每次 `runNode()` 开头写入的「实际发给 opencode 的最终用户 prompt」
（已经把 `{{port}}` 模板插值好了，见 `runner.ts:117-131`）。

这一套对「单次顺利执行」是工作的，但下列三种合法场景下用户看不到自己真正想看的 prompt：

### 1.1 Review iterate / reject 之后丢失原 prompt

`review.ts:1039-1065` 在用户点 reject 或 iterate 后，把上游节点的 `node_run`
**就地** `status: 'pending'`，scheduler 再跑时 `runner.ts:127` 直接覆写
`promptText`。第一轮（被拒绝的那次）发出去的 prompt 永久丢失，
也就无法对比"我加了 review 意见之后 prompt 长什么样 vs 之前长什么样"。

### 1.2 Multi-process 父节点没有 prompt

multi-process agent 节点的父行从不走 `runNode()`（`scheduler.ts:765` 是直接
插入的 `pending` 父行），`promptText` 永远 NULL。每个 shard 子行
（`parentNodeRunId !== null`）才有 prompt。canvas 点父节点时 drawer 只看见
父行 NULL 的 promptText，前端给出 "promptPending" muted 文案，用户实际
看不到任何一片真实发出去的 prompt。

### 1.3 Retry 历史能被查到但藏得深

scheduler 在 retry 路径上每次 mint 新 `node_run`（`retry_index+1`，
`scheduler.ts:424` & `:448`），所以历史 prompt 物理上还在；但 canvas 永远只
选最新那条，drawer 的 Prompt tab 上没有切换器。Stats tab 底部的 retries
列表 (`NodeDetailDrawer.tsx:285-310`) 能跳到旧 attempt，但
(a) 默认 tab 不是 Stats，(b) 列表只显示有 retry 时才出现，
(c) 跳过去后整个 drawer 都换上下文，状态切换不可逆。

---

## 2. 目标 / 非目标

### 2.1 目标

- T-1：在 Task 详情页点任意 workflow 节点，drawer Prompt tab 顶部出现
  attempts 切换器，列出该 nodeId 在本 task 内**所有历史 `node_run`** 的
  prompt（含 retries、iterations、multi-process shards、review iterate
  重跑），按时间顺序倒序排列；默认选中"最近一次有 promptText 的 attempt"。
- T-2：Review reject / iterate 不再覆写上游 `node_run.promptText`——通过
  在重新执行时 mint 新 `node_run` 行实现历史前向保留。
- T-3：对于天然没有 opencode prompt 的节点种类（input / output / git
  wrapper / loop wrapper / review），Prompt tab 显示一行明确的 N/A 文案，
  而不是误导性的 "promptPending"。

### 2.2 非目标

- 不改 fan-out 聚合 / shard 切分语义；不改 retry 状态机；不改 review 决策状态机
  的对外契约（pending / approved / rejected / iterated 仍是同一组）。
- 不为 prompt 历史新建独立持久化层 / 不引入新表 ——
  完全复用已有 `node_runs` + 已有 `/api/tasks/:id/node-runs` 接口。
- 不引入 prompt diff / 高亮对比视图——只列 + 切换 + 显示，对比留给 §10 后续 follow-up。
- 不回填历史：本 RFC 落地前已经被 review iterate 覆写过的 task，
  老 prompt 不可恢复（数据库里就没了）。仅"前向"保留。

---

## 3. 用户故事

- **作为审稿后想知道改善前后 prompt 长什么样的用户**：我对一个 Markdown
  评审节点点了 iterate 后，上游 writer 节点被重跑。我点开 writer 节点，
  drawer Prompt tab 顶部切换器列出 "iter=0 retry=0 done · 14:02:11" 与
  "iter=0 retry=1 done · 14:08:30" 两条；切到第一条看到那时候发的 prompt，
  切回第二条看到包含 `{{__review_comments__}}` 解析后内容的 prompt。
- **作为 multi-process agent 用户**：我点 agent-multi 节点（父行），Prompt
  tab 切换器列出每个 shard（按 shardKey 字典序），父行那条标为
  "fan-out parent (no prompt — pick a shard)"；点任意 shard 看见 shard
  级别真实发给 opencode 的 prompt。
- **作为 retry 后排查的用户**：我把失败 agent 节点 retry 了 3 次，drawer
  Prompt tab 切换器列出 4 条 attempts，方便对比每次 prompt 是否一致 ——
  无需进 Stats tab。

---

## 4. 验收标准

- A-1：在 happy-path single-agent task 上，drawer Prompt tab 顶部切换器
  显示 1 条 attempt，仍然渲染当前 prompt。零回归。
- A-2：构造一个 agent-single 节点 → review 节点的两节点 workflow，
  review iterate 后再观察上游 agent 节点：drawer Prompt tab 切换器列出 2
  条 attempt，**两条都能看到当时的实际 prompt 内容**（断言
  `latest.promptText !== previous.promptText` 当 review_comments 注入差异时）。
- A-3：multi-process 父节点 drawer Prompt tab 列出 N+1 条 attempts
  （父 + N 个 shard），父条目标记 "fan-out parent (no prompt)"，shard 条
  目可读 prompt。
- A-4：input / output / git-wrapper / loop-wrapper / review 节点 drawer
  Prompt tab 显示明确的 N/A 文案（i18n key），不显示空白 / "promptPending"。
- A-5：原 retries history（Stats tab 底部）保持工作 ——
  本 RFC 不删除该入口，只是补充 Prompt tab 的主入口。
- A-6：`bun run typecheck && bun run test && bun run format:check` 全绿；
  CI build-binary + Playwright e2e 全绿。

---

## 5. 关联文档

- [RFC-005 设计文档人工评审节点](../RFC-005-human-review/proposal.md) §A2
  上游节点回滚 + 重跑的状态机由本 RFC 调整为"mint 新行"。
- [`design/design.md` §7.4 review 状态机](../design.md) 会被本 RFC 同步增补
  iterate / reject 上游处理改 mint-new-run 的说明。
- [`design/design.md` §5 节点 / 任务模型](../design.md) `node_runs` 行语义
  增补：同一 (taskId, nodeId, iteration) 下可有多条 retryIndex 行，含
  review iterate 触发的重跑行。
