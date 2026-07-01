# RFC-129 Proposal —— 多文档评审跨轮继承逐文档「接纳 / 不采纳」标记

> 状态：Draft
> 触发：2026-07-01 用户「在多文档评审的时候，如果上一轮已经标记了某个文档的接纳或者拒绝，这个标记要继承到下轮」
> 关联：扩展 [RFC-079 多文档评审](../RFC-079-review-multi-document/proposal.md)（逐篇采纳 + 三决策）

## 0. 一句话

多文档评审（RFC-079）每次 **iterate / reject** 重开新一轮时，上游整批重生、N 篇 `doc_version` 全部
被 mint 成 `selection='unselected'`（`review.ts:642` 硬编码）——**上一轮逐篇标好的「接纳 / 不采纳」全部清零、要
从头重标**。本 RFC 让新一轮**继承上一轮对应文档的标记**（路径优先匹配），并对「内容较你上次裁决时已变化」的
文档打**「已变更」**提示，避免把改动后没重看的内容直接批准。

## 1. 背景

RFC-079 把 review 节点扩展为多文档模式：上游端口是 `list<path<md>>`（或内联 `list<markdown>`）时，list 每一项
被归档成独立的 `doc_versions` 行，带三列多文档字段：

- `item_index`（0-based 篇序）
- `selection`（`unselected | accepted | not_accepted`，与轮级 `decision` 正交）
- `item_path`（worktree 相对路径；RFC-079 明确定义为**「稳定 id」**）

评审员逐篇标 `accepted / not_accepted`（`PATCH …/documents/:docVersionId/selection`），标满后做一次轮级决策：

- **approve**：采纳子集（`accepted` 篇按 item 序）写下游 `accepted` 端口。
- **iterate**：每篇评论回灌，上游**不回滚**重跑，`reviewIteration+1`，重开评审。
- **reject**：回退 `pre_snapshot` + 上游整批重生，`reviewIteration+1`，重开评审。

**`reviewIteration` 是轮次计数**。iterate / reject 决策后调度器重跑上游、`dispatchReviewNode` 再跑一遍，走
`review.ts:600-660` 的 mint 循环重建 N 篇 `doc_version`——**每篇一律 `selection: 'unselected'`（`review.ts:642`）**。

**痛点**：首用例是「测试点设计 → 生成**几十条**用例 → 逐篇评审采纳子集 → 下游」。评审员标完几十篇、iterate
一次去精修其中几篇，回来发现**几十篇的采纳标记全没了、要重标一遍**。上一轮的裁决劳动被整轮丢弃。

## 2. 目标

1. **跨轮继承逐篇 `selection`**：iterate / reject 重开的新一轮，每篇继承上一轮对应文档的 `accepted / not_accepted`
   （或 `unselected`），开局即带上一轮的裁决，不用从头重标。
2. **文档匹配 = 路径优先、退回位置**：`list<path<md>>` 模式按 `item_path` 匹配（上游即使增删 / 改序文档，路径
   仍能对上，最不会错标）；内联 `list<markdown>` 无路径时退回 `item_index`。
3. **内容变化安全 = 继承 + 标记「已变更」**：被继承且**内容较上次人工裁决时已变化**的文档，打「已变更」提示，
   提醒评审员重看；**不重置为未决、不阻塞 approve**（advisory-only）。
4. **覆盖 iterate 与 reject**（以及系统级 refresh / US-2 重开——三者共用同一 mint 注入点，天然一致）。
5. **单文档路径字节级零回归**：`item_index IS NULL` 的单文档行完全不受影响，新列恒 NULL。

## 3. 非目标

- **不改轮级 `decision` 语义**（approve / reject / iterate 三决策、乐观锁、回滚、评论回灌全不动）。
- **不做逐篇选择性重生**：上游仍**整批**重跑（本 RFC 继承的是「标记」，不是「跳过重生」；选择性重生是更大的
  上游改造，超出范围）。
- **「已变更」不阻塞 approve、不自动重置为未决**：用户在设计澄清时明确选「继承 + 标记」而非「变了就重置」。
  approve 仍只以「全部已裁决」为门槛（继承后往往开局即满足），「已变更」纯提示。
