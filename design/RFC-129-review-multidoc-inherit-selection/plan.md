# RFC-129 Plan —— 任务分解

> 读前置：`proposal.md` → `design.md`。单 PR（沿用 RFC-079「单 PR」惯例）；子任务编号 `RFC-129-T*`。
> commit 前缀：`feat(rfc): RFC-129 多文档评审跨轮继承逐文档标记`。

## 依赖顺序

```
T1 (纯 oracle) ──┐
T2 (schema/列)  ──┼──> T3 (后端注入) ──> T4 (读路径) ──> T5 (前端徽标)
                          └──> T6 (测试) 贯穿各层
                                   └──> T7 (journal bump)
```

T1 / T2 无依赖可并行起手；T3 依赖 T1+T2；T4 依赖 T3；T5 依赖 T4；T6 随每层落测试；T7 收尾。

---

## 子任务

### RFC-129-T1 —— 纯 oracle（`shared/reviewMultiDoc.ts`）
- 加 `PriorRoundMember` / `NewRoundItem` / `InheritedSelection` 类型。
- 加 `buildPriorSelectionLookup(prior)`（唯一 path 收 byPath、重复排除、index 全收）。
- 加 `inheritSelection(item, lookup)`（路径优先→index 退回→不继承；stale = 内容变 || 上一轮 stale）。
- **测试**：`shared/tests/reviewMultiDoc.inherit.test.ts`（design §7 全 case）。
- 验收：`bun test` 纯 oracle 全绿；无 IO 导入（保持 dependency-free 惯例）。

### RFC-129-T2 —— 数据层（列 + schema）
- migration `0069_rfc129_review_selection_stale.sql`：`ALTER TABLE doc_versions ADD COLUMN selection_stale integer;`（单 statement；SQL 层裸 integer 存 0/1/NULL）。
- migration `0070_rfc129_review_round_generation.sql`：`ALTER TABLE doc_versions ADD COLUMN round_generation integer;`（Codex 实现 gate P2 拆分——round_generation 单独立、不改已应用的 0069）。
- `schema.ts`：`docVersions` 加 `selectionStale: integer('selection_stale', { mode: 'boolean' })`（**nullable 布尔列**，本仓惯例；紧随 itemPath；Codex P2b）。
- `shared/schemas/review.ts`：`DocVersionSchema` 加 `selectionStale: z.boolean().nullable().optional()`；
  `ReviewDocumentSummarySchema` 加 `stale: z.boolean().optional()`。
- 更新 drizzle meta `_journal.json` / snapshot（`bun run db:generate` 或手写 + breakpoint 规则核对——本 migration
  单 statement 无需 breakpoint）。
- 验收：typecheck 绿；migration 应用不报错。

### RFC-129-T3 —— 后端注入（`services/review.ts`）
- 新 helper `loadPriorRoundMembers(db, appHome, {taskId, reviewNodeId, iteration})`（**Codex P1/P2a**）：
  join `node_runs` 过滤同 iteration、`item_index` 非空、跨 node_run（by `reviewNodeId`）、**不排除当前 run**；
  `R* = max(reviewIteration)` 锁「紧邻上一轮」整组、同 R* 多代取最新（id/createdAt DESC）、读 bodyPath 正文 →
  `PriorRoundMember[]`（`selectionStale` 用 `row.selectionStale ?? false` 归一，NULL=未 stale；Codex 确认 gate P2）。
  **不用「每键 max versionIndex」**（会串文档 / 跨 US-2 run 重置）。
- `dispatchReviewNode` mint 循环（:609-645）：mint 前建 lookup；:642 `selection:'unselected'` →
  `inheritSelection(...)` 结果 + 透传 `selectionStale`。
- `CreateDocVersionArgs` 加 `selectionStale?: boolean`；insert 增 `selectionStale: args.selectionStale ?? null`。
- `setDocumentSelection`（:1883）：`.set({ selection, selectionStale: false })`。
- `rowToDocVersion`：映射 `selectionStale: row.selectionStale ?? null`（列 `{ mode: 'boolean' }` 已是 `boolean | null`，不做数值转换）。
- **测试**：`backend/tests/review-multidoc-inherit.test.ts`（iterate / reject / US-2 跨 run / 人工重标清 stale /
  单文档 golden / loop 隔离）。
- 验收：backend 全量 pass，单文档 golden 不变。

### RFC-129-T4 —— 读路径（`getReviewDetail`）
- `review.ts:990` `documents.push` 增 `stale: m.selectionStale === true`。
- 测试并入 T3 backend（detail.documents[i].stale 断言）。

### RFC-129-T5 —— 前端徽标（`MultiDocReviewView.tsx` + i18n）
- 左栏行：`d.stale` → `<StatusChip kind="warn" size="sm" data-testid="multidoc-stale-badge">`。
- 可选：per-doc 动作条 `current.stale` muted 提示。
- i18n：`reviews.multiDoc.changed` / `changedHint`（zh-CN + en）。
- **测试**：`frontend/tests/review-multidoc-stale-badge.test.tsx`（vitest）+ 源码 testid/StatusChip 断言。
- 验收：前端 vitest 绿；明暗主题徽标视觉自查（per memory frontend-visual-verify）。

### RFC-129-T6 —— 测试（贯穿，见各层）
- 已分述于 T1 / T3 / T5。确保正向 + 边界（改序 / 内联 / 重复 path / 空 body）+ 回归（单文档 golden）全覆盖。

### RFC-129-T7 —— journal 计数回归锁
- `upgrade-rolling.test.ts`：HEAD journal「N entries」**68 → 70**（0069+0070）（标题 + 断言 + 注释同步，per memory
  [reference_migration_bumps_journal_count_test]）。

---

## PR 拆分

**单 PR**（T1-T7 一起）。改动内聚（一个功能纵切）、无跨团队耦合、RFC-079 亦单 PR。

## 验收清单（交付门槛）

- [ ] proposal AC-1~AC-12 全部有对应测试（含 Codex P1 同-run 继承、P2a 紧邻上一轮）。
- [ ] 纯 oracle `reviewMultiDoc.inherit.test.ts` 全 case 绿。
- [ ] backend `review-multidoc-inherit.test.ts`：iterate / reject / US-2 / 重标清 stale / 单文档 golden / loop 隔离。
- [ ] frontend `review-multidoc-stale-badge.test.tsx` + 源码锚点。
- [ ] `upgrade-rolling.test.ts` journal 68→70（0069+0070）。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] 单二进制 smoke（per memory [reference_binary_build_module_cycle]，本 RFC 动 shared 导出，务必跑）。
- [ ] 明暗主题「已变更」徽标视觉自查。
- [ ] Codex 设计 gate（落档后、请求用户批准前）+ 实现 gate（代码后、宣告完成前）findings 全 fold。
- [ ] push origin/main 后查 GitHub Actions（per memory [feedback_post_commit_ci_check]）。

## 更新索引

- [ ] `design/plan.md` RFC 索引表加 RFC-129 行（状态 Draft→In Progress→Done）。
- [ ] `STATE.md` 顶部「进行中 RFC」加 RFC-129；完工后转 Done + 已完成表加行。