- **不跨 loop wrapper 迭代继承**：每个 workflow `iteration`（loop 的一趟）是独立评审上下文，继承只在**同一
  workflow iteration 内**的连续 review 轮之间生效。
- **不做逐篇内容编辑 / 人工新增文档**（延续 RFC-079 非目标）。
- **不改单文档 review**（本 RFC 只作用于多文档模式）。

## 4. 用户故事

1. 我在测试用例工作流里评审 30 篇用例，逐篇标了 26 篇采纳、4 篇不采纳。发现其中 3 篇需要 agent 再改，于是
   对这 3 篇写检视意见、点 **iterate**。
2. 上游重跑，重开新一轮。**新一轮开局，26 篇采纳、4 篇不采纳的标记都还在**（继承自上一轮），我不用重标。
3. 被 agent 改过的 3 篇（原先在那 4 篇不采纳里）显示**「已变更」**徽标——我点开重看，改好了就改标为采纳。
4. 那 27 篇没被改的用例内容逐字未变、无「已变更」标记，我扫一眼确认无误，直接 **approve**。采纳子集走向下游。
5. 换个场景：我 **reject** 整批（回退重生）。新一轮同样继承上一轮标记，但因整批内容都变了，**几乎每篇都带
   「已变更」**——提醒我这是全新一批、逐篇重看。

## 5. 验收标准（AC）

- **AC-1**：多文档 review 经 iterate 重开后，新一轮每篇 `doc_version` 的 `selection` 等于上一轮**匹配文档**的
  `selection`（含 `unselected`）；无匹配的新文档为 `unselected`。
- **AC-2**：匹配优先级 = 上一轮存在且**唯一**的 `item_path` → 命中该篇；否则退回同 `item_index`；再否则不继承。
- **AC-3**：内联 `list<markdown>`（无 item_path）经 iterate 后按 `item_index` 继承。
- **AC-4**：被继承的文档，若本轮归档正文与「上次人工裁决时的正文」不一致 → 该篇 `selection_stale=1`，detail
  返回 `stale=true`，前端左栏该行显示「已变更」徽标；内容逐字未变 → `stale=0`、无徽标。
- **AC-5**：「已变更」的连续传播：某篇上一轮已 stale 且评审员未重新裁决 → 继承到下一轮仍 stale（直到人工重标
  清除），即使下一轮内容未再变。
- **AC-6**：评审员对某篇重新 `PATCH selection`（人工裁决当前内容）→ 该篇 `selection_stale` 清 0、「已变更」消失。
- **AC-7**：**reject** 重开同样继承（AC-1~AC-6 对 reject 成立）。
- **AC-8**：approve 门槛不变——仍仅要求「全部已裁决」；继承使新一轮开局即可能满足；`stale` 不阻塞 approve。
- **AC-9**：**单文档 review 零回归**——`item_index IS NULL` 的行 `selection_stale` 恒 NULL，dispatch / decision /
  输出路径逐字不变。
- **AC-10**：继承不跨 workflow `iteration`（loop 每趟独立）。
- **AC-11**：只从**紧邻上一轮**继承——某文档在紧邻上一轮缺席（如 R1 有、R2 无、R3 又出现）→ R3 视其为新文档
  `unselected`，**不复活更早轮**的选择（Codex 设计 gate P2a）。
- **AC-12**：iterate/reject **复用同一 review node_run** 时上一轮成员就在该 run 上，继承照常生效（不因「同 run」
  被误排除；Codex 设计 gate P1）。

## 6. 影响面

- 数据：`doc_versions` 加 1 个 nullable 列 `selection_stale`（migration 0069，纯 ADD COLUMN）。
- 后端：`services/review.ts` mint 循环注入继承 + `setDocumentSelection` 清 stale；`shared/reviewMultiDoc.ts` 加纯
  匹配 / 继承 oracle；`shared/schemas/review.ts` 扩 `DocVersionSchema` / `ReviewDocumentSummarySchema`。
- 前端：`MultiDocReviewView.tsx` 左栏「已变更」徽标 + i18n。
- 单 PR（数据 + 纯 oracle + 后端注入 + 读路径 + 前端 + 测试）。

详见 `design.md` / `plan.md`。
